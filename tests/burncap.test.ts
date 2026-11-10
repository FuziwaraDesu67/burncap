import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkFirewallBeforeUpstream } from "../src/firewall.js";
import { startBurnCap } from "../src/index.js";
import {
  optimizeRequestPayload,
  resolveTargetCheapModel,
  TRUNCATION_MARKER,
} from "../src/optimizer.js";
import { calculateCostUsd } from "../src/pricing.js";
import { buildUpstreamUrl } from "../src/proxy.js";
import { BurnCapState, DEFAULT_SETTINGS } from "../src/state.js";

test("buildUpstreamUrl avoids doubling /v1", () => {
  assert.equal(
    buildUpstreamUrl("https://openrouter.ai/api", "/v1/chat/completions"),
    "https://openrouter.ai/api/v1/chat/completions"
  );
  assert.equal(
    buildUpstreamUrl("https://openrouter.ai/api/v1", "/v1/chat/completions"),
    "https://openrouter.ai/api/v1/chat/completions"
  );
  assert.equal(
    buildUpstreamUrl("https://api.anthropic.com/", "/v1/messages"),
    "https://api.anthropic.com/v1/messages"
  );
});

test("Context Slimmer deduplicates consecutive system blocks and truncates >4000 char tool outputs", () => {
  const bigHead = "A".repeat(1600);
  const bigMiddle = "M".repeat(3000);
  const bigTail = "Z".repeat(1600);
  const bigToolOutput = bigHead + bigMiddle + bigTail; // 6200 chars

  const openaiResult = optimizeRequestPayload(
    "openai",
    {
      model: "anthropic/claude-3-7-sonnet",
      tools: [{ type: "function", function: { name: "bash" } }],
      messages: [
        { role: "system", content: "You are a disciplined TypeScript agent." },
        { role: "system", content: "You are a disciplined   TypeScript agent." },
        { role: "user", content: "Run tests and fix failures." },
        { role: "tool", tool_call_id: "call_1", content: bigToolOutput },
      ],
    },
    DEFAULT_SETTINGS
  );

  assert.equal(openaiResult.wasSlimmed, true);
  assert.equal(openaiResult.wasRerouted, false); // tools present
  assert.ok(openaiResult.tokensShaved > 500);

  const msgs = openaiResult.body.messages as Array<{ role: string; content: string }>;
  assert.equal(msgs.length, 3); // duplicate consecutive system message removed
  assert.ok(msgs[2].content.startsWith("A".repeat(1500)));
  assert.ok(msgs[2].content.endsWith("Z".repeat(1500)));
  assert.ok(msgs[2].content.includes(TRUNCATION_MARKER));

  // Anthropic tool_result + system array dedupe
  const anthropicResult = optimizeRequestPayload(
    "anthropic",
    {
      model: "claude-3-7-sonnet-20250219",
      system: [
        { type: "text", text: "System instruction block A" },
        { type: "text", text: "System instruction block A" },
      ],
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: bigToolOutput }],
        },
      ],
    },
    DEFAULT_SETTINGS
  );

  assert.equal(anthropicResult.wasSlimmed, true);
  assert.equal((anthropicResult.body.system as unknown[]).length, 1);
  const anthropicMsgs = anthropicResult.body.messages as Array<{
    content: Array<{ content: string }>;
  }>;
  assert.ok(anthropicMsgs[0].content[0].content.includes(TRUNCATION_MARKER));
});

test("Smart Model Router downgrades auxiliary and <300 token tool-free prompts", () => {
  const routed = optimizeRequestPayload(
    "openai",
    {
      model: "openai/gpt-4o",
      messages: [
        { role: "system", content: "Generate a short title for this chat." },
        { role: "user", content: "User implemented Hono SSE proxy." },
      ],
    },
    DEFAULT_SETTINGS
  );

  assert.equal(routed.wasRerouted, true);
  assert.equal(routed.originalModel, "openai/gpt-4o");
  assert.equal(routed.routedModel, "anthropic/claude-haiku-4.5");

  const keptWithTools = optimizeRequestPayload(
    "openai",
    {
      model: "openai/gpt-4.1",
      tools: [{ type: "function", function: { name: "write_file" } }],
      messages: [{ role: "user", content: "Fix bug" }],
    },
    DEFAULT_SETTINGS
  );
  assert.equal(keptWithTools.wasRerouted, false);
  assert.equal(keptWithTools.routedModel, "openai/gpt-4.1");
});

test("Provider-aware smart routing enforces native Haiku for x-api-key and provider/model prefix for OpenRouter", () => {
  // /v1/messages with x-api-key MUST downgrade strictly to claude-haiku-4-5 even when cheapModel is google/gemini-2.5-flash
  const nativeAnthropicTarget = resolveTargetCheapModel(
    "google/gemini-2.5-flash",
    "https://openrouter.ai/api",
    "anthropic",
    true
  );
  assert.equal(nativeAnthropicTarget, "claude-haiku-4-5");

  const routedNativeAnthropic = optimizeRequestPayload(
    "anthropic",
    {
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "Summarize this chat in 1 sentence." }],
    },
    { ...DEFAULT_SETTINGS, cheapModel: "openai/gpt-4.1-mini" },
    { upstreamUrl: "https://openrouter.ai/api", hasAnthropicApiKey: true }
  );
  assert.equal(routedNativeAnthropic.wasRerouted, true);
  assert.equal(routedNativeAnthropic.routedModel, "claude-haiku-4-5");

  // OpenRouter upstream MUST always include provider/model prefix
  assert.equal(
    resolveTargetCheapModel("gemini-2.5-flash", "https://openrouter.ai/api", "openai", false),
    "google/gemini-2.5-flash"
  );
  assert.equal(
    resolveTargetCheapModel("claude-haiku-4-5", "https://openrouter.ai/api", "openai", false),
    "anthropic/claude-haiku-4.5"
  );
  assert.equal(
    resolveTargetCheapModel("gpt-4.1-mini", "https://openrouter.ai/api", "openai", false),
    "openai/gpt-4.1-mini"
  );
  assert.equal(
    resolveTargetCheapModel("deepseek-chat", "https://openrouter.ai/api", "openai", false),
    "deepseek/deepseek-chat"
  );

  // Verify modern pricing lookup produces non-default accurate differentials
  const sonnetCost = calculateCostUsd("anthropic/claude-sonnet-4.5", 1_000_000, 0).totalCostUsd;
  const haikuCost = calculateCostUsd("anthropic/claude-haiku-4.5", 1_000_000, 0).totalCostUsd;
  const gpt41Cost = calculateCostUsd("openai/gpt-4.1", 1_000_000, 0).totalCostUsd;
  const gpt41MiniCost = calculateCostUsd("openai/gpt-4.1-mini", 1_000_000, 0).totalCostUsd;
  assert.ok(sonnetCost > haikuCost);
  assert.ok(gpt41Cost > gpt41MiniCost);
});

test("Cache-safe Context Slimmer preserves messages at or before last cache_control breakpoint", () => {
  const cachedBigOutput = "C".repeat(6000);
  const newBigOutput = "H".repeat(2000) + "M".repeat(2500) + "T".repeat(2000);

  const payload = {
    model: "claude-sonnet-4-5",
    system: [
      { type: "text", text: "System block A" },
      { type: "text", text: "System block A" }, // before messages cache breakpoint -> MUST NOT mutate
    ],
    tools: [{ name: "bash", input_schema: { type: "object" } }],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_cached",
            content: cachedBigOutput,
            cache_control: { type: "ephemeral" },
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Checking latest logs." }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_fresh",
            content: newBigOutput,
          },
        ],
      },
    ],
  };

  const run1 = optimizeRequestPayload("anthropic", payload, DEFAULT_SETTINGS);
  const run2 = optimizeRequestPayload("anthropic", payload, DEFAULT_SETTINGS);

  assert.equal(run1.wasSlimmed, true);
  assert.equal(run1.cacheProtectedMessages, 1);
  // System array was NOT deduplicated because message[0] has cache_control after system
  assert.equal((run1.body.system as unknown[]).length, 2);

  const msgs1 = run1.body.messages as Array<{ content: Array<{ content: string }> }>;
  const msgs2 = run2.body.messages as Array<{ content: Array<{ content: string }> }>;

  // Protected cached message[0] MUST remain exact 6000 chars
  assert.equal(msgs1[0].content[0].content.length, 6000);
  assert.equal(msgs1[0].content[0].content, cachedBigOutput);

  // Fresh incoming tool output at message[2] IS deterministically truncated
  assert.ok(msgs1[2].content[0].content.includes(TRUNCATION_MARKER));
  assert.equal(msgs1[2].content[0].content, msgs2[2].content[0].content);
  assert.equal(run1.slimmedDiffs.length, 1);
  assert.ok(run1.slimmedDiffs[0].removedMiddleSnippet.includes("M".repeat(100)));
});

test("Loop Detector trips on 3 consecutive repeats within 60s and recovers on reset", () => {
  const state = new BurnCapState({ disablePersistence: true });
  const t0 = 1_700_000_000_000;

  const makeReq = (callId: string, timeStr: string) => ({
    model: "openai/gpt-4o",
    messages: [
      { role: "user", content: "Run tests" },
      {
        role: "tool",
        tool_call_id: callId,
        content: `Error: TypeError at ${timeStr} failed in auth.ts:42`,
      },
    ],
  });

  const r1 = checkFirewallBeforeUpstream(state, "openai", makeReq("call_1", "10:00:01"), t0);
  assert.equal(r1.allowed, true);
  assert.equal(r1.loopStreak, 1);

  const r2 = checkFirewallBeforeUpstream(state, "openai", makeReq("call_2", "10:00:04"), t0 + 3000);
  assert.equal(r2.allowed, true);
  assert.equal(r2.loopStreak, 2);

  const r3 = checkFirewallBeforeUpstream(state, "openai", makeReq("call_3", "10:00:08"), t0 + 7000);
  assert.equal(r3.allowed, false);
  if (!r3.allowed) {
    assert.equal(r3.httpStatus, 429);
    assert.equal(r3.status, "BLOCKED: LOOP");
  }
  assert.equal(state.circuit.status, "TRIPPED");

  // Reset restores HEALTHY
  state.resetCircuitBreaker();
  assert.equal(state.circuit.status, "HEALTHY");
  const rAfterReset = checkFirewallBeforeUpstream(
    state,
    "openai",
    makeReq("call_4", "10:00:15"),
    t0 + 14000
  );
  assert.equal(rAfterReset.allowed, true);
});

test("Budget Circuit Breaker trips when spend cap exceeded and resets cleanly", () => {
  const state = new BurnCapState({
    disablePersistence: true,
    initialSettings: { sessionBudgetUsd: 0.25, windowBudgetUsd: 0.5 },
  });

  state.recordRequest({
    id: "req_1",
    timestamp: Date.now(),
    format: "openai",
    endpoint: "/v1/chat/completions",
    status: "PASSED",
    wasSlimmed: false,
    wasRerouted: false,
    streaming: false,
    originalModel: "claude-3-7-sonnet",
    routedModel: "claude-3-7-sonnet",
    inputTokens: 10000,
    originalInputTokens: 10000,
    outputTokens: 15000,
    tokensShaved: 0,
    costUsd: 0.26,
    savedUsd: 0,
    latencyMs: 120,
    httpStatus: 200,
    promptPreview: "expensive call",
    notes: [],
  });

  const blocked = checkFirewallBeforeUpstream(state, "openai", {
    model: "claude-3-7-sonnet",
    messages: [{ role: "user", content: "Another turn" }],
  });
  assert.equal(blocked.allowed, false);
  if (!blocked.allowed) {
    assert.equal(blocked.httpStatus, 402);
    assert.equal(blocked.status, "BLOCKED: BUDGET");
  }

  state.resetCircuitBreaker();
  assert.equal(state.circuit.status, "HEALTHY");
  const allowedAfterReset = checkFirewallBeforeUpstream(state, "openai", {
    model: "claude-3-7-sonnet",
    messages: [{ role: "user", content: "Fresh turn after reset" }],
  });
  assert.equal(allowedAfterReset.allowed, true);
});

test("End-to-end mock mode proxy, SSE dashboard events, and /api/simulate-traffic", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "burncap-test-"));
  const burncap = await startBurnCap({
    proxyPort: 0,
    dashboardPort: 0,
    mockMode: true,
    dataDir: tmpDir,
    quiet: true,
  });

  try {
    // 1. Dashboard serves HTML with slide-over drawer, modern model presets & footer copy pills
    const dashRes = await fetch(`http://127.0.0.1:${burncap.dashboardPort}/`);
    assert.equal(dashRes.status, 200);
    const html = await dashRes.text();
    assert.ok(html.includes("BurnCap"));
    assert.ok(html.includes("Live Request Inspector"));
    assert.ok(html.includes("inspectorDrawer"));
    assert.ok(html.includes('<option value="anthropic/claude-haiku-4.5" selected>'));
    assert.ok(html.includes("anthropic/claude-haiku-4.5"));
    assert.ok(html.includes("openai/gpt-4.1-mini"));
    assert.ok(html.includes("deepseek/deepseek-chat"));
    assert.ok(html.includes("copyOpenaiEnvBtn"));
    assert.ok(html.includes("copyAnthropicEnvBtn"));

    // 2. OpenAI streaming SSE request gets smart-routed to default anthropic/claude-haiku-4.5
    const openaiStreamRes = await fetch(
      `http://127.0.0.1:${burncap.proxyPort}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai/gpt-4o",
          stream: true,
          messages: [{ role: "user", content: "Write a short 3-word chat title." }],
        }),
      }
    );
    assert.equal(openaiStreamRes.status, 200);
    assert.equal(openaiStreamRes.headers.get("x-burncap-status"), "REROUTED");
    assert.equal(
      openaiStreamRes.headers.get("x-burncap-routed-model"),
      "anthropic/claude-haiku-4.5"
    );
    const sseBody = await openaiStreamRes.text();
    assert.ok(sseBody.includes("chat.completion.chunk"));
    assert.ok(sseBody.includes("data: [DONE]"));

    // 3. Anthropic streaming SSE request works
    const anthropicRes = await fetch(`http://127.0.0.1:${burncap.proxyPort}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-3-7-sonnet-20250219",
        stream: true,
        tools: [{ name: "read_file", input_schema: { type: "object" } }],
        messages: [{ role: "user", content: "Inspect server.ts" }],
      }),
    });
    assert.equal(anthropicRes.status, 200);
    assert.equal(anthropicRes.headers.get("x-burncap-status"), "PASSED");
    const anthropicSse = await anthropicRes.text();
    assert.ok(anthropicSse.includes("event: message_start"));
    assert.ok(anthropicSse.includes("event: message_stop"));

    // 4. Demo traffic endpoint runs full sequence and trips loop detector
    const simRes = await fetch(
      `http://127.0.0.1:${burncap.dashboardPort}/api/simulate-traffic`,
      { method: "POST" }
    );
    assert.equal(simRes.status, 200);
    const simJson = (await simRes.json()) as {
      started: boolean;
      stepsExecuted: number;
      statuses: Array<{ burncapStatus: string; httpStatus: number }>;
    };
    assert.equal(simJson.started, true);
    assert.equal(simJson.stepsExecuted, 7);
    assert.equal(simJson.statuses.at(-1)?.burncapStatus, "BLOCKED: LOOP");
    assert.equal(simJson.statuses.at(-1)?.httpStatus, 429);

    const stateRes = await fetch(`http://127.0.0.1:${burncap.dashboardPort}/api/state`);
    const snapshot = (await stateRes.json()) as {
      circuit: { status: string; reason: string };
      metrics: { totalTokensSlimmed: number; totalSavedUsd: number };
      logs: Array<{
        status: string;
        details?: {
          slimmedDiffs?: Array<{ removedMiddleSnippet: string }>;
          loopInspection?: { windowHash: string; repeatedPayload: string };
        };
      }>;
    };
    assert.equal(snapshot.circuit.status, "TRIPPED");
    assert.equal(snapshot.circuit.reason, "LOOP_DETECTED");
    assert.ok(snapshot.metrics.totalTokensSlimmed > 1000);
    assert.ok(snapshot.metrics.totalSavedUsd > 0);

    const slimmedEntry = snapshot.logs.find((l) => l.status === "SLIMMED");
    assert.ok(slimmedEntry?.details?.slimmedDiffs?.length);
    const blockedLoopEntry = snapshot.logs.find((l) => l.status === "BLOCKED: LOOP");
    assert.ok(blockedLoopEntry?.details?.loopInspection?.windowHash);
    assert.ok(blockedLoopEntry?.details?.loopInspection?.repeatedPayload.includes("ECONNREFUSED"));
  } finally {
    await burncap.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Live proxy preserves upstream headers and SSE tool_calls chunks byte-for-byte", async () => {
  const capturedRequests: Array<{
    url: string;
    headers: http.IncomingHttpHeaders;
    body: Record<string, unknown>;
  }> = [];

  const upstreamServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      capturedRequests.push({
        url: req.url ?? "",
        headers: req.headers,
        body,
      });

      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
      });

      const ssePayloads = [
        `data: ${JSON.stringify({
          id: "chatcmpl_live_1",
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_abc",
                    type: "function",
                    function: { name: "read_file", arguments: '{"path":' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "chatcmpl_live_1",
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '"src/index.ts"}' } }],
              },
              finish_reason: "tool_calls",
            },
          ],
        })}\n\n`,
        "data: [DONE]\n\n",
      ];

      for (const frame of ssePayloads) {
        res.write(frame);
      }
      res.end();
    });
  });

  await new Promise<void>((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (upstreamServer.address() as { port: number }).port;

  const burncap = await startBurnCap({
    proxyPort: 0,
    dashboardPort: 0,
    mockMode: false,
    upstreamUrl: `http://127.0.0.1:${upstreamPort}/api`,
    disablePersistence: true,
    quiet: true,
  });

  try {
    const res = await fetch(`http://127.0.0.1:${burncap.proxyPort}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sk-or-test-key",
        "x-api-key": "anth-test-key",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "anthropic/claude-3-7-sonnet",
        stream: true,
        tools: [{ type: "function", function: { name: "read_file" } }],
        messages: [{ role: "user", content: "Read src/index.ts" }],
      }),
    });

    assert.equal(res.status, 200);
    const bodyText = await res.text();
    assert.ok(bodyText.includes('"name":"read_file"'));
    assert.ok(bodyText.includes('{\\"path\\":'));
    assert.ok(bodyText.includes('\\"src/index.ts\\"}'));
    assert.ok(bodyText.includes("data: [DONE]"));

    assert.equal(capturedRequests.length, 1);
    assert.equal(capturedRequests[0].url, "/api/v1/chat/completions");
    assert.equal(capturedRequests[0].headers.authorization, "Bearer sk-or-test-key");
    assert.equal(capturedRequests[0].headers["x-api-key"], "anth-test-key");
    assert.equal(capturedRequests[0].headers["anthropic-version"], "2023-06-01");

    // Verify token counting & redacted forensic inspection details happened on the fly
    const logs = burncap.state.logs;
    assert.equal(logs.length, 1);
    assert.ok(logs[0].outputTokens > 0);
    assert.ok(logs[0].costUsd > 0);
    assert.equal(logs[0].details?.upstreamUrl, `http://127.0.0.1:${upstreamPort}/api/v1/chat/completions`);
    assert.ok(logs[0].details?.redactedHeaders.authorization.includes("***"));
    assert.ok(!logs[0].details?.redactedHeaders.authorization.includes("sk-or-test-key"));
    assert.ok(logs[0].details?.redactedHeaders["x-api-key"].includes("***"));
    assert.ok(!logs[0].details?.redactedHeaders["x-api-key"].includes("anth-test-key"));
  } finally {
    await burncap.close();
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
  }
});

test("Dashboard SSE /api/events, settings updates, and SQLite persistence across restarts", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "burncap-persist-"));
  const firstRun = await startBurnCap({
    proxyPort: 0,
    dashboardPort: 0,
    mockMode: true,
    dataDir: tmpDir,
    quiet: true,
  });

  try {
    assert.equal(firstRun.state.storageKind, "sqlite");

    // Connect to /api/events SSE stream and confirm init + live request event arrive
    const abortCtrl = new AbortController();
    const sseRes = await fetch(`http://127.0.0.1:${firstRun.dashboardPort}/api/events`, {
      signal: abortCtrl.signal,
    });
    assert.equal(sseRes.status, 200);
    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();

    const firstChunk = await reader.read();
    const initText = decoder.decode(firstChunk.value);
    assert.ok(initText.includes("event: init"));

    // Update settings via POST /api/settings
    const setRes = await fetch(`http://127.0.0.1:${firstRun.dashboardPort}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionBudgetUsd: 3.5, smartRouting: false }),
    });
    assert.equal(setRes.status, 200);

    // Send one request and confirm SSE emits a request event
    const reqRes = await fetch(`http://127.0.0.1:${firstRun.proxyPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-4o",
        stream: false,
        messages: [{ role: "user", content: "Say hello" }],
      }),
    });
    assert.equal(reqRes.status, 200);
    assert.equal(reqRes.headers.get("x-burncap-status"), "PASSED"); // smartRouting was turned off

    let collected = "";
    for (let i = 0; i < 6; i += 1) {
      const next = await reader.read();
      if (next.done) break;
      collected += decoder.decode(next.value);
      if (collected.includes("event: request")) break;
    }
    assert.ok(collected.includes("event: request"));
    abortCtrl.abort();
  } finally {
    await firstRun.close();
  }

  // Restart with the same dataDir and verify SQLite persisted settings & request logs
  const secondRun = await startBurnCap({
    proxyPort: 0,
    dashboardPort: 0,
    mockMode: true,
    dataDir: tmpDir,
    quiet: true,
  });
  try {
    const snap = secondRun.state.getSnapshot();
    assert.equal(snap.settings.sessionBudgetUsd, 3.5);
    assert.equal(snap.settings.smartRouting, false);
    assert.equal(snap.logs.length, 1);
    assert.equal(snap.metrics.totalRequests, 1);
  } finally {
    await secondRun.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Legacy claude-3-5-haiku-20241022 in SQLite auto-migrates to anthropic/claude-haiku-4.5", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "burncap-migrate-"));
  try {
    const legacyState = new BurnCapState({
      dataDir: tmpDir,
      initialSettings: { cheapModel: "claude-3-5-haiku-20241022" },
    });
    legacyState.close();

    const migratedState = new BurnCapState({ dataDir: tmpDir });
    assert.equal(migratedState.settings.cheapModel, "anthropic/claude-haiku-4.5");
    migratedState.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
