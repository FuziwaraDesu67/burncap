import type { ApiFormat, BurnCapState } from "./state.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractLastUserText(format: ApiFormat, body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i] as Record<string, unknown> | undefined;
    if (!m) continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      const texts = m.content
        .map((p) =>
          p && typeof p === "object" && typeof (p as Record<string, unknown>).text === "string"
            ? ((p as Record<string, unknown>).text as string)
            : typeof (p as Record<string, unknown>)?.content === "string"
            ? ((p as Record<string, unknown>).content as string)
            : ""
        )
        .filter(Boolean);
      if (texts.length > 0) return texts.join("\n");
    }
  }
  return format === "anthropic" ? String(body.system ?? "") : "";
}

function generateRealisticMockText(format: ApiFormat, body: Record<string, unknown>): string {
  const prompt = extractLastUserText(format, body);
  const lower = prompt.toLowerCase();

  if (/\btitle\b/.test(lower)) {
    return "API Rate Limiter & Auth Middleware";
  }
  if (/\bsummariz|summary|tl;?dr\b/.test(lower)) {
    return "Summary: Updated Hono proxy middleware, verified streaming SSE chunk forwarding, and tightened error handling around upstream timeouts.";
  }
  if (/econnrefused|typeerror|traceback|webpack|vitest|jest|error:|failed/i.test(lower)) {
    return (
      "Root cause identified from the stack trace:\n\n" +
      "1. The failing module attempts to access a property before the async pool/config finishes initializing.\n" +
      "2. Add an explicit readiness check and surface a structured fallback instead of throwing during startup:\n\n" +
      "```ts\n" +
      "const client = await pool.connect();\n" +
      "if (!client) throw new Error('Database pool unavailable');\n" +
      "```"
    );
  }

  return (
    "Here is a minimal sliding-window rate limiter middleware for Hono:\n\n" +
    "```ts\n" +
    "export function rateLimiter(limit = 60, windowMs = 60_000) {\n" +
    "  const hits = new Map<string, number[]>();\n" +
    "  return async (c, next) => {\n" +
    "    const ip = c.req.header('x-forwarded-for') ?? 'local';\n" +
    "    const now = Date.now();\n" +
    "    const recent = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);\n" +
    "    if (recent.length >= limit) return c.json({ error: 'Rate limit exceeded' }, 429);\n" +
    "    recent.push(now);\n" +
    "    hits.set(ip, recent);\n" +
    "    await next();\n" +
    "  };\n" +
    "}\n" +
    "```"
  );
}

function splitIntoChunks(text: string): string[] {
  const tokens = text.match(/\S+\s*/g) ?? [text];
  const chunks: string[] = [];
  for (let i = 0; i < tokens.length; i += 2) {
    chunks.push(tokens.slice(i, i + 2).join(""));
  }
  return chunks;
}

export async function createMockUpstreamResponse(
  format: ApiFormat,
  body: Record<string, unknown>,
  inputTokens: number
): Promise<Response> {
  const model = typeof body.model === "string" && body.model ? body.model : "mock-model";
  const replyText = generateRealisticMockText(format, body);
  const chunks = splitIntoChunks(replyText);
  const outputTokens = Math.max(8, Math.ceil(replyText.length / 4));
  const isStream = Boolean(body.stream);
  const idSuffix = Math.random().toString(36).slice(2, 10);

  if (!isStream) {
    await sleep(90 + Math.floor(Math.random() * 110));
    if (format === "anthropic") {
      return new Response(
        JSON.stringify({
          id: `msg_mock_${idSuffix}`,
          type: "message",
          role: "assistant",
          model,
          content: [{ type: "text", text: replyText }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      );
    }

    return new Response(
      JSON.stringify({
        id: `chatcmpl_mock_${idSuffix}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: replyText },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: inputTokens,
          completion_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (str: string) => controller.enqueue(encoder.encode(str));
      try {
        await sleep(35 + Math.floor(Math.random() * 45));

        if (format === "anthropic") {
          push(
            `event: message_start\ndata: ${JSON.stringify({
              type: "message_start",
              message: {
                id: `msg_mock_${idSuffix}`,
                type: "message",
                role: "assistant",
                content: [],
                model,
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: inputTokens, output_tokens: 0 },
              },
            })}\n\n`
          );
          push(
            `event: content_block_start\ndata: ${JSON.stringify({
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            })}\n\n`
          );

          for (const chunk of chunks) {
            await sleep(10 + Math.floor(Math.random() * 16));
            push(
              `event: content_block_delta\ndata: ${JSON.stringify({
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: chunk },
              })}\n\n`
            );
          }

          push(
            `event: content_block_stop\ndata: ${JSON.stringify({
              type: "content_block_stop",
              index: 0,
            })}\n\n`
          );
          push(
            `event: message_delta\ndata: ${JSON.stringify({
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: outputTokens },
            })}\n\n`
          );
          push(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
        } else {
          const created = Math.floor(Date.now() / 1000);
          const id = `chatcmpl_mock_${idSuffix}`;

          push(
            `data: ${JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
            })}\n\n`
          );

          for (const chunk of chunks) {
            await sleep(10 + Math.floor(Math.random() * 16));
            push(
              `data: ${JSON.stringify({
                id,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
              })}\n\n`
            );
          }

          push(
            `data: ${JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: {
                prompt_tokens: inputTokens,
                completion_tokens: outputTokens,
                total_tokens: inputTokens + outputTokens,
              },
            })}\n\n`
          );
          push("data: [DONE]\n\n");
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

function buildMassiveStackTrace(): string {
  const header =
    "Command output: npm test -- src/auth/session.test.ts\n" +
    "FAIL src/auth/session.test.ts\n" +
    "  ● SessionMiddleware › validates JWT rotation under concurrent refresh\n\n" +
    "    TypeError: Cannot read properties of undefined (reading 'verifyToken')\n" +
    "      at verifySession (D:/repo/apps/api/src/auth/session.ts:84:19)\n" +
    "      at processTicksAndRejections (node:internal/process/task_queues:105:5)\n\n";

  const noisyFrames = Array.from({ length: 145 }, (_, idx) => {
    const fileNum = (idx % 28) + 1;
    return `      at Layer${idx}.handleRequest (D:/repo/node_modules/.pnpm/hono@4.7.10/node_modules/hono/dist/compose-${fileNum}.js:${120 + idx}:14)`;
  }).join("\n");

  const footer =
    "\n\nTest Suites: 1 failed, 1 total\n" +
    "Tests:       1 failed, 14 passed, 15 total\n" +
    "Snapshots:   0 total\n" +
    "Time:        2.418 s\n" +
    "Exit code:   1";

  return header + noisyFrames + footer;
}

let simulationActive = false;

export interface SimulationSummary {
  started: boolean;
  stepsExecuted: number;
  statuses: Array<{ step: string; httpStatus: number; burncapStatus: string }>;
}

export async function runDemoTrafficBurst(options: {
  proxyBaseUrl: string;
  state: BurnCapState;
  internalMockToken: string;
}): Promise<SimulationSummary> {
  if (simulationActive) {
    return { started: false, stepsExecuted: 0, statuses: [] };
  }

  simulationActive = true;
  const results: Array<{ step: string; httpStatus: number; burncapStatus: string }> = [];

  try {
    // Reset if a previous demo left the breaker tripped so the demo is cleanly repeatable
    if (options.state.circuit.status === "TRIPPED") {
      options.state.resetCircuitBreaker();
    } else {
      options.state.loopHistory = [];
      options.state.updateLoopTracking(0, null);
    }

    const fire = async (
      step: string,
      path: string,
      body: Record<string, unknown>,
      extraHeaders: Record<string, string> = {}
    ) => {
      const res = await fetch(`${options.proxyBaseUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-burncap-internal-mock": options.internalMockToken,
          ...extraHeaders,
        },
        body: JSON.stringify(body),
      });
      // Drain streaming/JSON body completely so SSE tap finalizes and emits metrics
      await res.text();
      const burncapStatus = res.headers.get("x-burncap-status") ?? `HTTP ${res.status}`;
      results.push({ step, httpStatus: res.status, burncapStatus });
    };

    // 1. Normal coding request with tools -> PASSED
    await fire(
      "Normal coding request",
      "/v1/messages",
      {
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        stream: true,
        system: "You are a senior TypeScript systems engineer.",
        tools: [
          {
            name: "edit_file",
            description: "Edit a file on disk",
            input_schema: { type: "object", properties: { path: { type: "string" } } },
          },
        ],
        messages: [
          {
            role: "user",
            content: "Write a clean sliding-window rate limiter middleware for our Hono proxy gateway.",
          },
        ],
      },
      { "x-api-key": "sk-ant-api03-demo-0000000000000000demo", "anthropic-version": "2023-06-01" }
    );
    await sleep(220);

    // 2. Auxiliary title generation on OpenRouter format -> REROUTED to google/gemini-2.5-flash
    await fire(
      "Chat title generation",
      "/v1/chat/completions",
      {
        model: "openai/gpt-4.1",
        stream: true,
        messages: [
          { role: "system", content: "Generate a concise 4-word title for this chat session." },
          { role: "user", content: "User asked to implement a Hono rate limiter middleware." },
        ],
      },
      { authorization: "Bearer sk-or-v1-demo0000000000000000demo" }
    );
    await sleep(220);

    // 3. Duplicate system blocks + huge 11k+ stack trace -> SLIMMED
    const dupSystem =
      "You are an autonomous coding agent operating inside a TypeScript monorepo. Follow strict type safety and never invent dependencies.";
    await fire(
      "Oversized stack trace + duplicate system",
      "/v1/chat/completions",
      {
        model: "anthropic/claude-sonnet-4.5",
        stream: true,
        tools: [
          {
            type: "function",
            function: {
              name: "run_tests",
              description: "Run test suite",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        messages: [
          { role: "system", content: dupSystem },
          { role: "system", content: dupSystem },
          { role: "user", content: "Run the auth test suite and fix the failing assertion." },
          { role: "tool", tool_call_id: "call_test_991", content: buildMassiveStackTrace() },
        ],
      },
      { authorization: "Bearer sk-or-v1-demo0000000000000000demo" }
    );
    await sleep(220);

    // 4. Native Anthropic auxiliary conversation summary (with x-api-key) -> REROUTED strictly to claude-haiku-4-5
    await fire(
      "Anthropic history summarization",
      "/v1/messages",
      {
        model: "claude-sonnet-4-5",
        max_tokens: 256,
        stream: false,
        messages: [
          {
            role: "user",
            content:
              "Summarize this conversation in 2 sentences: We added rate limiting, diagnosed verifyToken undefined error in session.ts, and updated middleware.",
          },
        ],
      },
      { "x-api-key": "sk-ant-api03-demo-0000000000000000demo", "anthropic-version": "2023-06-01" }
    );
    await sleep(220);

    // 5-7. Runaway agent loop: identical failing tool output repeated 3x within 60s -> BLOCKED: LOOP
    const failingToolErr =
      "Error: ECONNREFUSED 127.0.0.1:5432 - Postgres connection failed in connectPool (src/db/pool.ts:88). Exit code 1.";

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await fire(
        `Loop retry #${attempt}`,
        "/v1/chat/completions",
        {
          model: "openai/gpt-4.1",
          stream: true,
          tools: [
            {
              type: "function",
              function: {
                name: "run_migration",
                description: "Execute DB migration",
                parameters: { type: "object", properties: {} },
              },
            },
          ],
          messages: [
            { role: "user", content: "Run the database migration script and verify schema." },
            {
              role: "tool",
              tool_call_id: `call_db_retry_${attempt}`,
              content: failingToolErr,
            },
          ],
        },
        { authorization: "Bearer sk-or-v1-demo0000000000000000demo" }
      );
      if (attempt < 3) await sleep(220);
    }

    return {
      started: true,
      stepsExecuted: results.length,
      statuses: results,
    };
  } finally {
    simulationActive = false;
  }
}
