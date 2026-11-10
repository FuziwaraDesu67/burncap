import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";

export type ApiFormat = "openai" | "anthropic";

export type RequestStatus =
  | "PASSED"
  | "SLIMMED"
  | "REROUTED"
  | "BLOCKED: LOOP"
  | "BLOCKED: BUDGET";

export interface BurnCapSettings {
  contextSlimmer: boolean;
  smartRouting: boolean;
  loopDetector: boolean;
  sessionBudgetUsd: number;
  windowBudgetUsd: number;
  cheapModel: string;
  upstreamUrl: string;
  mockMode: boolean;
}

export interface CircuitBreakerState {
  status: "HEALTHY" | "TRIPPED";
  trippedAt: number | null;
  reason: "LOOP_DETECTED" | "SESSION_BUDGET" | "WINDOW_BUDGET" | null;
  message: string | null;
  loopStreak: number;
  lastHash: string | null;
}

export interface TruncatedDiffItem {
  location: string;
  originalChars: number;
  truncatedChars: number;
  headSnippet: string;
  removedMiddleSnippet: string;
  tailSnippet: string;
  marker: string;
}

export interface RequestInspectionDetails {
  upstreamUrl: string;
  redactedHeaders: Record<string, string>;
  latencyBreakdown: {
    firewallMs: number;
    optimizerMs: number;
    upstreamMs: number;
    totalMs: number;
  };
  tokenMath?: {
    originalInputTokens: number;
    slimmedInputTokens: number;
    tokensShaved: number;
    outputTokens: number;
    originalModelCostUsd: number;
    actualCostUsd: number;
    savedUsd: number;
    cacheProtectedMessages?: number;
  };
  slimmedDiffs?: TruncatedDiffItem[];
  dedupedSystemCount?: number;
  loopInspection?: {
    windowHash: string;
    lastMsgHash: string;
    streak: number;
    threshold: number;
    windowSeconds: number;
    repeatedPayload: string;
  };
}

export interface RequestLogEntry {
  id: string;
  timestamp: number;
  format: ApiFormat;
  endpoint: string;
  status: RequestStatus;
  wasSlimmed: boolean;
  wasRerouted: boolean;
  streaming: boolean;
  originalModel: string;
  routedModel: string;
  inputTokens: number;
  originalInputTokens: number;
  outputTokens: number;
  tokensShaved: number;
  costUsd: number;
  savedUsd: number;
  latencyMs: number;
  httpStatus: number;
  promptPreview: string;
  notes: string[];
  details?: RequestInspectionDetails;
}

export interface MetricsSummary {
  totalSpendUsd: number;
  activeSessionSpendUsd: number;
  windowSpendUsd: number;
  totalSavedUsd: number;
  totalTokensSlimmed: number;
  totalRequests: number;
  blockedRequests: number;
  reroutedRequests: number;
  slimmedRequests: number;
}

export interface DashboardSnapshot {
  settings: BurnCapSettings;
  circuit: CircuitBreakerState;
  metrics: MetricsSummary;
  logs: RequestLogEntry[];
}

export interface LoopSample {
  timestamp: number;
  windowHash: string;
  lastMsgHash: string;
}

interface PersistedMetrics {
  totalSpendUsd: number;
  budgetBaselineUsd: number;
  totalSavedUsd: number;
  totalTokensSlimmed: number;
  totalRequests: number;
  blockedRequests: number;
  reroutedRequests: number;
  slimmedRequests: number;
}

interface SqliteDbLike {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
  };
  close(): void;
}

interface StorageDriver {
  kind: "sqlite" | "json";
  load(): {
    settings?: Partial<BurnCapSettings>;
    metrics?: Partial<PersistedMetrics>;
    logs?: RequestLogEntry[];
  };
  saveSettings(settings: BurnCapSettings): void;
  saveMetrics(metrics: PersistedMetrics): void;
  insertRequest(entry: RequestLogEntry, maxLogs: number): void;
  clearRequestsAndMetrics(metrics: PersistedMetrics): void;
  close(): void;
}

const MAX_LOGS = 500;
const WINDOW_DURATION_MS = 5 * 60 * 1000;

export const DEFAULT_SETTINGS: BurnCapSettings = {
  contextSlimmer: true,
  smartRouting: true,
  loopDetector: true,
  sessionBudgetUsd: 2.0,
  windowBudgetUsd: 0.5,
  cheapModel: "anthropic/claude-haiku-4.5",
  upstreamUrl: "https://openrouter.ai/api",
  mockMode: false,
};

function createSqliteStorage(dbPath: string): StorageDriver | null {
  try {
    const require = createRequire(import.meta.url);
    const sqliteMod = require("node:sqlite") as { DatabaseSync: new (p: string) => SqliteDbLike };
    const db = new sqliteMod.DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS metrics (
        key TEXT PRIMARY KEY,
        value REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(timestamp DESC);
    `);

    const upsertSetting = db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    );
    const upsertMetric = db.prepare(
      "INSERT INTO metrics (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    );
    const insertReq = db.prepare(
      "INSERT OR REPLACE INTO requests (id, timestamp, data) VALUES (?, ?, ?)"
    );
    const pruneReqs = db.prepare(
      "DELETE FROM requests WHERE id NOT IN (SELECT id FROM requests ORDER BY timestamp DESC LIMIT ?)"
    );

    return {
      kind: "sqlite",
      load() {
        const settingRow = db.prepare("SELECT value FROM settings WHERE key = 'config'").get();
        const metricRows = db.prepare("SELECT key, value FROM metrics").all();
        const reqRows = db.prepare("SELECT data FROM requests ORDER BY timestamp DESC LIMIT ?").all(MAX_LOGS);

        const settings = settingRow && typeof settingRow.value === "string"
          ? (JSON.parse(settingRow.value) as Partial<BurnCapSettings>)
          : undefined;

        const metrics: Partial<PersistedMetrics> = {};
        for (const row of metricRows) {
          if (typeof row.key === "string" && typeof row.value === "number") {
            (metrics as Record<string, number>)[row.key] = row.value;
          }
        }

        const logs: RequestLogEntry[] = [];
        for (const row of reqRows) {
          if (typeof row.data === "string") {
            try {
              logs.push(JSON.parse(row.data) as RequestLogEntry);
            } catch {
              // Ignore malformed historical log entry
            }
          }
        }

        return { settings, metrics, logs };
      },
      saveSettings(settings) {
        upsertSetting.run("config", JSON.stringify(settings));
      },
      saveMetrics(metrics) {
        for (const [k, v] of Object.entries(metrics)) {
          upsertMetric.run(k, Number(v) || 0);
        }
      },
      insertRequest(entry, maxLogs) {
        insertReq.run(entry.id, entry.timestamp, JSON.stringify(entry));
        pruneReqs.run(maxLogs);
      },
      clearRequestsAndMetrics(metrics) {
        db.exec("DELETE FROM requests");
        for (const [k, v] of Object.entries(metrics)) {
          upsertMetric.run(k, Number(v) || 0);
        }
      },
      close() {
        try {
          db.close();
        } catch {
          // Ignore close errors
        }
      },
    };
  } catch {
    return null;
  }
}

function createJsonStorage(jsonPath: string): StorageDriver {
  let cached: {
    settings?: BurnCapSettings;
    metrics?: PersistedMetrics;
    logs: RequestLogEntry[];
  } = { logs: [] };

  const writeAtomic = () => {
    const tmpPath = `${jsonPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(cached, null, 2), "utf8");
    fs.renameSync(tmpPath, jsonPath);
  };

  return {
    kind: "json",
    load() {
      if (!fs.existsSync(jsonPath)) return {};
      try {
        const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as {
          settings?: Partial<BurnCapSettings>;
          metrics?: Partial<PersistedMetrics>;
          logs?: RequestLogEntry[];
        };
        cached = {
          settings: parsed.settings as BurnCapSettings | undefined,
          metrics: parsed.metrics as PersistedMetrics | undefined,
          logs: Array.isArray(parsed.logs) ? parsed.logs.slice(0, MAX_LOGS) : [],
        };
        return parsed;
      } catch {
        return {};
      }
    },
    saveSettings(settings) {
      cached.settings = settings;
      writeAtomic();
    },
    saveMetrics(metrics) {
      cached.metrics = metrics;
      writeAtomic();
    },
    insertRequest(entry, maxLogs) {
      cached.logs = [entry, ...cached.logs].slice(0, maxLogs);
      writeAtomic();
    },
    clearRequestsAndMetrics(metrics) {
      cached.logs = [];
      cached.metrics = metrics;
      writeAtomic();
    },
    close() {
      // No-op
    },
  };
}

export interface BurnCapStateOptions {
  dataDir?: string;
  initialSettings?: Partial<BurnCapSettings>;
  disablePersistence?: boolean;
}

export class BurnCapState extends EventEmitter {
  public settings: BurnCapSettings;
  public circuit: CircuitBreakerState;
  public logs: RequestLogEntry[] = [];
  public loopHistory: LoopSample[] = [];
  public readonly storageKind: "sqlite" | "json" | "memory";

  private persistedMetrics: PersistedMetrics;
  private recentSpendEvents: Array<{ timestamp: number; costUsd: number }> = [];
  private storage: StorageDriver | null = null;

  constructor(options: BurnCapStateOptions = {}) {
    super();
    this.setMaxListeners(100);

    this.persistedMetrics = {
      totalSpendUsd: 0,
      budgetBaselineUsd: 0,
      totalSavedUsd: 0,
      totalTokensSlimmed: 0,
      totalRequests: 0,
      blockedRequests: 0,
      reroutedRequests: 0,
      slimmedRequests: 0,
    };

    this.circuit = {
      status: "HEALTHY",
      trippedAt: null,
      reason: null,
      message: null,
      loopStreak: 0,
      lastHash: null,
    };

    this.settings = { ...DEFAULT_SETTINGS };

    if (options.disablePersistence) {
      this.storageKind = "memory";
    } else {
      const dir = options.dataDir || process.env.BURNCAP_DATA_DIR || path.join(os.homedir(), ".burncap");
      fs.mkdirSync(dir, { recursive: true });
      const sqliteDriver = createSqliteStorage(path.join(dir, "burncap.db"));
      if (sqliteDriver) {
        this.storage = sqliteDriver;
        this.storageKind = "sqlite";
      } else {
        this.storage = createJsonStorage(path.join(dir, "state.json"));
        this.storageKind = "json";
      }

      const loaded = this.storage.load();
      if (loaded.settings) {
        this.settings = { ...DEFAULT_SETTINGS, ...loaded.settings };
        if (this.settings.cheapModel === "claude-3-5-haiku-20241022") {
          this.settings.cheapModel = DEFAULT_SETTINGS.cheapModel;
          this.storage.saveSettings(this.settings);
        }
      }
      if (loaded.metrics) {
        this.persistedMetrics = { ...this.persistedMetrics, ...loaded.metrics };
      }
      if (Array.isArray(loaded.logs)) {
        this.logs = loaded.logs.slice(0, MAX_LOGS);
        const cutoff = Date.now() - WINDOW_DURATION_MS;
        this.recentSpendEvents = this.logs
          .filter((l) => l.timestamp >= cutoff && l.costUsd > 0)
          .map((l) => ({ timestamp: l.timestamp, costUsd: l.costUsd }));
      }
    }

    // Explicit launch flags / overrides take precedence over saved defaults
    if (options.initialSettings) {
      this.settings = {
        ...this.settings,
        ...Object.fromEntries(
          Object.entries(options.initialSettings).filter(([, v]) => v !== undefined)
        ),
      };
      this.storage?.saveSettings(this.settings);
    }
  }

  public getMetrics(now = Date.now()): MetricsSummary {
    const cutoff = now - WINDOW_DURATION_MS;
    this.recentSpendEvents = this.recentSpendEvents.filter((item) => item.timestamp >= cutoff);
    const windowSpendUsd = this.recentSpendEvents.reduce((acc, item) => acc + item.costUsd, 0);
    const activeSessionSpendUsd = Math.max(
      0,
      this.persistedMetrics.totalSpendUsd - this.persistedMetrics.budgetBaselineUsd
    );

    return {
      totalSpendUsd: this.persistedMetrics.totalSpendUsd,
      activeSessionSpendUsd,
      windowSpendUsd,
      totalSavedUsd: this.persistedMetrics.totalSavedUsd,
      totalTokensSlimmed: this.persistedMetrics.totalTokensSlimmed,
      totalRequests: this.persistedMetrics.totalRequests,
      blockedRequests: this.persistedMetrics.blockedRequests,
      reroutedRequests: this.persistedMetrics.reroutedRequests,
      slimmedRequests: this.persistedMetrics.slimmedRequests,
    };
  }

  public getSnapshot(): DashboardSnapshot {
    return {
      settings: { ...this.settings },
      circuit: { ...this.circuit },
      metrics: this.getMetrics(),
      logs: this.logs,
    };
  }

  public updateSettings(patch: Partial<BurnCapSettings>): BurnCapSettings {
    const next: BurnCapSettings = { ...this.settings };

    if (typeof patch.contextSlimmer === "boolean") next.contextSlimmer = patch.contextSlimmer;
    if (typeof patch.smartRouting === "boolean") next.smartRouting = patch.smartRouting;
    if (typeof patch.loopDetector === "boolean") next.loopDetector = patch.loopDetector;
    if (typeof patch.sessionBudgetUsd === "number" && Number.isFinite(patch.sessionBudgetUsd)) {
      next.sessionBudgetUsd = Math.min(100, Math.max(0.01, Number(patch.sessionBudgetUsd.toFixed(2))));
    }
    if (typeof patch.windowBudgetUsd === "number" && Number.isFinite(patch.windowBudgetUsd)) {
      next.windowBudgetUsd = Math.min(100, Math.max(0.01, Number(patch.windowBudgetUsd.toFixed(2))));
    }
    if (typeof patch.cheapModel === "string" && patch.cheapModel.trim()) {
      next.cheapModel = patch.cheapModel.trim();
    }
    if (typeof patch.upstreamUrl === "string" && patch.upstreamUrl.trim()) {
      next.upstreamUrl = patch.upstreamUrl.trim().replace(/\/+$/, "");
    }
    if (typeof patch.mockMode === "boolean") {
      next.mockMode = patch.mockMode;
    }

    this.settings = next;
    this.storage?.saveSettings(this.settings);
    this.emit("change", { type: "settings", payload: this.getSnapshot() });
    return this.settings;
  }

  public recordRequest(entry: RequestLogEntry): void {
    this.logs = [entry, ...this.logs].slice(0, MAX_LOGS);

    this.persistedMetrics.totalRequests += 1;
    this.persistedMetrics.totalSpendUsd += entry.costUsd;
    this.persistedMetrics.totalSavedUsd += entry.savedUsd;
    this.persistedMetrics.totalTokensSlimmed += entry.tokensShaved;

    if (entry.status === "BLOCKED: LOOP" || entry.status === "BLOCKED: BUDGET") {
      this.persistedMetrics.blockedRequests += 1;
    }
    if (entry.wasRerouted) {
      this.persistedMetrics.reroutedRequests += 1;
    }
    if (entry.wasSlimmed) {
      this.persistedMetrics.slimmedRequests += 1;
    }

    if (entry.costUsd > 0) {
      this.recentSpendEvents.push({ timestamp: entry.timestamp, costUsd: entry.costUsd });
    }

    this.storage?.insertRequest(entry, MAX_LOGS);
    this.storage?.saveMetrics(this.persistedMetrics);

    this.emit("request", entry);
    this.emit("change", {
      type: "request",
      payload: {
        entry,
        metrics: this.getMetrics(entry.timestamp),
        circuit: { ...this.circuit },
      },
    });
  }

  public updateLoopTracking(streak: number, lastHash: string | null): void {
    this.circuit.loopStreak = streak;
    this.circuit.lastHash = lastHash;
  }

  public tripCircuitBreaker(
    reason: "LOOP_DETECTED" | "SESSION_BUDGET" | "WINDOW_BUDGET",
    message: string
  ): void {
    this.circuit = {
      ...this.circuit,
      status: "TRIPPED",
      trippedAt: Date.now(),
      reason,
      message,
    };
    this.emit("change", {
      type: "circuit",
      payload: {
        circuit: { ...this.circuit },
        metrics: this.getMetrics(),
      },
    });
  }

  public resetCircuitBreaker(): CircuitBreakerState {
    const previousReason = this.circuit.reason;
    if (previousReason === "SESSION_BUDGET") {
      this.persistedMetrics.budgetBaselineUsd = this.persistedMetrics.totalSpendUsd;
      this.recentSpendEvents = [];
    } else if (previousReason === "WINDOW_BUDGET") {
      this.recentSpendEvents = [];
    }

    // Even if user proactively resets while near cap, clear window & rebase if active >= cap
    const currentMetrics = this.getMetrics();
    if (currentMetrics.activeSessionSpendUsd >= this.settings.sessionBudgetUsd) {
      this.persistedMetrics.budgetBaselineUsd = this.persistedMetrics.totalSpendUsd;
    }
    if (currentMetrics.windowSpendUsd >= this.settings.windowBudgetUsd) {
      this.recentSpendEvents = [];
    }

    this.loopHistory = [];
    this.circuit = {
      status: "HEALTHY",
      trippedAt: null,
      reason: null,
      message: null,
      loopStreak: 0,
      lastHash: null,
    };

    this.storage?.saveMetrics(this.persistedMetrics);
    this.emit("change", {
      type: "circuit",
      payload: {
        circuit: { ...this.circuit },
        metrics: this.getMetrics(),
      },
    });
    return { ...this.circuit };
  }

  public clearLogs(): void {
    this.logs = [];
    this.loopHistory = [];
    this.recentSpendEvents = [];
    this.persistedMetrics = {
      totalSpendUsd: 0,
      budgetBaselineUsd: 0,
      totalSavedUsd: 0,
      totalTokensSlimmed: 0,
      totalRequests: 0,
      blockedRequests: 0,
      reroutedRequests: 0,
      slimmedRequests: 0,
    };
    this.circuit = {
      status: "HEALTHY",
      trippedAt: null,
      reason: null,
      message: null,
      loopStreak: 0,
      lastHash: null,
    };
    this.storage?.clearRequestsAndMetrics(this.persistedMetrics);
    this.emit("change", { type: "clear", payload: this.getSnapshot() });
  }

  public close(): void {
    this.storage?.close();
  }
}
