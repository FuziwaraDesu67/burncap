import {
  estimatePayloadTokens,
  isExpensiveModel,
} from "./pricing.js";
import type { ApiFormat, BurnCapSettings, TruncatedDiffItem } from "./state.js";

export const TRUNCATION_MARKER = "[...BurnCap truncated middle lines to save tokens...]";
const TRUNCATE_THRESHOLD_CHARS = 4000;
const TRUNCATE_EDGE_CHARS = 1500;
const DIFF_REMOVED_EXCERPT_LIMIT = 4000;

export interface OptimizationContext {
  upstreamUrl?: string;
  hasAnthropicApiKey?: boolean;
}

export interface OptimizationResult {
  body: Record<string, unknown>;
  originalModel: string;
  routedModel: string;
  originalInputTokens: number;
  slimmedInputTokens: number;
  tokensShaved: number;
  wasSlimmed: boolean;
  wasRerouted: boolean;
  dedupedSystemCount: number;
  cacheProtectedMessages: number;
  slimmedDiffs: TruncatedDiffItem[];
  notes: string[];
}

interface CacheControlBoundary {
  protectAllSystem: boolean;
  systemBlockCutoff: number;       // system array indices <= this are untouched
  messageCutoff: number;           // message indices < this are untouched
  blockCutoffInLastCachedMsg: number; // inside messages[messageCutoff], block indices <= this are untouched
  hasAnyBreakpoint: boolean;
}

function hasCacheControl(obj: unknown): boolean {
  return Boolean(
    obj &&
      typeof obj === "object" &&
      (obj as Record<string, unknown>).cache_control !== undefined &&
      (obj as Record<string, unknown>).cache_control !== null
  );
}

function findCacheControlBoundary(
  format: ApiFormat,
  body: Record<string, unknown>
): CacheControlBoundary {
  let systemBlockCutoff = -1;
  let messageCutoff = -1;
  let blockCutoffInLastCachedMsg = -1;

  if (format === "anthropic" && Array.isArray(body.system)) {
    for (let i = 0; i < body.system.length; i += 1) {
      if (hasCacheControl(body.system[i])) {
        systemBlockCutoff = i;
      }
    }
  }

  if (Array.isArray(body.messages)) {
    for (let mIdx = 0; mIdx < body.messages.length; mIdx += 1) {
      const rawMsg = body.messages[mIdx];
      if (!rawMsg || typeof rawMsg !== "object") continue;
      const msg = rawMsg as Record<string, unknown>;

      if (hasCacheControl(msg)) {
        messageCutoff = mIdx;
        blockCutoffInLastCachedMsg = Number.POSITIVE_INFINITY;
      }

      if (Array.isArray(msg.content)) {
        for (let bIdx = 0; bIdx < msg.content.length; bIdx += 1) {
          if (hasCacheControl(msg.content[bIdx])) {
            messageCutoff = mIdx;
            blockCutoffInLastCachedMsg = bIdx;
          }
        }
      }
    }
  }

  const protectAllSystem = messageCutoff >= 0;
  return {
    protectAllSystem,
    systemBlockCutoff: protectAllSystem ? Number.POSITIVE_INFINITY : systemBlockCutoff,
    messageCutoff,
    blockCutoffInLastCachedMsg,
    hasAnyBreakpoint: protectAllSystem || systemBlockCutoff >= 0,
  };
}

function normalizeSystemBlock(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateMiddleIfNeeded(
  text: string,
  location: string,
  diffs: TruncatedDiffItem[]
): { value: string; truncated: boolean } {
  if (text.length <= TRUNCATE_THRESHOLD_CHARS) {
    return { value: text, truncated: false };
  }

  const head = text.slice(0, TRUNCATE_EDGE_CHARS);
  const tail = text.slice(-TRUNCATE_EDGE_CHARS);
  const removedMiddle = text.slice(TRUNCATE_EDGE_CHARS, text.length - TRUNCATE_EDGE_CHARS);
  const value = `${head}\n${TRUNCATION_MARKER}\n${tail}`;

  const removedMiddleSnippet =
    removedMiddle.length > DIFF_REMOVED_EXCERPT_LIMIT
      ? `${removedMiddle.slice(0, DIFF_REMOVED_EXCERPT_LIMIT)}\n... (${(
          removedMiddle.length - DIFF_REMOVED_EXCERPT_LIMIT
        ).toLocaleString()} additional middle chars omitted from preview)`
      : removedMiddle;

  diffs.push({
    location,
    originalChars: text.length,
    truncatedChars: value.length,
    headSnippet: head,
    removedMiddleSnippet,
    tailSnippet: tail,
    marker: TRUNCATION_MARKER,
  });

  return { value, truncated: true };
}

function looksLikeTerminalOrStackTrace(text: string): boolean {
  if (/(<tool_result>|Command output:|Terminal output:|stderr:|stdout:)/i.test(text)) {
    return true;
  }
  if (/Traceback \(most recent call last\)|npm ERR!|ERR_[A-Z_]+/i.test(text)) {
    return true;
  }
  const stackLines = text.match(/\n\s+at\s+\S+/g);
  return (stackLines?.length ?? 0) >= 3;
}

function dedupeSystemParagraphs(text: string): { text: string; removed: number } {
  const parts = text.split(/\n{2,}/);
  if (parts.length < 2) return { text, removed: 0 };

  const kept: string[] = [];
  let removed = 0;
  let prevNorm = "";

  for (const part of parts) {
    const norm = normalizeSystemBlock(part);
    if (norm.length >= 30 && norm === prevNorm) {
      removed += 1;
      continue;
    }
    kept.push(part);
    prevNorm = norm;
  }

  return {
    text: removed > 0 ? kept.join("\n\n") : text,
    removed,
  };
}

function dedupeContentBlocksArray(
  blocks: unknown[],
  protectedUpToIndex = -1
): { blocks: unknown[]; removed: number } {
  const kept: unknown[] = [];
  let removed = 0;
  let prevNorm: string | null = null;

  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    const isProtected = i <= protectedUpToIndex;

    if (
      block &&
      typeof block === "object" &&
      typeof (block as Record<string, unknown>).text === "string"
    ) {
      const norm = normalizeSystemBlock((block as Record<string, unknown>).text as string);
      if (!isProtected && norm && norm === prevNorm) {
        removed += 1;
        continue;
      }
      prevNorm = norm;
    } else {
      prevNorm = null;
    }
    kept.push(block);
  }

  return { blocks: kept, removed };
}

function slimTextContentParts(
  content: unknown,
  forceTruncate: boolean,
  locationPrefix: string,
  diffs: TruncatedDiffItem[],
  protectedUpToBlockIdx = -1
): unknown {
  if (typeof content === "string") {
    if (protectedUpToBlockIdx >= 0) return content;
    if (forceTruncate || looksLikeTerminalOrStackTrace(content)) {
      return truncateMiddleIfNeeded(content, locationPrefix, diffs).value;
    }
    return content;
  }

  if (Array.isArray(content)) {
    return content.map((item, idx) => {
      if (idx <= protectedUpToBlockIdx) return item;
      if (!item || typeof item !== "object") return item;

      const part = item as Record<string, unknown>;
      if (part.type === "text" && typeof part.text === "string") {
        if (forceTruncate || looksLikeTerminalOrStackTrace(part.text)) {
          return {
            ...part,
            text: truncateMiddleIfNeeded(
              part.text,
              `${locationPrefix}.content[${idx}]`,
              diffs
            ).value,
          };
        }
      }
      if (part.type === "tool_result" && part.content !== undefined) {
        return {
          ...part,
          content: slimTextContentParts(
            part.content,
            true,
            `${locationPrefix}.content[${idx}] (tool_result)`,
            diffs,
            -1
          ),
        };
      }
      return part;
    });
  }

  return content;
}

function applyContextSlimmer(
  format: ApiFormat,
  body: Record<string, unknown>
): {
  slimmed: boolean;
  dedupedBlocks: number;
  cacheProtectedMessages: number;
  diffs: TruncatedDiffItem[];
  notes: string[];
} {
  const notes: string[] = [];
  const diffs: TruncatedDiffItem[] = [];
  let dedupedBlocks = 0;

  const boundary = findCacheControlBoundary(format, body);
  const cacheProtectedMessages =
    boundary.messageCutoff >= 0 ? boundary.messageCutoff + 1 : 0;

  // 1. Deduplicate Anthropic top-level system prompt blocks (respecting cache_control)
  if (format === "anthropic" && body.system !== undefined && !boundary.protectAllSystem) {
    if (Array.isArray(body.system)) {
      const deduped = dedupeContentBlocksArray(body.system, boundary.systemBlockCutoff);
      if (deduped.removed > 0) {
        body.system = deduped.blocks;
        dedupedBlocks += deduped.removed;
      }
    } else if (typeof body.system === "string" && boundary.systemBlockCutoff < 0) {
      const deduped = dedupeSystemParagraphs(body.system);
      if (deduped.removed > 0) {
        body.system = deduped.text;
        dedupedBlocks += deduped.removed;
      }
    }
  }

  // 2. Deduplicate consecutive system messages & deterministically truncate new oversized tool outputs
  if (Array.isArray(body.messages)) {
    const nextMessages: unknown[] = [];
    let prevSystemNorm: string | null = null;

    for (let mIdx = 0; mIdx < body.messages.length; mIdx += 1) {
      const rawMsg = body.messages[mIdx];

      // NEVER mutate messages strictly before the last cache_control breakpoint
      if (mIdx < boundary.messageCutoff) {
        nextMessages.push(rawMsg);
        if (rawMsg && typeof rawMsg === "object") {
          const r = String((rawMsg as Record<string, unknown>).role ?? "").toLowerCase();
          if (r === "system" || r === "developer") {
            const txt =
              typeof (rawMsg as Record<string, unknown>).content === "string"
                ? ((rawMsg as Record<string, unknown>).content as string)
                : "";
            prevSystemNorm = txt ? normalizeSystemBlock(txt) : null;
          } else {
            prevSystemNorm = null;
          }
        }
        continue;
      }

      const blockCutoff =
        mIdx === boundary.messageCutoff ? boundary.blockCutoffInLastCachedMsg : -1;

      if (!rawMsg || typeof rawMsg !== "object") {
        nextMessages.push(rawMsg);
        prevSystemNorm = null;
        continue;
      }

      const msg = rawMsg as Record<string, unknown>;
      const role = typeof msg.role === "string" ? msg.role.toLowerCase() : "";

      if (role === "system" || role === "developer") {
        if (mIdx === boundary.messageCutoff) {
          // Protected breakpoint message itself: never drop or modify cached prefix blocks
          if (Array.isArray(msg.content) && blockCutoff < msg.content.length - 1) {
            const deduped = dedupeContentBlocksArray(msg.content, blockCutoff);
            if (deduped.removed > 0) {
              msg.content = deduped.blocks;
              dedupedBlocks += deduped.removed;
            }
          }
          nextMessages.push(msg);
          prevSystemNorm = null;
          continue;
        }

        if (Array.isArray(msg.content)) {
          const deduped = dedupeContentBlocksArray(msg.content);
          if (deduped.removed > 0) {
            msg.content = deduped.blocks;
            dedupedBlocks += deduped.removed;
          }
        } else if (typeof msg.content === "string") {
          const deduped = dedupeSystemParagraphs(msg.content);
          if (deduped.removed > 0) {
            msg.content = deduped.text;
            dedupedBlocks += deduped.removed;
          }
        }

        const msgText =
          typeof msg.content === "string"
            ? msg.content
            : Array.isArray(msg.content)
            ? msg.content
                .map((c) =>
                  c && typeof c === "object" && typeof (c as Record<string, unknown>).text === "string"
                    ? (c as Record<string, unknown>).text
                    : ""
                )
                .join("\n")
            : "";
        const norm = normalizeSystemBlock(msgText);

        if (norm && prevSystemNorm === norm) {
          dedupedBlocks += 1;
          continue;
        }
        prevSystemNorm = norm || null;
        nextMessages.push(msg);
        continue;
      }

      prevSystemNorm = null;

      if (role === "tool" || role === "function") {
        msg.content = slimTextContentParts(
          msg.content,
          true,
          `messages[${mIdx}] (${role})`,
          diffs,
          blockCutoff
        );
      } else if (role === "user") {
        msg.content = slimTextContentParts(
          msg.content,
          false,
          `messages[${mIdx}] (user)`,
          diffs,
          blockCutoff
        );
      }

      nextMessages.push(msg);
    }

    body.messages = nextMessages;
  }

  if (boundary.hasAnyBreakpoint) {
    const scope =
      cacheProtectedMessages > 0
        ? `${cacheProtectedMessages} cached message${cacheProtectedMessages > 1 ? "s" : ""}`
        : `system cache prefix`;
    notes.push(`Cache-safe mode: preserved Anthropic cache_control breakpoint (${scope} untouched)`);
  }

  if (dedupedBlocks > 0) {
    notes.push(
      `Deduplicated ${dedupedBlocks} consecutive system prompt block${dedupedBlocks > 1 ? "s" : ""}`
    );
  }
  if (diffs.length > 0) {
    const totalOrigChars = diffs.reduce((acc, d) => acc + d.originalChars, 0);
    const totalNewChars = diffs.reduce((acc, d) => acc + d.truncatedChars, 0);
    notes.push(
      `Truncated ${diffs.length} oversized tool output${diffs.length > 1 ? "s" : ""} (${totalOrigChars.toLocaleString()} -> ${totalNewChars.toLocaleString()} chars)`
    );
  }

  return {
    slimmed: dedupedBlocks > 0 || diffs.length > 0,
    dedupedBlocks,
    cacheProtectedMessages,
    diffs,
    notes,
  };
}

function collectRoutingCueText(format: ApiFormat, body: Record<string, unknown>): string {
  const chunks: string[] = [];

  if (format === "anthropic" && body.system !== undefined) {
    if (typeof body.system === "string") chunks.push(body.system);
    else if (Array.isArray(body.system)) {
      for (const b of body.system) {
        if (b && typeof b === "object" && typeof (b as Record<string, unknown>).text === "string") {
          chunks.push((b as Record<string, unknown>).text as string);
        }
      }
    }
  }

  if (Array.isArray(body.messages)) {
    for (const raw of body.messages) {
      if (!raw || typeof raw !== "object") continue;
      const msg = raw as Record<string, unknown>;
      const role = typeof msg.role === "string" ? msg.role.toLowerCase() : "";
      if (role === "system" || role === "developer" || role === "user") {
        if (typeof msg.content === "string") chunks.push(msg.content);
        else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string") {
              chunks.push((part as Record<string, unknown>).text as string);
            }
          }
        }
      }
    }
  }

  return chunks.join("\n").slice(0, 2000);
}

const AUXILIARY_INTENT_REGEX =
  /\b(generate|create|write|suggest|give)\b.{0,35}\b(title|headline|subject|summary|commit message)\b|\b(chat title|conversation title|summarize (this|the) (conversation|chat|history|thread)|tl;?dr)\b/i;

export function ensureOpenRouterPrefix(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) return "anthropic/claude-haiku-4.5";
  if (trimmed.includes("/")) return trimmed;

  const lower = trimmed.toLowerCase();
  if (lower.startsWith("claude-")) {
    return `anthropic/${trimmed.replace("4-5", "4.5")}`;
  }
  if (lower.startsWith("gpt-") || /^o[134](-|$)/.test(lower)) {
    return `openai/${trimmed}`;
  }
  if (lower.startsWith("gemini-")) {
    return `google/${trimmed}`;
  }
  if (lower.startsWith("deepseek-")) {
    return `deepseek/${trimmed}`;
  }
  return `google/${trimmed}`;
}

function toNativeAnthropicHaiku(configuredCheapModel: string): string {
  const bare = configuredCheapModel.trim().replace(/^anthropic\//i, "");
  if (/claude-haiku-4[-.]5/i.test(bare)) {
    return bare.replace(/4\.5/g, "4-5");
  }
  return "claude-haiku-4-5";
}

export function resolveTargetCheapModel(
  configuredCheapModel: string,
  upstreamUrl: string,
  format: ApiFormat,
  hasAnthropicApiKey = false
): string {
  const lowerUrl = upstreamUrl.toLowerCase();

  // Rule 1: Native Anthropic (/v1/messages with x-api-key OR api.anthropic.com)
  // MUST ONLY downgrade to native Anthropic Haiku and never to Google/OpenAI models.
  if (
    (format === "anthropic" && hasAnthropicApiKey) ||
    lowerUrl.includes("api.anthropic.com")
  ) {
    return toNativeAnthropicHaiku(configuredCheapModel);
  }

  // Rule 2: Direct OpenAI upstream
  if (lowerUrl.includes("api.openai.com")) {
    const bare = configuredCheapModel.trim().replace(/^openai\//i, "");
    return /^(gpt-|o[134])/i.test(bare) ? bare : "gpt-4.1-mini";
  }

  // Rule 3: OpenRouter upstream must always carry provider/model prefix
  if (lowerUrl.includes("openrouter.ai")) {
    return ensureOpenRouterPrefix(configuredCheapModel);
  }

  return configuredCheapModel.trim() || "anthropic/claude-haiku-4.5";
}

export function optimizeRequestPayload(
  format: ApiFormat,
  rawBody: Record<string, unknown>,
  settings: BurnCapSettings,
  contextOrUpstream?: string | OptimizationContext
): OptimizationResult {
  const ctx: OptimizationContext =
    typeof contextOrUpstream === "string"
      ? { upstreamUrl: contextOrUpstream }
      : contextOrUpstream ?? {};

  const effectiveUpstream = ctx.upstreamUrl || settings.upstreamUrl;
  const originalModel =
    typeof rawBody.model === "string" && rawBody.model.trim()
      ? rawBody.model.trim()
      : "unknown";
  const originalInputTokens = estimatePayloadTokens(format, rawBody);

  const cloned = structuredClone(rawBody);
  const notes: string[] = [];
  let wasSlimmed = false;
  let dedupedSystemCount = 0;
  let cacheProtectedMessages = 0;
  let slimmedDiffs: TruncatedDiffItem[] = [];

  if (settings.contextSlimmer) {
    const slimRes = applyContextSlimmer(format, cloned);
    wasSlimmed = slimRes.slimmed;
    dedupedSystemCount = slimRes.dedupedBlocks;
    cacheProtectedMessages = slimRes.cacheProtectedMessages;
    slimmedDiffs = slimRes.diffs;
    notes.push(...slimRes.notes);
  }

  const slimmedInputTokens = wasSlimmed
    ? estimatePayloadTokens(format, cloned)
    : originalInputTokens;
  const tokensShaved = Math.max(0, originalInputTokens - slimmedInputTokens);

  let routedModel = originalModel;
  let wasRerouted = false;

  if (settings.smartRouting) {
    const hasTools =
      (Array.isArray(cloned.tools) && cloned.tools.length > 0) ||
      (Array.isArray(cloned.functions) && cloned.functions.length > 0);
    const targetCheap = resolveTargetCheapModel(
      settings.cheapModel,
      effectiveUpstream,
      format,
      Boolean(ctx.hasAnthropicApiKey)
    );

    if (!hasTools && isExpensiveModel(originalModel, targetCheap)) {
      const cueText = collectRoutingCueText(format, cloned);
      const isAuxiliaryCue = AUXILIARY_INTENT_REGEX.test(cueText);
      const isLightweightPrompt = slimmedInputTokens < 300;

      if (isLightweightPrompt || (isAuxiliaryCue && slimmedInputTokens < 1500)) {
        routedModel = targetCheap;
        cloned.model = targetCheap;
        wasRerouted = true;
        const reason = isAuxiliaryCue
          ? "auxiliary task detected"
          : `lightweight prompt (${slimmedInputTokens} tok < 300, no tools)`;
        notes.push(`Smart Router: ${originalModel} -> ${targetCheap} (${reason})`);
      }
    }
  }

  return {
    body: cloned,
    originalModel,
    routedModel,
    originalInputTokens,
    slimmedInputTokens,
    tokensShaved,
    wasSlimmed,
    wasRerouted,
    dedupedSystemCount,
    cacheProtectedMessages,
    slimmedDiffs,
    notes,
  };
}
