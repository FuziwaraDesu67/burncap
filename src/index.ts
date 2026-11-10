#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { runDemoTrafficBurst } from "./mock.js";
import { createProxyApp } from "./proxy.js";
import { BurnCapState, DEFAULT_SETTINGS, type RequestLogEntry } from "./state.js";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  orange: "\x1b[38;5;208m",
};

function loadDashboardHtml(): string {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(dir, "dashboard.html"),
    path.join(dir, "..", "src", "dashboard.html"),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      return fs.readFileSync(file, "utf8");
    }
  }
  return "<!doctype html><html><body><h1>BurnCap dashboard.html not found</h1></body></html>";
}

export interface DashboardAppOptions {
  state: BurnCapState;
  proxyPort: number;
  dashboardPort: number;
  internalMockToken: string;
}

export function createDashboardApp(options: DashboardAppOptions): Hono {
  const { state, proxyPort, dashboardPort, internalMockToken } = options;
  const app = new Hono();
  const dashboardHtml = loadDashboardHtml();

  app.get("/", (c) => c.html(dashboardHtml));

  app.get("/api/meta", (c) =>
    c.json({
      version: "0.1.0",
      proxyPort,
      dashboardPort,
      storageKind: state.storageKind,
    })
  );

  app.get("/api/state", (c) => c.json(state.getSnapshot()));

  app.post("/api/settings", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const updated = state.updateSettings(body);
    return c.json({ settings: updated });
  });

  app.post("/api/circuit/reset", (c) => {
    const circuit = state.resetCircuitBreaker();
    return c.json({ circuit, metrics: state.getMetrics() });
  });

  app.post("/api/clear", (c) => {
    state.clearLogs();
    return c.json({ ok: true, snapshot: state.getSnapshot() });
  });

  app.post("/api/simulate-traffic", async (c) => {
    const summary = await runDemoTrafficBurst({
      proxyBaseUrl: `http://127.0.0.1:${proxyPort}`,
      state,
      internalMockToken,
    });
    return c.json(summary, summary.started ? 200 : 409);
  });

  app.get("/api/events", (c) => {
    const encoder = new TextEncoder();
    let cleanup: (() => void) | null = null;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const sendEvent = (eventName: string, data: unknown) => {
          try {
            controller.enqueue(
              encoder.encode(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`)
            );
          } catch {
            // Stream closed
          }
        };

        sendEvent("init", state.getSnapshot());

        const onChange = (evt: { type: string; payload: unknown }) => {
          sendEvent(evt.type, evt.payload);
        };
        state.on("change", onChange);

        const keepAlive = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            // Stream closed
          }
        }, 15_000);

        cleanup = () => {
          clearInterval(keepAlive);
          state.off("change", onChange);
        };

        c.req.raw.signal?.addEventListener("abort", () => cleanup?.(), { once: true });
      },
      cancel() {
        cleanup?.();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    });
  });

  return app;
}

function formatTerminalRequestLine(entry: RequestLogEntry): string {
  const time = new Date(entry.timestamp).toLocaleTimeString([], {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  let badgeColor = ANSI.gray;
  if (entry.status === "SLIMMED") badgeColor = ANSI.cyan;
  else if (entry.status === "REROUTED") badgeColor = ANSI.green;
  else if (entry.status === "BLOCKED: LOOP") badgeColor = ANSI.yellow;
  else if (entry.status === "BLOCKED: BUDGET") badgeColor = ANSI.red;

  const paddedStatus = entry.status.padEnd(15, " ");
  const route = entry.wasRerouted
    ? `${ANSI.dim}${entry.originalModel}${ANSI.reset} -> ${ANSI.green}${entry.routedModel}${ANSI.reset}`
    : entry.originalModel;

  const tokensInfo =
    entry.status.startsWith("BLOCKED")
      ? `${ANSI.red}HTTP ${entry.httpStatus}${ANSI.reset}`
      : `${entry.inputTokens}/${entry.outputTokens} tok`;

  const shavedPart =
    entry.tokensShaved > 0 ? ` ${ANSI.cyan}-${entry.tokensShaved} shaved${ANSI.reset}` : "";
  const savedPart =
    entry.savedUsd > 0 ? ` ${ANSI.green}+$${entry.savedUsd.toFixed(4)} saved${ANSI.reset}` : "";

  return `${ANSI.dim}[${time}]${ANSI.reset} ${badgeColor}${ANSI.bold}${paddedStatus}${ANSI.reset} ${route}  ${ANSI.gray}${tokensInfo}${ANSI.reset}${shavedPart}${savedPart}  ${ANSI.dim}${entry.latencyMs}ms${ANSI.reset}`;
}

export interface BurnCapServerOptions {
  proxyPort?: number;
  dashboardPort?: number;
  mockMode?: boolean;
  upstreamUrl?: string;
  sessionBudgetUsd?: number;
  windowBudgetUsd?: number;
  cheapModel?: string;
  contextSlimmer?: boolean;
  smartRouting?: boolean;
  loopDetector?: boolean;
  dataDir?: string;
  disablePersistence?: boolean;
  quiet?: boolean;
}

export interface RunningBurnCap {
  state: BurnCapState;
  proxyPort: number;
  dashboardPort: number;
  proxyServer: ServerType;
  dashboardServer: ServerType;
  close: () => Promise<void>;
}

function listenOnPort(app: Hono, port: number): Promise<{ server: ServerType; port: number }> {
  return new Promise((resolve, reject) => {
    const server = serve(
      {
        fetch: app.fetch,
        port,
        hostname: "127.0.0.1",
      },
      (info) => {
        resolve({ server, port: info.port });
      }
    );
    server.on("error", reject);
  });
}

export async function startBurnCap(opts: BurnCapServerOptions = {}): Promise<RunningBurnCap> {
  const internalMockToken = crypto.randomBytes(16).toString("hex");
  const requestedProxyPort = opts.proxyPort ?? Number(process.env.BURNCAP_PORT || process.env.PORT || 4000);
  const requestedDashPort = opts.dashboardPort ?? Number(process.env.BURNCAP_DASHBOARD_PORT || 4321);

  const state = new BurnCapState({
    dataDir: opts.dataDir,
    disablePersistence: opts.disablePersistence,
    initialSettings: {
      mockMode: opts.mockMode ?? false,
      upstreamUrl: opts.upstreamUrl || process.env.BURNCAP_UPSTREAM || DEFAULT_SETTINGS.upstreamUrl,
      sessionBudgetUsd: opts.sessionBudgetUsd,
      windowBudgetUsd: opts.windowBudgetUsd,
      cheapModel: opts.cheapModel,
      contextSlimmer: opts.contextSlimmer,
      smartRouting: opts.smartRouting,
      loopDetector: opts.loopDetector,
    },
  });

  // Ensure mockMode reflects current launch flag cleanly
  state.updateSettings({ mockMode: Boolean(opts.mockMode) });

  // Bind proxy first so dashboard and proxy simulation endpoints know the actual resolved port
  let actualProxyPort = requestedProxyPort;
  const proxyApp = createProxyApp({
    state,
    internalMockToken,
    getProxyPort: () => actualProxyPort,
  });

  const proxyBound = await listenOnPort(proxyApp, requestedProxyPort);
  actualProxyPort = proxyBound.port;
  const dashboardApp = createDashboardApp({
    state,
    proxyPort: actualProxyPort,
    dashboardPort: requestedDashPort,
    internalMockToken,
  });
  const dashboardBound = await listenOnPort(dashboardApp, requestedDashPort);

  if (!opts.quiet) {
    state.on("request", (entry: RequestLogEntry) => {
      console.log(formatTerminalRequestLine(entry));
    });

    const modeText = state.settings.mockMode
      ? `${ANSI.cyan}${ANSI.bold}$0 OFFLINE MOCK${ANSI.reset} ${ANSI.dim}(no external API calls)${ANSI.reset}`
      : `${ANSI.green}${ANSI.bold}LIVE PROXY${ANSI.reset} ${ANSI.dim}-> ${state.settings.upstreamUrl}${ANSI.reset}`;

    const asciiLogo = String.raw`
   ____                   ____
  | __ ) _   _ _ __ _ __ / ___|__ _ _ __
  |  _ \| | | | '__| '_ \| |   / _' | '_ \
  | |_) | |_| | |  | | | | |__| (_| | |_) |
  |____/ \__,_|_|  |_| |_|\____\__,_| .__/
                                    |_|   v0.1.0`;

    console.log(`${ANSI.orange}${ANSI.bold}${asciiLogo}${ANSI.reset}`);
    console.log(
      `  ${ANSI.gray}Local AI Agent Firewall, Loop Circuit-Breaker & Smart Token Router${ANSI.reset}`
    );
    console.log(`  ${ANSI.gray}--------------------------------------------------------------------${ANSI.reset}`);
    console.log(`  ${ANSI.bold}Proxy Endpoint:${ANSI.reset}  ${ANSI.cyan}http://localhost:${actualProxyPort}${ANSI.reset}`);
    console.log(`  ${ANSI.bold}Live Dashboard:${ANSI.reset}  ${ANSI.orange}http://localhost:${dashboardBound.port}${ANSI.reset}`);
    console.log(`  ${ANSI.bold}Mode:${ANSI.reset}            ${modeText}`);
    console.log(
      `  ${ANSI.bold}Guardrails:${ANSI.reset}      ${ANSI.bold}$${state.settings.sessionBudgetUsd.toFixed(2)}/session${ANSI.reset} (${ANSI.dim}$${state.settings.windowBudgetUsd.toFixed(2)}/5m${ANSI.reset}) | Loop ${state.settings.loopDetector ? `${ANSI.green}ON${ANSI.reset}` : `${ANSI.red}OFF${ANSI.reset}`} | Slimmer ${state.settings.contextSlimmer ? `${ANSI.green}ON${ANSI.reset}` : `${ANSI.red}OFF${ANSI.reset}`} | Router ${state.settings.smartRouting ? `${ANSI.green}ON${ANSI.reset}` : `${ANSI.red}OFF${ANSI.reset}`}`
    );
    console.log("");
    console.log(`  ${ANSI.bold}Quick Copy-Paste Setup:${ANSI.reset}`);
    console.log(`    ${ANSI.dim}Claude Code   :${ANSI.reset} export ANTHROPIC_BASE_URL=http://localhost:${actualProxyPort}`);
    console.log(`    ${ANSI.dim}Cursor/OpenAI :${ANSI.reset} export OPENAI_BASE_URL=http://localhost:${actualProxyPort}/v1`);
    console.log(`    ${ANSI.dim}OpenRouter    :${ANSI.reset} export OPENAI_BASE_URL=http://localhost:${actualProxyPort}/api/v1`);
    console.log(`  ${ANSI.gray}--------------------------------------------------------------------${ANSI.reset}`);
    console.log("");
  }

  const close = async () => {
    await new Promise<void>((resolve) => proxyBound.server.close(() => resolve()));
    await new Promise<void>((resolve) => dashboardBound.server.close(() => resolve()));
    state.close();
  };

  return {
    state,
    proxyPort: actualProxyPort,
    dashboardPort: dashboardBound.port,
    proxyServer: proxyBound.server,
    dashboardServer: dashboardBound.server,
    close,
  };
}

function printHelp(): void {
  console.log(`
  BurnCap — Local AI Agent Firewall, Loop Circuit-Breaker & Smart Token Router

  Usage:
    npx burncap [options]
    npm run dev -- --mock

  Options:
    -m, --mock                 Run in $0 offline mock upstream mode (no external API calls)
    -p, --port <port>          Proxy listen port (default: 4000)
    -d, --dashboard-port <p>   Dashboard web UI port (default: 4321)
    -u, --upstream <url>       Target upstream base URL (default: https://openrouter.ai/api)
    -b, --budget <usd>         Session spend hard-cap in USD (default: 2.00)
        --window-budget <usd>  5-minute rolling spend cap in USD (default: 0.50)
        --cheap-model <model>  Smart Router downgrade target (default: anthropic/claude-haiku-4.5)
        --no-slimmer           Disable Context Slimmer middleware on startup
        --no-router            Disable Smart Model Router on startup
        --no-loop-detector     Disable Loop Detector on startup
    -h, --help                 Show this help message
    -v, --version              Show version
  `);
}

async function runCli(): Promise<void> {
  const { values } = parseArgs({
    options: {
      mock: { type: "boolean", short: "m", default: false },
      port: { type: "string", short: "p" },
      "dashboard-port": { type: "string", short: "d" },
      upstream: { type: "string", short: "u" },
      budget: { type: "string", short: "b" },
      "window-budget": { type: "string" },
      "cheap-model": { type: "string" },
      "no-slimmer": { type: "boolean", default: false },
      "no-router": { type: "boolean", default: false },
      "no-loop-detector": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    printHelp();
    return;
  }
  if (values.version) {
    console.log("burncap v0.1.0");
    return;
  }

  const running = await startBurnCap({
    mockMode: values.mock,
    proxyPort: values.port ? Number(values.port) : undefined,
    dashboardPort: values["dashboard-port"] ? Number(values["dashboard-port"]) : undefined,
    upstreamUrl: values.upstream,
    sessionBudgetUsd: values.budget ? Number(values.budget) : undefined,
    windowBudgetUsd: values["window-budget"] ? Number(values["window-budget"]) : undefined,
    cheapModel: values["cheap-model"],
    contextSlimmer: values["no-slimmer"] ? false : undefined,
    smartRouting: values["no-router"] ? false : undefined,
    loopDetector: values["no-loop-detector"] ? false : undefined,
  });

  const shutdown = async () => {
    console.log(`\n  ${ANSI.dim}Shutting down BurnCap...${ANSI.reset}`);
    await running.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const isEntrypoint = (() => {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  runCli().catch((err) => {
    console.error("Failed to start BurnCap:", err);
    process.exit(1);
  });
}
