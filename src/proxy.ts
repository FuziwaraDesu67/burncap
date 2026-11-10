import crypto from "node:crypto";
import { Hono, type Context } from "hono";
import { checkFirewallBeforeUpstream, extractPromptPreview } from "./firewall.js";
import { createMockUpstreamResponse, runDemoTrafficBurst } from "./mock.js";
import { optimizeRequestPayload } from "./optimizer.js";
import { calculateCostUsd, estimateTokensFromText } from "./pricing.js";
import type {
  ApiFormat,
  BurnCapState,
  RequestInspectionDetails,
  RequestLogEntry,
  RequestStatus,
} from "./state.js";

const FORWARDED_HEADER_NAMES = [
  "authorization",
  "x-api-key",
  "anthropic-version",
  "anthropic-beta",
  "http-referer",
  "x-title",
  "accept",
  "user-agent",
  "openai-organization",
  "openai-project",
];

const SKIPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
]);

export function buildUpstreamUrl(baseUrl: string, apiPath: string): string {
  const cleanBase = baseUrl.trim().replace(/\/+$/, "");
  if (cleanBase.endsWith("/v1") && apiPath.startsWith("/v1/")) {
    return `${cleanBase}${apiPath.slice(3)}`;
  }
  return `${cleanBase}${apiPath}`;
}

function buildForwardHeaders(c: Context): Headers {
  const out = new Headers();
  out.set("content-type", "application/json");
  for (const name of FORWARDED_HEADER_NAMES) {
    const val = c.req.header(name);
    if (val) out.set(name, val);
  }
  return out;
}

function maskSecretValue(raw: string): string {
  const trimmed = raw.trim();
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx > 0 && spaceIdx < 12) {
    const scheme = trimmed.slice(0, spaceIdx);
    const token = trimmed.slice(spaceIdx + 1).trim();
    return `${scheme} ${maskToken(token)}`;
  }
  return maskToken(trimmed);
}

function maskToken(token: string): string {
  if (token.length <= 10) return "***";
  return `${token.slice(0, 5)}***${token.slice(-4)}`;
}

function buildRedactedHeaders(headers: Headers): Record<string, string> {
  const redacted: Record<string, string> = {};
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === "authorization" || lower === "x-api-key") {
      redacted[lower] = maskSecretValue(value);
    } else {
      redacted[lower] = value;
    }
  });
  return redacted;
}

function resolveUpstreamBaseUrl(c: Context, format: ApiFormat, state: BurnCapState): string {
  const headerOverride = c.req.header("x-burncap-upstream") || c.req.header("x-target-url");
  if (headerOverride?.trim()) return headerOverride.trim();
  if (format === "anthropic" && process.env.BURNCAP_ANTHROPIC_UPSTREAM?.trim()) {
    return process.env.BURNCAP_ANTHROPIC_UPSTREAM.trim();
  }
  if (format === "openai" && process.env.BURNCAP_OPENAI_UPSTREAM?.trim()) {
    return process.env.BURNCAP_OPENAI_UPSTREAM.trim();
  }
  return state.settings.upstreamUrl;
}

function deriveStatus(
  wasRerouted: boolean,
  wasSlimmed: boolean
): Extract<RequestStatus, "PASSED" | "SLIMMED" | "REROUTED"> {
  if (wasRerouted) return "REROUTED";
  if (wasSlimmed) return "SLIMMED";
  return "PASSED";
}

function buildBurnCapHeaders(
  status: RequestStatus,
  originalModel: string,
  routedModel: string,
  tokensShaved: number
): Record<string, string> {
  return {
    "x-burncap-status": status,
    "x-burncap-original-model": originalModel,
    "x-burncap-routed-model": routedModel,
    "x-burncap-tokens-shaved": String(tokensShaved),
  };
}

interface ParsedUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

function extractUsageFromJson(format: ApiFormat, data: unknown): ParsedUsage {
  if (!data || typeof data !== "object") return { inputTokens: null, outputTokens: null };
  const obj = data as Record<string, unknown>;
  const usage = obj.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== "object") return { inputTokens: null, outputTokens: null };

  if (format === "anthropic") {
    return {
      inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : null,
      outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : null,
    };
  }
  return {
    inputTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null,
    outputTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : null,
  };
}

function extractCompletionTextFromJson(format: ApiFormat, data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const obj = data as Record<string, unknown>;

  if (format === "anthropic" && Array.isArray(obj.content)) {
    return obj.content
      .map((b) => {
        if (!b || typeof b !== "object") return "";
        const rec = b as Record<string, unknown>;
        if (typeof rec.text === "string") return rec.text;
        if (rec.input !== undefined) return JSON.stringify(rec.input);
        return "";
      })
      .join("");
  }

  if (Array.isArray(obj.choices) && obj.choices[0] && typeof obj.choices[0] === "object") {
    const msg = (obj.choices[0] as Record<string, unknown>).message as Record<string, unknown> | undefined;
    if (!msg) return "";
    const parts: string[] = [];
    if (typeof msg.content === "string") parts.push(msg.content);
    if (msg.tool_calls !== undefined) parts.push(JSON.stringify(msg.tool_calls));
    return parts.join("");
  }

  return "";
}

function createSseTapStream(
  upstreamBody: ReadableStream<Uint8Array>,
  format: ApiFormat,
  onComplete: (stats: {
    inputTokens: number | null;
    outputTokens: number | null;
    streamedText: string;
  }) => void
): ReadableStream<Uint8Array> {
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  let lineBuffer = "";
  let streamedText = "";
  let reportedInputTokens: number | null = null;
  let reportedOutputTokens: number | null = null;
  let finalized = false;

  const finalize = () => {
    if (finalized) return;
    finalized = true;
    onComplete({
      inputTokens: reportedInputTokens,
      outputTokens: reportedOutputTokens,
      streamedText,
    });
  };

  const inspectLine = (rawLine: string) => {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;

    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      if (format === "openai") {
        const usage = parsed.usage as Record<string, unknown> | undefined;
        if (usage && typeof usage === "object") {
          if (typeof usage.prompt_tokens === "number") reportedInputTokens = usage.prompt_tokens;
          if (typeof usage.completion_tokens === "number") reportedOutputTokens = usage.completion_tokens;
        }
        const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
        const first = choices[0] as Record<string, unknown> | undefined;
        const delta = first?.delta as Record<string, unknown> | undefined;
        if (delta) {
          if (typeof delta.content === "string") {
            streamedText += delta.content;
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              if (!tc || typeof tc !== "object") continue;
              const fn = (tc as Record<string, unknown>).function as Record<string, unknown> | undefined;
              if (fn) {
                if (typeof fn.name === "string") streamedText += fn.name;
                if (typeof fn.arguments === "string") streamedText += fn.arguments;
              }
            }
          }
        }
      } else {
        const eventType = parsed.type;
        if (eventType === "message_start") {
          const msg = parsed.message as Record<string, unknown> | undefined;
          const usage = msg?.usage as Record<string, unknown> | undefined;
          if (usage && typeof usage.input_tokens === "number") {
            reportedInputTokens = usage.input_tokens;
          }
          if (usage && typeof usage.output_tokens === "number" && usage.output_tokens > 0) {
            reportedOutputTokens = usage.output_tokens;
          }
        } else if (eventType === "content_block_delta") {
          const delta = parsed.delta as Record<string, unknown> | undefined;
          if (delta) {
            if (typeof delta.text === "string") streamedText += delta.text;
            if (typeof delta.partial_json === "string") streamedText += delta.partial_json;
          }
        } else if (eventType === "message_delta") {
          const usage = parsed.usage as Record<string, unknown> | undefined;
          if (usage && typeof usage.output_tokens === "number") {
            reportedOutputTokens = usage.output_tokens;
          }
        }
      }
    } catch {
      // Partial or non-JSON SSE data line; forward raw bytes untouched
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          lineBuffer += decoder.decode();
          if (lineBuffer.trim()) {
            for (const line of lineBuffer.split(/\r?\n/)) inspectLine(line);
          }
          finalize();
          controller.close();
          return;
        }

        controller.enqueue(value);

        lineBuffer += decoder.decode(value, { stream: true });
        const lines = lineBuffer.split(/\r?\n/);
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) {
          inspectLine(line);
        }
      } catch (err) {
        finalize();
        controller.error(err);
      }
    },
    async cancel(reason) {
      finalize();
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

export interface ProxyAppOptions {
  state: BurnCapState;
  internalMockToken: string;
  getProxyPort: () => number;
}

export function createProxyApp(options: ProxyAppOptions): Hono {
  const { state, internalMockToken, getProxyPort } = options;
  const app = new Hono();

  app.get("/health", (c) => {
    return c.json({
      ok: true,
      service: "burncap-proxy",
      mockMode: state.settings.mockMode,
      circuitStatus: state.circuit.status,
      upstreamUrl: state.settings.upstreamUrl,
    });
  });

  app.post("/api/simulate-traffic", async (c) => {
    const summary = await runDemoTrafficBurst({
      proxyBaseUrl: `http://127.0.0.1:${getProxyPort()}`,
      state,
      internalMockToken,
    });
    return c.json(summary, summary.started ? 200 : 409);
  });

  const handleModels = async (c: Context) => {
    if (state.settings.mockMode) {
      return c.json({
        object: "list",
        data: [
          { id: "anthropic/claude-sonnet-4.5", object: "model" },
          { id: "anthropic/claude-haiku-4.5", object: "model" },
          { id: "google/gemini-2.5-flash", object: "model" },
          { id: "openai/gpt-4.1", object: "model" },
          { id: "openai/gpt-4.1-mini", object: "model" },
          { id: "deepseek/deepseek-chat", object: "model" },
        ],
      });
    }
    const target = buildUpstreamUrl(resolveUpstreamBaseUrl(c, "openai", state), "/v1/models");
    const res = await fetch(target, { headers: buildForwardHeaders(c) });
    return new Response(res.body, { status: res.status, headers: res.headers });
  };

  app.get("/v1/models", handleModels);
  app.get("/api/v1/models", handleModels);

  const handleCompletion = async (c: Context, format: ApiFormat, canonicalEndpoint: string) => {
    const startedAt = Date.now();
    const requestId = `req_${crypto.randomUUID().slice(0, 8)}`;

    let rawBody: Record<string, unknown>;
    try {
      rawBody = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json(
        {
          type: "error",
          error: {
            message: "[BurnCap] Invalid JSON request body.",
            type: "invalid_request_error",
          },
        },
        400
      );
    }

    const upstreamBase = resolveUpstreamBaseUrl(c, format, state);
    const useMock =
      state.settings.mockMode ||
      c.req.header("x-burncap-internal-mock") === internalMockToken;
    const resolvedTargetUrl = useMock
      ? `mock://offline-upstream${canonicalEndpoint}`
      : buildUpstreamUrl(upstreamBase, canonicalEndpoint);

    const forwardHeaders = buildForwardHeaders(c);
    const redactedHeaders = buildRedactedHeaders(forwardHeaders);
    const hasAnthropicApiKey = Boolean(c.req.header("x-api-key")?.trim());

    const preview = extractPromptPreview(format, rawBody);
    const incomingModel =
      typeof rawBody.model === "string" && rawBody.model.trim() ? rawBody.model.trim() : "unknown";

    // 1. Firewall check
    const tFwStart = performance.now();
    const firewall = checkFirewallBeforeUpstream(state, format, rawBody, startedAt);
    const firewallMs = Math.max(0, Math.round((performance.now() - tFwStart) * 10) / 10);

    if (!firewall.allowed) {
      const totalMs = Math.max(1, Date.now() - startedAt);
      const details: RequestInspectionDetails = {
        upstreamUrl: resolvedTargetUrl,
        redactedHeaders,
        latencyBreakdown: {
          firewallMs,
          optimizerMs: 0,
          upstreamMs: 0,
          totalMs,
        },
        loopInspection: firewall.loopInspection,
      };

      const blockedEntry: RequestLogEntry = {
        id: requestId,
        timestamp: startedAt,
        format,
        endpoint: canonicalEndpoint,
        status: firewall.status,
        wasSlimmed: false,
        wasRerouted: false,
        streaming: Boolean(rawBody.stream),
        originalModel: incomingModel,
        routedModel: incomingModel,
        inputTokens: 0,
        originalInputTokens: 0,
        outputTokens: 0,
        tokensShaved: 0,
        costUsd: 0,
        savedUsd: 0,
        latencyMs: totalMs,
        httpStatus: firewall.httpStatus,
        promptPreview: preview,
        notes: [firewall.message],
        details,
      };
      state.recordRequest(blockedEntry);

      return c.json(firewall.errorBody, firewall.httpStatus, {
        ...buildBurnCapHeaders(firewall.status, incomingModel, incomingModel, 0),
        "retry-after": "30",
      });
    }

    // 2. Cache-Safe Context Slimmer + Provider-Aware Smart Router
    const tOptStart = performance.now();
    const opt = optimizeRequestPayload(format, rawBody, state.settings, {
      upstreamUrl: upstreamBase,
      hasAnthropicApiKey,
    });
    const optimizerMs = Math.max(0, Math.round((performance.now() - tOptStart) * 10) / 10);

    const primaryStatus = deriveStatus(opt.wasRerouted, opt.wasSlimmed);
    const isStreaming = Boolean(opt.body.stream);

    const buildDetails = (
      upstreamMs: number,
      totalMs: number,
      finalInTokens: number,
      finalOutTokens: number,
      baselineCostUsd: number,
      actualCostUsd: number,
      savedUsd: number
    ): RequestInspectionDetails => ({
      upstreamUrl: resolvedTargetUrl,
      redactedHeaders,
      latencyBreakdown: {
        firewallMs,
        optimizerMs,
        upstreamMs: Math.max(0, upstreamMs),
        totalMs,
      },
      tokenMath: {
        originalInputTokens: Math.max(opt.originalInputTokens, finalInTokens + opt.tokensShaved),
        slimmedInputTokens: finalInTokens,
        tokensShaved: opt.tokensShaved,
        outputTokens: finalOutTokens,
        originalModelCostUsd: baselineCostUsd,
        actualCostUsd,
        savedUsd,
        cacheProtectedMessages: opt.cacheProtectedMessages,
      },
      slimmedDiffs: opt.slimmedDiffs.length > 0 ? opt.slimmedDiffs : undefined,
      dedupedSystemCount: opt.dedupedSystemCount || undefined,
    });

    // 3. Dispatch upstream
    const tUpstreamStart = Date.now();
    let upstreamResponse: Response;
    try {
      if (useMock) {
        upstreamResponse = await createMockUpstreamResponse(
          format,
          opt.body,
          opt.slimmedInputTokens
        );
      } else {
        upstreamResponse = await fetch(resolvedTargetUrl, {
          method: "POST",
          headers: forwardHeaders,
          body: JSON.stringify(opt.body),
          signal: c.req.raw.signal,
        });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const totalMs = Math.max(1, Date.now() - startedAt);
      state.recordRequest({
        id: requestId,
        timestamp: startedAt,
        format,
        endpoint: canonicalEndpoint,
        status: primaryStatus,
        wasSlimmed: opt.wasSlimmed,
        wasRerouted: opt.wasRerouted,
        streaming: isStreaming,
        originalModel: opt.originalModel,
        routedModel: opt.routedModel,
        inputTokens: opt.slimmedInputTokens,
        originalInputTokens: opt.originalInputTokens,
        outputTokens: 0,
        tokensShaved: opt.tokensShaved,
        costUsd: 0,
        savedUsd: 0,
        latencyMs: totalMs,
        httpStatus: 502,
        promptPreview: preview,
        notes: [...opt.notes, `Upstream fetch error: ${errMsg}`],
        details: buildDetails(
          Date.now() - tUpstreamStart,
          totalMs,
          opt.slimmedInputTokens,
          0,
          0,
          0,
          0
        ),
      });

      return c.json(
        {
          type: "error",
          error: {
            message: `[BurnCap Proxy] Failed reaching upstream (${upstreamBase}): ${errMsg}`,
            type: "upstream_connection_error",
          },
        },
        502
      );
    }

    const outHeaders = new Headers();
    upstreamResponse.headers.forEach((value, key) => {
      if (!SKIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) {
        outHeaders.set(key, value);
      }
    });
    for (const [k, v] of Object.entries(
      buildBurnCapHeaders(primaryStatus, opt.originalModel, opt.routedModel, opt.tokensShaved)
    )) {
      outHeaders.set(k, v);
    }

    const upstreamContentType = upstreamResponse.headers.get("content-type") ?? "";
    const isSseResponse =
      upstreamResponse.ok &&
      upstreamResponse.body !== null &&
      (upstreamContentType.includes("text/event-stream") ||
        (!upstreamContentType && isStreaming));

    if (isSseResponse && upstreamResponse.body) {
      const tappedStream = createSseTapStream(upstreamResponse.body, format, (stats) => {
        const now = Date.now();
        const totalMs = Math.max(1, now - startedAt);
        const upstreamMs = Math.max(0, now - tUpstreamStart);

        const finalInputTokens = stats.inputTokens ?? opt.slimmedInputTokens;
        const finalOutputTokens =
          stats.outputTokens ?? (stats.streamedText ? estimateTokensFromText(stats.streamedText) : 0);

        const actualCostUsd = calculateCostUsd(
          opt.routedModel,
          finalInputTokens,
          finalOutputTokens
        ).totalCostUsd;

        const baselineInput = Math.max(opt.originalInputTokens, finalInputTokens + opt.tokensShaved);
        const baselineCostUsd = calculateCostUsd(
          opt.originalModel,
          baselineInput,
          finalOutputTokens
        ).totalCostUsd;
        const savedUsd = Math.max(0, baselineCostUsd - actualCostUsd);

        state.recordRequest({
          id: requestId,
          timestamp: startedAt,
          format,
          endpoint: canonicalEndpoint,
          status: primaryStatus,
          wasSlimmed: opt.wasSlimmed,
          wasRerouted: opt.wasRerouted,
          streaming: true,
          originalModel: opt.originalModel,
          routedModel: opt.routedModel,
          inputTokens: finalInputTokens,
          originalInputTokens: baselineInput,
          outputTokens: finalOutputTokens,
          tokensShaved: opt.tokensShaved,
          costUsd: actualCostUsd,
          savedUsd,
          latencyMs: totalMs,
          httpStatus: upstreamResponse.status,
          promptPreview: preview,
          notes: opt.notes,
          details: buildDetails(
            upstreamMs,
            totalMs,
            finalInputTokens,
            finalOutputTokens,
            baselineCostUsd,
            actualCostUsd,
            savedUsd
          ),
        });
      });

      return new Response(tappedStream, {
        status: upstreamResponse.status,
        headers: outHeaders,
      });
    }

    const responseText = await upstreamResponse.text();
    const now = Date.now();
    const totalMs = Math.max(1, now - startedAt);
    const upstreamMs = Math.max(0, now - tUpstreamStart);

    let parsedJson: unknown = null;
    try {
      parsedJson = JSON.parse(responseText);
    } catch {
      parsedJson = null;
    }

    if (!upstreamResponse.ok) {
      state.recordRequest({
        id: requestId,
        timestamp: startedAt,
        format,
        endpoint: canonicalEndpoint,
        status: primaryStatus,
        wasSlimmed: opt.wasSlimmed,
        wasRerouted: opt.wasRerouted,
        streaming: false,
        originalModel: opt.originalModel,
        routedModel: opt.routedModel,
        inputTokens: opt.slimmedInputTokens,
        originalInputTokens: opt.originalInputTokens,
        outputTokens: 0,
        tokensShaved: opt.tokensShaved,
        costUsd: 0,
        savedUsd: 0,
        latencyMs: totalMs,
        httpStatus: upstreamResponse.status,
        promptPreview: preview,
        notes: [...opt.notes, `Upstream returned HTTP ${upstreamResponse.status}`],
        details: buildDetails(
          upstreamMs,
          totalMs,
          opt.slimmedInputTokens,
          0,
          0,
          0,
          0
        ),
      });

      return new Response(responseText, {
        status: upstreamResponse.status,
        headers: outHeaders,
      });
    }

    const usage = extractUsageFromJson(format, parsedJson);
    const fallbackOutText = extractCompletionTextFromJson(format, parsedJson);
    const finalInputTokens = usage.inputTokens ?? opt.slimmedInputTokens;
    const finalOutputTokens =
      usage.outputTokens ?? (fallbackOutText ? estimateTokensFromText(fallbackOutText) : 0);

    const actualCostUsd = calculateCostUsd(
      opt.routedModel,
      finalInputTokens,
      finalOutputTokens
    ).totalCostUsd;
    const baselineInput = Math.max(opt.originalInputTokens, finalInputTokens + opt.tokensShaved);
    const baselineCostUsd = calculateCostUsd(
      opt.originalModel,
      baselineInput,
      finalOutputTokens
    ).totalCostUsd;
    const savedUsd = Math.max(0, baselineCostUsd - actualCostUsd);

    state.recordRequest({
      id: requestId,
      timestamp: startedAt,
      format,
      endpoint: canonicalEndpoint,
      status: primaryStatus,
      wasSlimmed: opt.wasSlimmed,
      wasRerouted: opt.wasRerouted,
      streaming: false,
      originalModel: opt.originalModel,
      routedModel: opt.routedModel,
      inputTokens: finalInputTokens,
      originalInputTokens: baselineInput,
      outputTokens: finalOutputTokens,
      tokensShaved: opt.tokensShaved,
      costUsd: actualCostUsd,
      savedUsd,
      latencyMs: totalMs,
      httpStatus: upstreamResponse.status,
      promptPreview: preview,
      notes: opt.notes,
      details: buildDetails(
        upstreamMs,
        totalMs,
        finalInputTokens,
        finalOutputTokens,
        baselineCostUsd,
        actualCostUsd,
        savedUsd
      ),
    });

    return new Response(responseText, {
      status: upstreamResponse.status,
      headers: outHeaders,
    });
  };

  app.post("/v1/chat/completions", (c) => handleCompletion(c, "openai", "/v1/chat/completions"));
  app.post("/api/v1/chat/completions", (c) => handleCompletion(c, "openai", "/v1/chat/completions"));
  app.post("/chat/completions", (c) => handleCompletion(c, "openai", "/v1/chat/completions"));

  app.post("/v1/messages", (c) => handleCompletion(c, "anthropic", "/v1/messages"));
  app.post("/messages", (c) => handleCompletion(c, "anthropic", "/v1/messages"));

  app.notFound((c) => {
    return c.json(
      {
        error: {
          message: `[BurnCap Proxy] Unsupported endpoint ${c.req.method} ${c.req.path}. Supported: POST /v1/chat/completions, POST /v1/messages.`,
          type: "not_found",
        },
      },
      404
    );
  });

  return app;
}
