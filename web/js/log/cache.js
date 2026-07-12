import { state } from "../state.js?v=20260709-stream4";
import { TRACE_ANALYSIS_ENTRY_LIMIT, REASONING_CANDIDATE_KEEP } from "../config.js?v=20260709-stream4";
import { stableKeyText } from "../utils/dom.js?v=20260709-stream4";

export function collectLogFiles() {
  const data = state.logs || {};
  return (data.astrbot || []).map((file) => ({ ...file, source: "astrbot", sourceName: "AstrBot" }));
}

export function logFilesSignature(files) {
  return files.map((file) => {
    const lines = Array.isArray(file.lines) ? file.lines : [];
    const first = lines[0] || "";
    const last = lines[lines.length - 1] || "";
    return [
      file.path || "",
      file.readable ? 1 : 0,
      file.mtime || 0,
      file.size || 0,
      file.base_line || 0,
      file.line_count ?? lines.length,
      lines.length,
      stableKeyText(first, 96),
      stableKeyText(last, 160),
    ].join("~");
  }).join("|");
}

function entrySortTime(entry) {
  return entry.timestamp || (entry.fileMtime ? (entry.fileMtime > 1e12 ? entry.fileMtime : entry.fileMtime * 1000) : 0);
}

function looksLikeReasoningEntry(entry) {
  if (!entry || entry.trace) return false;
  const raw = `${entry.raw || ""} ${entry.message || ""}`;
  return /reasoning_content|reasoningContent|reason_content|thinking\s*=/i.test(raw);
}

/**
 * 分析窗：总条数上限内，优先钉住 plain 思考 dump，避免被 trace 噪声挤出。
 */
export function recentAnalysisEntries(entries) {
  if (entries.length <= TRACE_ANALYSIS_ENTRY_LIMIT) return entries;
  const sorted = entries
    .slice()
    .sort((a, b) => {
      const aTime = entrySortTime(a);
      const bTime = entrySortTime(b);
      return bTime - aTime || b.globalIndex - a.globalIndex;
    });

  const keepN = Math.min(REASONING_CANDIDATE_KEEP, Math.floor(TRACE_ANALYSIS_ENTRY_LIMIT / 4));
  const reasoningPinned = [];
  const rest = [];
  sorted.forEach((entry) => {
    if (reasoningPinned.length < keepN && looksLikeReasoningEntry(entry)) {
      reasoningPinned.push(entry);
    } else {
      rest.push(entry);
    }
  });
  const room = Math.max(0, TRACE_ANALYSIS_ENTRY_LIMIT - reasoningPinned.length);
  return reasoningPinned.concat(rest.slice(0, room));
}
