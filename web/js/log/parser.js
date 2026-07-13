// ============================================================================
// 日志解析
// ============================================================================

import { state } from "../state.js?v=20260709-stream4";
import { LOG_TIMESTAMP_RE } from "../config.js?v=20260709-stream4";
import {
  safeObject,
  extractResultId,
  extractResultTs,
  summarizeJsonLog,
  summarizePlainLog,
  bracketParts,
} from "../utils/log-text.js?v=20260709-stream4";

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

/** 版本号括号如 v4.26.4，不能当 scope */
export function isVersionBracket(part) {
  return /^v?\d+(?:\.\d+)+(?:[-+][A-Za-z0-9.]+)?$/i.test(String(part || "").trim());
}

/** 模块定位括号：mod:line / path.py / file.js */
export function isModuleBracket(part) {
  const text = String(part || "");
  return text.includes(":") || text.includes(".py") || text.includes(".js");
}

/** 是否可作为 Core/Plug 一类 scope */
export function isScopeBracket(part) {
  const text = String(part || "").trim();
  if (!text) return false;
  if (normalizeLevel(text)) return false;
  if (isVersionBracket(text)) return false;
  if (isModuleBracket(text)) return false;
  return true;
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

/** 行首是否带 AstrBot 时间戳头 */
export function isTimestampedLogLine(line) {
  return /^\[\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?\]/.test(String(line || ""));
}

/**
 * 无时间戳续行可挂到上一标准 plain 行（继承时间/级别/模块）。
 * 不挂到纯 other 且无时间的碎片，避免无头堆叠。
 */
export function canAttachContinuation(prev) {
  if (!prev) return false;
  if (prev.trace) return false;
  if (prev.timestamp) return true;
  return Boolean(prev.continued && (prev.moduleName || prev.scope || prev.rawLevel));
}

export function attachContinuationLine(entry, line) {
  const cont = String(line || "");
  if (!entry || !cont) return entry;
  entry.raw = `${entry.raw || ""}\n${cont}`;
  entry.message = `${entry.message || ""}\n${cont}`;
  entry.continued = true;
  entry.continuationLines = Number(entry.continuationLines || 0) + 1;
  if (!entry.trace) {
    entry.summary = summarizePlainLog(entry.message, entry.raw, {
      moduleName: entry.moduleName,
      scope: entry.scope,
    });
  }
  return entry;
}

function reasoningTextValue(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim() ? value : "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => reasoningTextValue(item))
      .filter(Boolean)
      .join("\n");
  }
  if (typeof value === "object") {
    const object = safeObject(value);
    const nested = reasoningTextValue(object.text)
      || reasoningTextValue(object.content)
      || reasoningTextValue(object.reasoning_content)
      || reasoningTextValue(object.reasoning);
    if (nested) return nested;
    try {
      const json = JSON.stringify(value);
      return json && json !== "{}" ? json : "";
    } catch (err) {
      return "";
    }
  }
  return "";
}

function firstReasoningText(...values) {
  for (const value of values) {
    const text = reasoningTextValue(value);
    if (String(text || "").trim()) return text;
  }
  return "";
}

/**
 * 将 Unix 秒/毫秒时间戳规范为毫秒。
 * - > 1e12：已是 ms
 * - 1e9–1e12：秒（可含小数）
 */
export function normalizeEpochMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > 1e12) return Math.round(n);
  if (n > 1e9) return Math.round(n * 1000);
  return null;
}

/**
 * stats.start_time / end_time 为 Unix 秒时差 → 生成段耗时 ms。
 * 若两端已是 ms 级 epoch，差值直接用（不再 *1000）。
 */
export function durationMsFromStats(stats) {
  const st = Number(stats?.start_time);
  const et = Number(stats?.end_time);
  if (!Number.isFinite(st) || !Number.isFinite(et) || et < st) return null;
  // 两端像 epoch 秒（~1e9）→ 差为秒；两端像 ms（~1e12）→ 差为 ms
  if (st > 1e12 || et > 1e12) return Math.max(0, et - st);
  return Math.max(0, (et - st) * 1000);
}

/** time_to_first_token：≤0 / 缺失视为无效（trace 常写 0.0） */
export function timeToFirstTokenMsFromStats(stats) {
  const raw = Number(stats?.time_to_first_token);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  // 常见单位：秒（0.1–60）；若已是 ms 级（>1000）则不再 *1000
  if (raw > 1000) return Math.round(raw);
  return Math.round(raw * 1000);
}

export function buildTraceInfo(data) {
  if (!data || typeof data !== "object") return null;
  const fields = safeObject(data.fields);
  const tool = safeObject(fields.tool_name);
  const stats = safeObject(fields.stats);
  const tokenUsage = safeObject(stats.token_usage);
  const chatProvider = safeObject(fields.chat_provider);
  const resultText = fields.tool_result == null ? "" : String(fields.tool_result);
  // generationMs：模型 stats 生成段；durationMs 兼容旧字段，同 generationMs
  const generationMs = durationMsFromStats(stats);
  return {
    action: data.action || data.name || "",
    spanId: data.span_id || "",
    time: normalizeEpochMs(data.time) ?? (Number(data.time || 0) ? Number(data.time) * 1000 : null),
    umo: data.umo || "",
    senderName: data.sender_name || "",
    messageOutline: data.message_outline || "",
    personaId: fields.persona_id || "",
    personaToolCount: Array.isArray(fields.persona_toolset) ? fields.persona_toolset.length : null,
    toolCallId: tool.id || extractResultId(resultText),
    toolName: tool.name || "",
    toolArgs: tool.args || null,
    toolStartTs: normalizeEpochMs(tool.ts) ?? (Number(tool.ts || 0) ? Number(tool.ts) * 1000 : null),
    toolResultTs: extractResultTs(resultText),
    toolResult: resultText,
    response: fields.resp || "",
    reasoningContent: firstReasoningText(
      fields.reasoning_content,
      fields.reasoning,
      fields.thinking,
      fields.reason_content,
      fields.reasoningContent,
      fields.reasonContent,
    ),
    generationMs,
    durationMs: generationMs,
    timeToFirstTokenMs: timeToFirstTokenMsFromStats(stats),
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
    scope = parts.find((part) => isScopeBracket(part)) || "";
    moduleName = [...parts].reverse().find((part) => isModuleBracket(part)) || "";
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
      scope = parts.find((part) => isScopeBracket(part)) || "";
      moduleName = [...parts].reverse().find((part) => isModuleBracket(part))
        || parts.find((part) => isModuleBracket(part))
        || "";
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
      scope = parts.find((part) => isScopeBracket(part)) || "";
      moduleName = parts.find((part) => isModuleBracket(part)) || "";
      message = raw.replace(/^\[[^\]]+\]\s*/, "");
    }
  }

  const trace = buildTraceInfo(parsedJson);
  const timestamp = parseTimestamp(timeText || raw) || trace?.time || null;
  const summary = parsedJson
    ? message
    : summarizePlainLog(message, raw, { moduleName, scope });
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
    continued: false,
    continuationLines: 0,
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
    const raw = String(line || "");
    const lineNumber = Number(file.base_line || 0) + lineIndex + 1;

    // 无时间戳续行 → 附着上一标准 plain 行
    if (!isTimestampedLogLine(raw) && canAttachContinuation(entries[entries.length - 1])) {
      attachContinuationLine(entries[entries.length - 1], raw);
      return;
    }

    const cachedEntry = cachedByLine.get(lineNumber);
    // 仅命中未合并续行的单行缓存，避免多行 raw 与单行输入错配
    if (
      cachedEntry
      && cachedEntry.raw === raw
      && !cachedEntry.continued
      && !Number(cachedEntry.continuationLines || 0)
    ) {
      entries.push({
        ...cachedEntry,
        fileMtime: file.mtime || 0,
        lineIndex,
        continued: false,
        continuationLines: 0,
      });
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