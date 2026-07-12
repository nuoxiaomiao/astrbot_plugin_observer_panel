// ============================================================================
// 会话思考 sticky 缓存：跨 buildTraceInsights 重建保留已绑定的 reasoning
// ============================================================================

const REASONING_STICKY_MAX = 200;

/** @type {Map<string, {
 *   content: string,
 *   logEntryId: string,
 *   ts: number|null,
 *   source: string,
 *   completionId: string,
 *   responseFingerprint: string,
 * }>} */
const reasoningStickyBySpan = new Map();

function normalizeFingerprint(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function stickyRank(source) {
  if (source === "trace") return 3;
  if (source === "plain") return 2;
  if (source === "sticky") return 1;
  return 0;
}

function sessionSpanKeys(session) {
  if (!session?.spanId) return [];
  return [session.spanId, ...(session.aliasSpanIds || [])].filter(Boolean);
}

/**
 * 将 session 上已有的思考写入 sticky（按 span + alias 共享同一记录）。
 * 仅当新证据等级不低于旧值时覆盖，避免弱证据冲掉 trace。
 */
export function rememberSessionReasoning(session) {
  const content = String(session?.reasoningContent || "").trim();
  if (!session?.spanId || !content) return;

  const next = {
    content,
    logEntryId: session.reasoningLogEntryId || "",
    ts: session.reasoningTs ?? null,
    source: session.reasoningSource === "sticky"
      ? "plain"
      : (session.reasoningSource || "plain"),
    completionId: session.reasoningCompletionId || "",
    responseFingerprint: normalizeFingerprint(session.response),
  };

  const keys = sessionSpanKeys(session);
  let shouldWrite = true;
  for (const key of keys) {
    const prev = reasoningStickyBySpan.get(key);
    if (!prev?.content) continue;
    if (stickyRank(prev.source) > stickyRank(next.source)) {
      shouldWrite = false;
      break;
    }
  }
  if (!shouldWrite) return;

  for (const key of keys) {
    reasoningStickyBySpan.set(key, next);
  }
}

/** session 尚无 reasoning 时从 sticky 回填（complete 会话）。 */
export function hydrateSessionReasoning(session) {
  if (!session || String(session.reasoningContent || "").trim()) return false;
  if (session.status !== "complete") return false;

  for (const key of sessionSpanKeys(session)) {
    const rec = reasoningStickyBySpan.get(key);
    if (!rec?.content) continue;
    session.reasoningContent = rec.content;
    session.reasoningLogEntryId = rec.logEntryId || "";
    session.reasoningTs = rec.ts;
    session.reasoningTokens = session.reasoningTokens ?? null;
    session.reasoningSource = "sticky";
    session.reasoningCompletionId = rec.completionId || "";
    return true;
  }
  return false;
}

/**
 * 淘汰：优先删除不在活跃 span 集合中的项；仍超限则按 ts 最旧删除。
 * @param {Set<string>|Iterable<string>} activeSpanIds
 */
export function evictReasoningSticky(activeSpanIds) {
  const active = activeSpanIds instanceof Set
    ? activeSpanIds
    : new Set(activeSpanIds || []);

  if (reasoningStickyBySpan.size <= REASONING_STICKY_MAX) {
    // 轻度清理：去掉既不活跃又无 alias 关联的旧 key（仅当超过一半空闲时）
    if (reasoningStickyBySpan.size > REASONING_STICKY_MAX * 0.8) {
      for (const key of [...reasoningStickyBySpan.keys()]) {
        if (!active.has(key) && reasoningStickyBySpan.size > REASONING_STICKY_MAX * 0.75) {
          reasoningStickyBySpan.delete(key);
        }
      }
    }
    return;
  }

  for (const key of [...reasoningStickyBySpan.keys()]) {
    if (!active.has(key)) reasoningStickyBySpan.delete(key);
    if (reasoningStickyBySpan.size <= REASONING_STICKY_MAX) return;
  }

  const ordered = [...reasoningStickyBySpan.entries()]
    .sort((a, b) => (Number(a[1].ts) || 0) - (Number(b[1].ts) || 0));
  for (const [key] of ordered) {
    if (reasoningStickyBySpan.size <= REASONING_STICKY_MAX) break;
    if (!active.has(key)) reasoningStickyBySpan.delete(key);
  }
  while (reasoningStickyBySpan.size > REASONING_STICKY_MAX) {
    const oldest = ordered.shift();
    if (!oldest) break;
    reasoningStickyBySpan.delete(oldest[0]);
  }
}

/** 测试 / 调试用 */
export function clearReasoningSticky() {
  reasoningStickyBySpan.clear();
}

export function reasoningStickySize() {
  return reasoningStickyBySpan.size;
}