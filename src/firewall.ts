import crypto from "node:crypto";
import type { ApiFormat, BurnCapState, RequestStatus } from "./state.js";

const LOOP_WINDOW_MS = 60_000;
const LOOP_TRIP_THRESHOLD = 3;

export interface LoopForensics {
  windowHash: string;
  lastMsgHash: string;
  streak: number;
  threshold: number;
  windowSeconds: number;
  repeatedPayload: string;
}

export type FirewallResult =
  | {
      allowed: true;
      loopStreak: number;
      lastHash: string | null;
    }
  | {
      allowed: false;
      httpStatus: 402 | 429;
      status: Extract<RequestStatus, "BLOCKED: LOOP" | "BLOCKED: BUDGET">;
      reason: "LOOP_DETECTED" | "SESSION_BUDGET" | "WINDOW_BUDGET";
      message: string;
      errorBody: Record<string, unknown>;
      loopInspection?: LoopForensics;
    };

function extractTextFromContent(content: unknown, skipIds = true): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => extractTextFromContent(item, skipIds))
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    const obj = content as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof obj.text === "string") parts.push(obj.text);
    if (obj.content !== undefined) parts.push(extractTextFromContent(obj.content, skipIds));
    if (typeof obj.arguments === "string") parts.push(obj.arguments);
    if (!skipIds && typeof obj.id === "string") parts.push(obj.id);
    return parts.join("\n");
  }
  return "";
}

function normalizeForLoopHash(text: string): string {
  return text
    .toLowerCase()
    .replace(/\b(?:call|toolu|msg|req|chatcmpl)_[a-z0-9_-]+\b/g, "<id>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<uuid>")
    .replace(/\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z?/g, "<ts>")
    .replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, "<time>")
    .replace(/0x[0-9a-f]+/g, "<hex>")
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|sec|s)\b/g, "<dur>")
    .replace(/\s+/g, " ")
    .trim();
}

function sha256Short(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
}

interface ExtractedMessage {
  role: string;
  isToolOutput: boolean;
  rawText: string;
  normalized: string;
}

function extractUserAndToolMessages(
  format: ApiFormat,
  body: Record<string, unknown>
): ExtractedMessage[] {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const extracted: ExtractedMessage[] = [];

  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const msg = raw as Record<string, unknown>;
    const role = typeof msg.role === "string" ? msg.role.toLowerCase() : "";

    if (format === "openai") {
      if (role === "user" || role === "tool" || role === "function") {
        const rawText = extractTextFromContent(msg.content).trim();
        const normalized = normalizeForLoopHash(rawText);
        if (normalized) {
          extracted.push({
            role,
            isToolOutput: role === "tool" || role === "function",
            rawText,
            normalized,
          });
        }
      }
    } else {
      if (role === "user") {
        const hasToolResult =
          Array.isArray(msg.content) &&
          msg.content.some(
            (b) => b && typeof b === "object" && (b as Record<string, unknown>).type === "tool_result"
          );
        const rawText = extractTextFromContent(msg.content).trim();
        const normalized = normalizeForLoopHash(rawText);
        if (normalized) {
          extracted.push({
            role: hasToolResult ? "tool" : "user",
            isToolOutput: hasToolResult,
            rawText,
            normalized,
          });
        }
      }
    }
  }

  return extracted.slice(-3);
}

function looksLikeFailingOutput(text: string): boolean {
  return /(error|exception|failed|fail\b|traceback|econnrefused|enoent|typeerror|syntaxerror|referenceerror|exit code [1-9]|panic:)/i.test(
    text
  );
}

export function extractPromptPreview(format: ApiFormat, body: Record<string, unknown>): string {
  const messages = extractUserAndToolMessages(format, body);
  const last = messages[messages.length - 1];
  if (!last) return "(empty prompt)";
  const raw = last.rawText.replace(/\s+/g, " ").trim();
  return raw.length > 110 ? `${raw.slice(0, 107)}...` : raw;
}

export function createAgentErrorPayload(
  reason: "LOOP_DETECTED" | "SESSION_BUDGET" | "WINDOW_BUDGET",
  message: string,
  details: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    type: "error",
    error: {
      message,
      type: "burncap_circuit_breaker",
      code: reason.toLowerCase(),
    },
    burncap: {
      blocked: true,
      reason,
      ...details,
    },
  };
}

function capRepeatedPayload(text: string): string {
  return text.length > 6000 ? `${text.slice(0, 6000)}\n... (truncated for forensic preview)` : text;
}

export function checkFirewallBeforeUpstream(
  state: BurnCapState,
  format: ApiFormat,
  body: Record<string, unknown>,
  now = Date.now()
): FirewallResult {
  const lastThree = extractUserAndToolMessages(format, body);
  const windowSignature = lastThree.map((m) => `${m.role}:${m.normalized}`).join("||");
  const windowHash = lastThree.length > 0 ? sha256Short(windowSignature) : "";
  const latest = lastThree[lastThree.length - 1];
  const lastMsgEligible =
    latest &&
    latest.normalized.length >= 16 &&
    (latest.isToolOutput || looksLikeFailingOutput(latest.normalized));
  const lastMsgHash = lastMsgEligible ? sha256Short(`${latest.role}:${latest.normalized}`) : "";

  // 1. Check if breaker is already tripped
  if (state.circuit.status === "TRIPPED") {
    const reason = state.circuit.reason ?? "LOOP_DETECTED";
    const isLoop = reason === "LOOP_DETECTED";
    const msg =
      state.circuit.message ??
      "[BurnCap Firewall] Circuit breaker is currently tripped. Reset it from the BurnCap dashboard to resume.";
    return {
      allowed: false,
      httpStatus: reason === "SESSION_BUDGET" ? 402 : 429,
      status: isLoop ? "BLOCKED: LOOP" : "BLOCKED: BUDGET",
      reason,
      message: msg,
      errorBody: createAgentErrorPayload(reason, msg, { alreadyTripped: true }),
      loopInspection: isLoop
        ? {
            windowHash: windowHash || state.circuit.lastHash || "unknown",
            lastMsgHash: lastMsgHash || state.circuit.lastHash || "unknown",
            streak: state.circuit.loopStreak || LOOP_TRIP_THRESHOLD,
            threshold: LOOP_TRIP_THRESHOLD,
            windowSeconds: LOOP_WINDOW_MS / 1000,
            repeatedPayload: capRepeatedPayload(
              latest?.rawText || lastThree.map((m) => `[${m.role}] ${m.rawText}`).join("\n\n") || msg
            ),
          }
        : undefined,
    };
  }

  // 2. Check spend hard-caps (session cap + rolling 5-minute window cap)
  const metrics = state.getMetrics(now);
  if (metrics.activeSessionSpendUsd >= state.settings.sessionBudgetUsd) {
    const msg = `[BurnCap Firewall] Session spend cap reached ($${metrics.activeSessionSpendUsd.toFixed(
      4
    )} / $${state.settings.sessionBudgetUsd.toFixed(
      2
    )}). Agent paused to prevent runaway costs. Reset the circuit breaker or raise the budget slider at http://localhost:4321.`;
    state.tripCircuitBreaker("SESSION_BUDGET", msg);
    return {
      allowed: false,
      httpStatus: 402,
      status: "BLOCKED: BUDGET",
      reason: "SESSION_BUDGET",
      message: msg,
      errorBody: createAgentErrorPayload("SESSION_BUDGET", msg, {
        activeSessionSpendUsd: metrics.activeSessionSpendUsd,
        sessionBudgetUsd: state.settings.sessionBudgetUsd,
      }),
    };
  }

  if (metrics.windowSpendUsd >= state.settings.windowBudgetUsd) {
    const msg = `[BurnCap Firewall] 5-minute spend velocity cap reached ($${metrics.windowSpendUsd.toFixed(
      4
    )} / $${state.settings.windowBudgetUsd.toFixed(
      2
    )} in 5m). Agent paused to prevent token burn spikes. Reset the circuit breaker to continue.`;
    state.tripCircuitBreaker("WINDOW_BUDGET", msg);
    return {
      allowed: false,
      httpStatus: 429,
      status: "BLOCKED: BUDGET",
      reason: "WINDOW_BUDGET",
      message: msg,
      errorBody: createAgentErrorPayload("WINDOW_BUDGET", msg, {
        windowSpendUsd: metrics.windowSpendUsd,
        windowBudgetUsd: state.settings.windowBudgetUsd,
      }),
    };
  }

  // 3. Infinite loop detection
  if (!state.settings.loopDetector) {
    state.updateLoopTracking(0, null);
    return { allowed: true, loopStreak: 0, lastHash: null };
  }

  if (lastThree.length === 0) {
    return { allowed: true, loopStreak: 0, lastHash: null };
  }

  // Prune samples older than 60 seconds
  state.loopHistory = state.loopHistory.filter((s) => now - s.timestamp <= LOOP_WINDOW_MS);

  let consecutiveWindowMatches = 0;
  for (let i = state.loopHistory.length - 1; i >= 0; i -= 1) {
    if (state.loopHistory[i].windowHash === windowHash) {
      consecutiveWindowMatches += 1;
    } else {
      break;
    }
  }

  let consecutiveLastMsgMatches = 0;
  if (lastMsgEligible) {
    for (let i = state.loopHistory.length - 1; i >= 0; i -= 1) {
      if (state.loopHistory[i].lastMsgHash && state.loopHistory[i].lastMsgHash === lastMsgHash) {
        consecutiveLastMsgMatches += 1;
      } else {
        break;
      }
    }
  }

  const windowStreak = 1 + consecutiveWindowMatches;
  const lastMsgStreak = lastMsgEligible ? 1 + consecutiveLastMsgMatches : 0;
  const streak = Math.max(windowStreak, lastMsgStreak);

  state.loopHistory.push({
    timestamp: now,
    windowHash,
    lastMsgHash,
  });
  if (state.loopHistory.length > 10) {
    state.loopHistory = state.loopHistory.slice(-10);
  }

  state.updateLoopTracking(streak, windowHash);

  if (streak >= LOOP_TRIP_THRESHOLD) {
    const matchedSingleLastMsg = lastMsgStreak >= LOOP_TRIP_THRESHOLD && latest.isToolOutput;
    const triggerDetail = matchedSingleLastMsg
      ? "identical failing tool output repeated 3x in a row within 60s"
      : "near-identical prompt sequence repeated 3x in a row within 60s";
    const repeatedPayload = matchedSingleLastMsg
      ? `[${latest.role}] ${latest.rawText}`
      : lastThree.map((m) => `[${m.role}] ${m.rawText}`).join("\n\n");

    const msg = `[BurnCap Firewall] Infinite loop detected (${triggerDetail}, hash ${windowHash}). Agent execution paused to stop runaway token burn. Review the failing step and reset the circuit breaker at http://localhost:4321.`;
    state.tripCircuitBreaker("LOOP_DETECTED", msg);
    return {
      allowed: false,
      httpStatus: 429,
      status: "BLOCKED: LOOP",
      reason: "LOOP_DETECTED",
      message: msg,
      errorBody: createAgentErrorPayload("LOOP_DETECTED", msg, {
        loopHash: windowHash,
        lastMsgHash,
        streak,
      }),
      loopInspection: {
        windowHash,
        lastMsgHash: lastMsgHash || windowHash,
        streak,
        threshold: LOOP_TRIP_THRESHOLD,
        windowSeconds: LOOP_WINDOW_MS / 1000,
        repeatedPayload: capRepeatedPayload(repeatedPayload),
      },
    };
  }

  return {
    allowed: true,
    loopStreak: streak,
    lastHash: windowHash,
  };
}
