// ============================================================================
// 日志缓存管理
// ============================================================================

import { state } from "../state.js?v=20260620-renderfix1";
import { TRACE_ANALYSIS_ENTRY_LIMIT } from "../config.js?v=20260620-renderfix1";
import { stableKeyText } from "../utils/dom.js?v=20260620-renderfix1";

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

export function recentAnalysisEntries(entries) {
  if (entries.length <= TRACE_ANALYSIS_ENTRY_LIMIT) return entries;
  return entries
    .slice()
    .sort((a, b) => {
      const aTime = a.timestamp || a.fileMtime || 0;
      const bTime = b.timestamp || b.fileMtime || 0;
      return bTime - aTime || b.globalIndex - a.globalIndex;
    })
    .slice(0, TRACE_ANALYSIS_ENTRY_LIMIT);
}
