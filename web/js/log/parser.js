// ============================================================================
// 日志解析
// ============================================================================

import { state } from "../state.js?v=20260627-calm1";
import { LOG_TIMESTAMP_RE } from "../config.js?v=20260627-calm1";
import {
  compactText,
  safeObject,
  extractResultId,
  extractResultTs,
  summarizeJsonLog,
  summarizePlainLog,
  bracketParts,
} from "../utils/log-text.js?v=20260627-calm1";

/**
 * 从日志行文本解析毫秒级时间戳；解析失败时返回 null。
 * 与后端 _parse_log_timestamp_ms 行为保持一致。
 */
export function parseLogTimestampMs(line) {
  const match = LOG_TIMESTAMP_RE.exec(String(line || ""));
  if (!match) return null;
  const text = match[1].replace(" ", "T");
  try {
    const value = new Date(text);
    if (Number.isNaN(value.getTime())) return null;
    return value.getTime();
  } catch (err) {
    return null;
  }
}

export function parseTimestamp(text) {
  const bracket = text.match(/\[(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?)\]/);
  const plain = bracket || text.match(/(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?)/);
  if (!plain) return null;
  const normalized = plain[1].replace(" ", "T");
  const ts = Date.parse(normalized);
  return Number.isFinite(ts) ? ts : null;
}

export function normalizeLevel(value) {
  const text = String(value || "")
    .replace(/^\[|\]$/g, "")
    .trim()
    .toUpperCase();
  if (["FATAL", "CRITICAL", "ERROR", "ERR", "ERRO"].includes(text)) return "error";
  if (["WARN", "WARNING", "WRN"].includes(text)) return "warn";
  if (["INFO", "INFORMATION"].includes(text)) return "info";
  if (["DEBUG", "DBUG"].includes(text)) return "debug";
  if (["TRACE", "TRAC"].includes(text)) return "trace";
  return "";
}

export function structuredLevel(parts) {
  for (const part of parts) {
    const level = normalizeLevel(part);
    if (level) {
      return { level, rawLevel: part };
    }
  }
  return { level: "other", rawLevel: "" };
}

export function tryParseJsonLog(rest) {
  const text = String(rest || "").trim();
  if (!text.startsWith("{")) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

export function buildTraceInfo(data) {
  if (!data || typeof data !== "object") return null;
  const fields = safeObject(data.fields);
  const tool = safeObject(fields.tool_name);
  const stats = safeObject(fields.stats);
  const tokenUsage = safeObject(stats.token_usage);
  const chatProvider = safeObject(fields.chat_provider);
  const resultText = fields.tool_result == null ? "" : String(fields.tool_result);
  return {
    action: data.action || data.name || "",
    spanId: data.span_id || "",
    time: Number(data.time || 0) ? Number(data.time) * 1000 : null,
    umo: data.umo || "",
    senderName: data.sender_name || "",
    messageOutline: data.message_outline || "",
    personaId: fields.persona_id || "",
    personaToolCount: Array.isArray(fields.persona_toolset) ? fields.persona_toolset.length : null,
    toolCallId: tool.id || extractResultId(resultText),
    toolName: tool.name || "",
    toolArgs: tool.args || null,
    toolStartTs: Number(tool.ts || 0) ? Number(tool.ts) * 1000 : null,
    toolResultTs: extractResultTs(resultText),
    toolResult: resultText,
    response: fields.resp || "",
    durationMs: Number(stats.start_time || 0) && Number(stats.end_time || 0)
      ? Math.max(0, (Number(stats.end_time) - Number(stats.start_time)) * 1000)
      : null,
    timeToFirstTokenMs: Number.isFinite(Number(stats.time_to_first_token))
      ? Math.max(0, Number(stats.time_to_first_token) * 1000)
      : null,
    tokenUsage,
    providerId: chatProvider.id || "",
    model: chatProvider.model || "",
  };
}

export function parseLogLine(line, file, lineIndex, globalIndex) {
  const raw = String(line || "");
  const lineNumber = Number(file.base_line || 0) + lineIndex + 1;
  const timestamped = raw.match(/^\[(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?)\]\s*(.*)$/);
  const astrbot = raw.match(/^\[(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?)\]\s+((?:\[[^\]]+\]\s*)+):\s*(.*)$/);
  let timeText = "";
  let scope = "";
  let rawLevel = "";
  let moduleName = "";
  let message = raw;
  let level = "other";
  let levelSource = "未标记";
  let parsedJson = null;

  if (astrbot) {
    timeText = astrbot[1];
    const parts = bracketParts(astrbot[2]);
    const detected = structuredLevel(parts);
    level = detected.level;
    rawLevel = detected.rawLevel;
    levelSource = rawLevel ? "日志头" : "未标记";
    scope = parts.find((part) => !normalizeLevel(part) && !part.includes(":") && !part.includes(".py") && !part.includes(".js") && !/^v?\d+(?:\.\d+)+/.test(part)) || "";
    moduleName = [...parts].reverse().find((part) => part.includes(":") || part.includes(".py") || part.includes(".js")) || "";
    message = astrbot[3];
  } else if (timestamped) {
    timeText = timestamped[1];
    parsedJson = tryParseJsonLog(timestamped[2]);
    if (parsedJson) {
      const detected = normalizeLevel(parsedJson.level);
      level = detected || "other";
      rawLevel = parsedJson.level || "";
      levelSource = rawLevel ? "JSON level" : "未标记";
      scope = parsedJson.type || "";
      moduleName = parsedJson.action || parsedJson.name || "";
      message = summarizeJsonLog(parsedJson);
    } else {
      const parts = bracketParts(timestamped[2]).slice(0, 6);
      const detected = structuredLevel(parts);
      level = detected.level;
      rawLevel = detected.rawLevel;
      levelSource = rawLevel ? "日志头" : "未标记";
      scope = parts.find((part) => !normalizeLevel(part) && !part.includes(":") && !part.includes(".py") && !part.includes(".js")) || "";
      moduleName = parts.find((part) => part.includes(":") || part.includes(".py") || part.includes(".js")) || "";
      message = raw.replace(/^\[[^\]]+\]\s*/, "");
    }
  } else {
    parsedJson = tryParseJsonLog(raw);
    if (parsedJson) {
      const detected = normalizeLevel(parsedJson.level);
      level = detected || "other";
      rawLevel = parsedJson.level || "";
      levelSource = rawLevel ? "JSON level" : "未标记";
      scope = parsedJson.type || "";
      moduleName = parsedJson.action || parsedJson.name || "";
      message = summarizeJsonLog(parsedJson);
    } else {
      const parts = bracketParts(raw).slice(0, 6);
      const detected = structuredLevel(parts);
      level = detected.level;
      rawLevel = detected.rawLevel;
      levelSource = rawLevel ? "日志头" : "未标记";
      scope = parts.find((part) => !normalizeLevel(part) && !part.includes(":") && !part.includes(".py") && !part.includes(".js")) || "";
      moduleName = parts.find((part) => part.includes(":") || part.includes(".py") || part.includes(".js")) || "";
    }
    message = raw.replace(/^\[[^\]]+\]\s*/, "");
  }

  const trace = buildTraceInfo(parsedJson);
  const timestamp = parseTimestamp(timeText || raw) || trace?.time || null;
  const summary = parsedJson ? message : summarizePlainLog(message, raw);
  return {
    id: `${file.source}:${file.path}:${lineNumber}`,
    raw,
    source: file.source,
    sourceName: file.sourceName,
    path: file.path || "",
    fileName: file.path ? file.path.split("/").pop() : "--",
    fileMtime: file.mtime || 0,
    lineIndex,
    lineNumber,
    globalIndex,
    timestamp,
    scope,
    rawLevel,
    level,
    levelSource,
    moduleName,
    message: message || raw,
    summary: summary || message || raw,
    trace,
  };
}

export function fileCacheKey(file) {
  return `${file.source || ""}:${file.path || ""}`;
}

export function buildFileLogEntries(file) {
  if (!file.readable || !Array.isArray(file.lines)) return [];
  const key = fileCacheKey(file);
  const cached = state.logCache.fileEntries.get(key);
  const cachedByLine = new Map((cached?.entries || []).map((entry) => [entry.lineNumber, entry]));
  const entries = [];
  file.lines.forEach((line, lineIndex) => {
    if (!String(line || "").trim()) return;
    const lineNumber = Number(file.base_line || 0) + lineIndex + 1;
    const cachedEntry = cachedByLine.get(lineNumber);
    if (cachedEntry && cachedEntry.raw === String(line || "")) {
      entries.push({ ...cachedEntry, fileMtime: file.mtime || 0, lineIndex });
      return;
    }
    entries.push(parseLogLine(line, file, lineIndex, 0));
  });
  state.logCache.fileEntries.set(key, {
    baseLine: Number(file.base_line || 0),
    lineCount: Number(file.line_count || 0),
    entries,
  });
  return entries;
}

export function pruneFileEntryCache(files) {
  const active = new Set(files.map((file) => fileCacheKey(file)));
  state.logCache.fileEntries.forEach((_, key) => {
    if (!active.has(key)) {
      state.logCache.fileEntries.delete(key);
    }
  });
}

export function buildLogEntries(files) {
  pruneFileEntryCache(files);
  const entries = [];
  files.forEach((file) => {
    buildFileLogEntries(file).forEach((entry) => entries.push(entry));
  });
  entries.forEach((entry, index) => {
    entry.globalIndex = index;
  });
  return entries;
}
