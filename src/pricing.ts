import type { ApiFormat } from "./state.js";

export interface ModelPrice {
  inputPer1M: number;
  outputPer1M: number;
  label: string;
}

interface PricingRule {
  match: string;
  price: ModelPrice;
}

// Ordered from most-specific to least-specific so mini/flash/haiku match before flagship families.
const PRICING_RULES: PricingRule[] = [
  { match: "gpt-4.1-nano", price: { inputPer1M: 0.1, outputPer1M: 0.4, label: "GPT-4.1 Nano" } },
  { match: "gpt-4.1-mini", price: { inputPer1M: 0.4, outputPer1M: 1.6, label: "GPT-4.1 Mini" } },
  { match: "gpt-4.1", price: { inputPer1M: 2.0, outputPer1M: 8.0, label: "GPT-4.1" } },
  { match: "gpt-4o-mini", price: { inputPer1M: 0.15, outputPer1M: 0.6, label: "GPT-4o Mini" } },
  { match: "gpt-4o", price: { inputPer1M: 2.5, outputPer1M: 10.0, label: "GPT-4o" } },
  { match: "gpt-4-turbo", price: { inputPer1M: 10.0, outputPer1M: 30.0, label: "GPT-4 Turbo" } },
  { match: "gpt-4", price: { inputPer1M: 10.0, outputPer1M: 30.0, label: "GPT-4" } },
  { match: "gpt-3.5-turbo", price: { inputPer1M: 0.5, outputPer1M: 1.5, label: "GPT-3.5 Turbo" } },
  { match: "o4-mini", price: { inputPer1M: 1.1, outputPer1M: 4.4, label: "o4-mini" } },
  { match: "o3-mini", price: { inputPer1M: 1.1, outputPer1M: 4.4, label: "o3-mini" } },
  { match: "o3-pro", price: { inputPer1M: 20.0, outputPer1M: 80.0, label: "o3-pro" } },
  { match: "o3", price: { inputPer1M: 2.0, outputPer1M: 8.0, label: "o3" } },
  { match: "o1-mini", price: { inputPer1M: 1.1, outputPer1M: 4.4, label: "o1-mini" } },
  { match: "o1", price: { inputPer1M: 15.0, outputPer1M: 60.0, label: "o1" } },
  { match: "claude-opus-4.5", price: { inputPer1M: 15.0, outputPer1M: 75.0, label: "Claude Opus 4.5" } },
  { match: "claude-opus-4-5", price: { inputPer1M: 15.0, outputPer1M: 75.0, label: "Claude Opus 4.5" } },
  { match: "claude-opus-4", price: { inputPer1M: 15.0, outputPer1M: 75.0, label: "Claude Opus 4" } },
  { match: "claude-3-opus", price: { inputPer1M: 15.0, outputPer1M: 75.0, label: "Claude 3 Opus" } },
  { match: "claude-sonnet-4.5", price: { inputPer1M: 3.0, outputPer1M: 15.0, label: "Claude Sonnet 4.5" } },
  { match: "claude-sonnet-4-5", price: { inputPer1M: 3.0, outputPer1M: 15.0, label: "Claude Sonnet 4.5" } },
  { match: "claude-sonnet-4", price: { inputPer1M: 3.0, outputPer1M: 15.0, label: "Claude Sonnet 4" } },
  { match: "claude-3-7-sonnet", price: { inputPer1M: 3.0, outputPer1M: 15.0, label: "Claude 3.7 Sonnet" } },
  { match: "claude-3.7-sonnet", price: { inputPer1M: 3.0, outputPer1M: 15.0, label: "Claude 3.7 Sonnet" } },
  { match: "claude-3-5-sonnet", price: { inputPer1M: 3.0, outputPer1M: 15.0, label: "Claude 3.5 Sonnet" } },
  { match: "claude-3.5-sonnet", price: { inputPer1M: 3.0, outputPer1M: 15.0, label: "Claude 3.5 Sonnet" } },
  { match: "claude-haiku-4.5", price: { inputPer1M: 1.0, outputPer1M: 5.0, label: "Claude Haiku 4.5" } },
  { match: "claude-haiku-4-5", price: { inputPer1M: 1.0, outputPer1M: 5.0, label: "Claude Haiku 4.5" } },
  { match: "claude-haiku-4", price: { inputPer1M: 0.8, outputPer1M: 4.0, label: "Claude Haiku 4" } },
  { match: "claude-3-5-haiku", price: { inputPer1M: 0.8, outputPer1M: 4.0, label: "Claude 3.5 Haiku" } },
  { match: "claude-3.5-haiku", price: { inputPer1M: 0.8, outputPer1M: 4.0, label: "Claude 3.5 Haiku" } },
  { match: "claude-3-haiku", price: { inputPer1M: 0.25, outputPer1M: 1.25, label: "Claude 3 Haiku" } },
  { match: "gemini-2.5-flash-lite", price: { inputPer1M: 0.075, outputPer1M: 0.3, label: "Gemini 2.5 Flash Lite" } },
  { match: "gemini-2.5-flash", price: { inputPer1M: 0.15, outputPer1M: 0.6, label: "Gemini 2.5 Flash" } },
  { match: "gemini-2.0-flash", price: { inputPer1M: 0.1, outputPer1M: 0.4, label: "Gemini 2.0 Flash" } },
  { match: "gemini-2.5-pro", price: { inputPer1M: 1.25, outputPer1M: 10.0, label: "Gemini 2.5 Pro" } },
  { match: "deepseek-r1", price: { inputPer1M: 0.55, outputPer1M: 2.19, label: "DeepSeek R1" } },
  { match: "deepseek-chat", price: { inputPer1M: 0.27, outputPer1M: 1.1, label: "DeepSeek Chat" } },
  { match: "deepseek-v3", price: { inputPer1M: 0.27, outputPer1M: 1.1, label: "DeepSeek V3" } },
  { match: "llama-3.3-70b", price: { inputPer1M: 0.12, outputPer1M: 0.3, label: "Llama 3.3 70B" } },
  { match: "qwen-2.5-coder", price: { inputPer1M: 0.15, outputPer1M: 0.6, label: "Qwen 2.5 Coder" } },
];

const DEFAULT_MODEL_PRICE: ModelPrice = {
  inputPer1M: 1.0,
  outputPer1M: 3.0,
  label: "Default Model",
};

const LIGHTWEIGHT_MODEL_PATTERN = /(mini|nano|haiku|flash|lite|:free|\b8b\b|\b7b\b|\b3b\b)/i;

export function normalizeModelId(model: string): string {
  const trimmed = model.trim().toLowerCase();
  const slashIdx = trimmed.indexOf("/");
  return slashIdx >= 0 ? trimmed.slice(slashIdx + 1) : trimmed;
}

export function getModelPricing(model: string): ModelPrice {
  if (!model) return DEFAULT_MODEL_PRICE;
  const lower = model.trim().toLowerCase();
  if (lower.endsWith(":free") || lower.includes(":free")) {
    return { inputPer1M: 0, outputPer1M: 0, label: model };
  }

  const normalized = normalizeModelId(lower);
  for (const rule of PRICING_RULES) {
    if (normalized.includes(rule.match) || lower.includes(rule.match)) {
      return rule.price;
    }
  }

  return DEFAULT_MODEL_PRICE;
}

export function calculateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number
): { inputCostUsd: number; outputCostUsd: number; totalCostUsd: number } {
  const price = getModelPricing(model);
  const safeIn = Math.max(0, inputTokens);
  const safeOut = Math.max(0, outputTokens);
  const inputCostUsd = (safeIn / 1_000_000) * price.inputPer1M;
  const outputCostUsd = (safeOut / 1_000_000) * price.outputPer1M;
  return {
    inputCostUsd,
    outputCostUsd,
    totalCostUsd: inputCostUsd + outputCostUsd,
  };
}

export function isExpensiveModel(model: string, cheapModel: string): boolean {
  if (!model) return false;
  if (normalizeModelId(model) === normalizeModelId(cheapModel)) return false;
  if (LIGHTWEIGHT_MODEL_PATTERN.test(model)) return false;

  const currentPrice = getModelPricing(model);
  const cheapPrice = getModelPricing(cheapModel);
  return currentPrice.inputPer1M + currentPrice.outputPer1M > cheapPrice.inputPer1M + cheapPrice.outputPer1M;
}

/**
 * Fast zero-dependency BPE-approximating token counter for text and JSON payloads.
 */
export function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  // Split into word/identifier runs, whitespace, and punctuation/symbols
  const matches = text.match(/[A-Za-z0-9_]+|[^\sA-Za-z0-9_]+|\s+/g);
  if (!matches) return 0;

  let tokens = 0;
  for (const chunk of matches) {
    if (/^\s+$/.test(chunk)) {
      // Whitespace rarely takes more than 1 token per ~4 chars unless newlines
      tokens += chunk.length <= 2 ? 0.25 : Math.ceil(chunk.length / 4);
    } else if (/^[A-Za-z0-9_]+$/.test(chunk)) {
      tokens += chunk.length <= 4 ? 1 : Math.ceil(chunk.length / 4);
    } else {
      tokens += Math.ceil(chunk.length / 2);
    }
  }
  return Math.max(1, Math.ceil(tokens));
}

function collectTextParts(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTextParts(item, out);
    }
    return;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.text === "string") out.push(obj.text);
    if (typeof obj.content === "string" || Array.isArray(obj.content)) {
      collectTextParts(obj.content, out);
    }
    if (typeof obj.arguments === "string") out.push(obj.arguments);
    if (obj.input !== undefined) {
      out.push(typeof obj.input === "string" ? obj.input : JSON.stringify(obj.input));
    }
    if (obj.function && typeof obj.function === "object") {
      collectTextParts(obj.function, out);
    }
    if (typeof obj.name === "string") out.push(obj.name);
  }
}

export function estimatePayloadTokens(format: ApiFormat, body: Record<string, unknown>): number {
  const parts: string[] = [];
  let messageCount = 0;

  if (format === "anthropic" && body.system !== undefined) {
    collectTextParts(body.system, parts);
    messageCount += 1;
  }

  if (Array.isArray(body.messages)) {
    messageCount += body.messages.length;
    for (const msg of body.messages) {
      if (msg && typeof msg === "object") {
        const record = msg as Record<string, unknown>;
        if (typeof record.role === "string") parts.push(record.role);
        if (record.content !== undefined) collectTextParts(record.content, parts);
        if (record.tool_calls !== undefined) collectTextParts(record.tool_calls, parts);
        if (record.function_call !== undefined) collectTextParts(record.function_call, parts);
      }
    }
  }

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    parts.push(JSON.stringify(body.tools));
  }
  if (Array.isArray(body.functions) && body.functions.length > 0) {
    parts.push(JSON.stringify(body.functions));
  }

  const textTokens = estimateTokensFromText(parts.join("\n"));
  // Small per-message framing overhead (approx. 3 tokens per message)
  return textTokens + messageCount * 3;
}
