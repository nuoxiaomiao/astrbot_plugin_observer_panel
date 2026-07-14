// ============================================================================
// 日志分析与 trace 洞察
// ============================================================================

import { state } from "../state.js?v=20260709-stream4";
import {
  DEFAULT_SLOW_SESSION_MS,
  DEFAULT_SLOW_TOOL_MS,
  DEFAULT_RUNNING_TIMEOUT_MS,
  CORE_MODULE_LABELS,
  METHOD_MODULE_LABELS,
  PLUG_MODULE_LABELS,
  MODULE_PREFIX_LABELS,
  PLUGIN_DISPLAY_NAMES,
  TRACE_ACTION_LABELS,
  EVENT_TYPES,
} from "../config.js?v=20260709-stream4";
import { average } from "../utils/format.js?v=20260709-stream4";
import {
  compactText,
  compactJson,
  safeObject,
  bracketParts,
} from "../utils/log-text.js?v=20260709-stream4";
import { getLogSearchText, detailKey, stableKeyText } from "../utils/dom.js?v=20260709-stream4";
import { buildLogEntries } from "./parser.js?v=20260709-stream4";
import { logFilesSignature, recentAnalysisEntries } from "./cache.js?v=20260709-stream4";
import {
  rememberSessionReasoning,
  hydrateSessionReasoning,
  evictReasoningSticky,
} from "./reasoning-cache.js?v=20260709-stream4";

const SPLIT_SESSION_MERGE_WINDOW_MS = 3 * 60 * 1000;
/** pre-agent 非 Poke 会话可见窗口；Poke 更短，避免列表长期「进行中」 */
const PRE_AGENT_VISIBLE_MS = 2 * 60 * 1000;
const PRE_AGENT_POKE_VISIBLE_MS = 30 * 1000;

export function getLogAnalysis(files) {
  const signature = logFilesSignature(files);
  if (state.logCache.signature === signature && state.logCache.insights) {
    return {
      entries: state.logCache.entries,
      insights: state.logCache.insights,
      changed: false,
    };
  }
  const entries = buildLogEntries(files);
  const insights = buildTraceInsights(recentAnalysisEntries(entries));
  state.logCache = { ...state.logCache, signature, entries, insights };
  return { entries, insights, changed: true };
}

export function buildLogTextMatcher() {
  const textFilter = getLogSearchText();
  if (!textFilter) return null;
  if (state.logRegex) {
    if (isUnsafeUserRegex(textFilter)) {
      // 过长/高风险模式：回退子串，避免 ReDoS 卡死主线程
      return { substr: textFilter, raw: textFilter, unsafe: true };
    }
    try {
      // 正则模式：原样使用用户输入（区分大小写由用户用 (?i) 控制）
      return { regex: new RegExp(textFilter), raw: textFilter };
    } catch (err) {
      // 非法正则：回退为普通子串匹配，避免页面报错
      return { substr: textFilter, raw: textFilter };
    }
  }
  return { substr: textFilter, raw: textFilter };
}

/** 用户正则长度与嵌套量词启发式，拦截常见灾难性回溯 */
const MAX_LOG_REGEX_LENGTH = 120;

function isUnsafeUserRegex(source) {
  const s = String(source || "");
  if (s.length > MAX_LOG_REGEX_LENGTH) return true;
  // 相邻量词 / 量词叠量词
  if (/(\+|\*|\}|\?)\s*(\+|\*|\{)/.test(s)) return true;
  // (…+…)+ 类嵌套
  if (/\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/.test(s)) return true;
  const quantifiers = s.match(/[+*?]|\{(?:\d+,?\d*|\d*,\d+)\}/g);
  if (quantifiers && quantifiers.length > 12) return true;
  return false;
}

export function matchLogText(haystack, matcher) {
  if (!matcher) return true;
  if (matcher.regex) {
    const re = matcher.regex;
    // global 正则 .test 会推进 lastIndex，过滤多行时需复位
    if (re.global) re.lastIndex = 0;
    return re.test(haystack);
  }
  return haystack.includes(matcher.substr);
}

export function filterLogEntries(entries) {
  const matcher = buildLogTextMatcher();
  const now = Date.now();
  const timeFilters = {
    "5m": 5 * 60 * 1000,
    "15m": 15 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "6h": 6 * 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
  };
  const timeLimit = timeFilters[state.logTimeFilter];
  const customFrom = state.logTimeFrom;
  const customTo = state.logTimeTo;

  return entries.filter((entry) => {
    if (state.logLevel !== "all" && entry.level !== state.logLevel) return false;
    const entryTime = entryTimeMs(entry);
    if (timeLimit) {
      if (entryTime && now - entryTime > timeLimit) return false;
    } else if (state.logTimeFilter === "custom" && (customFrom || customTo)) {
      if (entryTime) {
        if (customFrom && entryTime < customFrom) return false;
        if (customTo && entryTime > customTo) return false;
      }
    }
    if (!matcher) return true;
    const haystack = state.privacyMode
      ? `${entry.path} ${entry.sourceName} ${entry.moduleName} ${entry.scope} ${entry.level}`.toLowerCase()
      : `${entry.raw} ${entry.summary} ${entry.path} ${entry.sourceName} ${entry.moduleName} ${entry.scope}`.toLowerCase();
    return matchLogText(haystack, matcher);
  });
}

export function countBy(entries, keyFn) {
  const out = {};
  entries.forEach((entry) => {
    const key = keyFn(entry);
    out[key] = (out[key] || 0) + 1;
  });
  return out;
}

export function normalizeModuleToken(value) {
  const text = String(value || "")
    .replace(/^\[|\]$/g, "")
    .replace(/^['"]|['"]$/g, "")
    .trim();
  if (!text) return "";
  return text
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    .replace(/:\d+(?::\d+)?$/g, "")
    .replace(/\.(?:py|js|ts|tsx|jsx)$/i, "")
    .replace(/^astrbot\.(?=(core|method|sources|pipeline|platform|provider)\.)/i, "")
    .trim();
}

export function humanizeModuleWord(value) {
  const text = String(value || "").trim();
  if (!text) return "未识别";
  if (/^openai$/i.test(text)) return "OpenAI";
  if (/^aiocqhttp$/i.test(text)) return "aiocqhttp";
  return text.replace(/_/g, " ");
}

export function compactPluginName(value) {
  const raw = String(value || "");
  const token = normalizeModuleToken(raw).replace(/^plugin\s*-\u003e\s*/i, "");
  if (!token) return "";
  let match = token.match(/^astrbot_plugin_([^.]+)(?:\.|$)/i);
  if (match) return match[1];
  match = raw.match(/(?:^|[^A-Za-z0-9_])(?:插件|plugin)[：:\s]+([A-Za-z0-9_\-.]+)/i);
  if (match) {
    const name = match[1].replace(/^astrbot_plugin_/i, "").replace(/\.main$/i, "").trim();
    if (name) return name;
  }
  match = raw.match(/\[([^\]]*astrbot_plugin_[^\]]*)\]/i);
  if (match) {
    const name = match[1].replace(/^astrbot_plugin_/i, "").replace(/\.main$/i, "").trim();
    if (name) return name;
  }
  return token.replace(/^astrbot_plugin_/i, "").replace(/\.main$/i, "").replace(/^plugins\//i, "");
}

export function moduleGroup(key, label, className, raw) {
  return { key, label, className, raw: raw || "" };
}

export function pluginModuleGroup(value, raw) {
  const name = compactPluginName(value);
  if (!name) return null;
  if (/^astrbot$/i.test(name)) {
    return moduleGroup("core:astrbot", "AstrBot 核心", "module-core", raw || value);
  }
  const key = String(name).toLowerCase().replace(/^_+/, "");
  const display = PLUGIN_DISPLAY_NAMES[key] || humanizeModuleWord(String(name).replace(/^_+/, ""));
  return moduleGroup(`plugin:${key}`, `插件: ${display}`, "module-plugin", raw || value);
}

export function pluginGroupFromMessage(message) {
  const text = String(message || "");
  const match = text.match(/\b(?:plugin|hook\([^)]*\))\s*-\u003e\s*([A-Za-z0-9_.-]+)(?:\s*-\s*([A-Za-z0-9_.:-]+))?/i);
  if (match) return pluginModuleGroup(match[1], match[0]);
  const bracketMatch = text.match(/\[([^\]]*astrbot_plugin_[^\]]*)\]/i);
  if (bracketMatch) return pluginModuleGroup(bracketMatch[1], bracketMatch[0]);
  const zhMatch = text.match(/(?:^|[^A-Za-z0-9_])(?:插件|plugin)[：:\s]+([A-Za-z0-9_\-.]+)/i);
  if (zhMatch) return pluginModuleGroup(zhMatch[1], zhMatch[0]);
  return null;
}

export function traceModuleGroup(entry, token) {
  const scope = normalizeModuleToken(entry.scope).toLowerCase();
  const fileName = String(entry.fileName || "").toLowerCase();
  if (scope !== "trace" && !fileName.includes("trace")) return null;
  const action = token && token.toLowerCase() !== "trace" ? token : "trace";
  const label = TRACE_ACTION_LABELS[action] || `Trace: ${humanizeModuleWord(action)}`;
  return moduleGroup(`trace:${action}`, label, "module-trace", entry.moduleName || entry.fileName);
}

export function isAngelHeartEntry(token, message) {
  return /^roles\./i.test(token)
    || /^core\.(angel_heart|conversation_ledger)/i.test(token)
    || /^astrbot_plugin_angel_heart(?:\.|$)/i.test(token)
    || String(message || "").includes("AngelHeart[");
}

// ============================================================================
// 模块分组缓存 (LRU) - 性能优化
// ============================================================================

const moduleGroupCache = new Map();
const MODULE_GROUP_CACHE_SIZE = 1000;

export function cachedNormalizeModuleGroup(entry) {
  // 生成缓存键
  const key = `${entry.moduleName || ''}|${entry.scope || ''}|${(entry.message || '').slice(0, 50)}`;

  // 检查缓存
  if (moduleGroupCache.has(key)) {
    return moduleGroupCache.get(key);
  }

  // 计算结果
  const group = normalizeModuleGroup(entry);

  // 存入缓存，实现 LRU 淘汰
  moduleGroupCache.set(key, group);
  if (moduleGroupCache.size > MODULE_GROUP_CACHE_SIZE) {
    const firstKey = moduleGroupCache.keys().next().value;
    moduleGroupCache.delete(firstKey);
  }

  return group;
}

// ============================================================================
// 模块分组逻辑
// ============================================================================

export function normalizeModuleGroup(entry) {
  const message = `${entry.message || ""} ${entry.summary || ""} ${entry.raw || ""}`;
  const fromMessage = pluginGroupFromMessage(message);
  if (fromMessage) return fromMessage;

  if (!entry.moduleName && !entry.scope && !entry.rawLevel) {
    const fileName = String(entry.fileName || "");
    if (fileName.toLowerCase().includes("trace")) {
      return moduleGroup("trace:continuation", "Trace: 续行", "module-trace", fileName);
    }
    return moduleGroup("module:continuation", "日志续行/未标记", "module-other", fileName);
  }

  const rawToken = entry.moduleName || entry.scope || entry.fileName || "";
  const token = normalizeModuleToken(rawToken);
  const lower = token.toLowerCase();

  const traceGroup = traceModuleGroup(entry, token);
  if (traceGroup) return traceGroup;

  if (isAngelHeartEntry(token, message)) {
    return moduleGroup("plugin:angel_heart", "插件: angel_heart", "module-plugin", rawToken);
  }

  if (/^astrbot_plugin_/i.test(token)) {
    return pluginModuleGroup(token, rawToken) || moduleGroup(`plugin:${token}`, `插件: ${token}`, "module-plugin", rawToken);
  }

  // 精确标签表：核心 / 插件模块 / 方法
  if (CORE_MODULE_LABELS[lower]) {
    const className = lower.startsWith("sources.") ? "module-model" : "module-core";
    return moduleGroup(`mod:${lower}`, CORE_MODULE_LABELS[lower], className, rawToken);
  }
  if (METHOD_MODULE_LABELS[lower]) {
    return moduleGroup(`method:${lower}`, METHOD_MODULE_LABELS[lower], "module-core", rawToken);
  }
  if (PLUG_MODULE_LABELS[lower]) {
    return moduleGroup(`plug:${lower}`, PLUG_MODULE_LABELS[lower], "module-plugin", rawToken);
  }
  if (String(entry.scope || "").toLowerCase() === "plug" && PLUG_MODULE_LABELS[lower]) {
    return moduleGroup(`plug:${lower}`, PLUG_MODULE_LABELS[lower], "module-plugin", rawToken);
  }

  // 前缀表：pipeline / runners / sources / platform adapters ...
  for (const [prefix, meta] of Object.entries(MODULE_PREFIX_LABELS || {})) {
    if (!lower.startsWith(prefix)) continue;
    const rest = lower.slice(prefix.length).split(".")[0] || "";
    if (prefix === "sources.") {
      if (rest === "request_retry") {
        return moduleGroup("model:request_retry", "模型: 请求重试", "module-model", rawToken);
      }
      const sourceName = rest.replace(/_source$/i, "") || "provider";
      return moduleGroup(`model:${sourceName}`, `模型请求: ${humanizeModuleWord(sourceName)}`, "module-model", rawToken);
    }
    if (prefix.startsWith("aiocqhttp") || prefix.startsWith("qqofficial")) {
      return moduleGroup(meta.keyPrefix, meta.label, meta.className, rawToken);
    }
    const label = rest
      ? `${meta.label.replace(/:.*$/, "")}: ${humanizeModuleWord(rest)}`
      : meta.label;
    return moduleGroup(
      `${meta.keyPrefix}:${lower}`,
      CORE_MODULE_LABELS[lower] || PLUG_MODULE_LABELS[lower] || label,
      meta.className,
      rawToken,
    );
  }

  if (lower.includes("aiocqhttp") || message.includes("RawMessage <Event")) {
    return moduleGroup("platform:aiocqhttp", "平台: aiocqhttp", "module-platform", rawToken);
  }

  if (lower.includes("qqofficial")) {
    return moduleGroup("platform:qqofficial", "平台: QQ 官方", "module-platform", rawToken);
  }

  if (lower.startsWith("sources.")) {
    const sourceName = lower.slice("sources.".length).split(".")[0].replace(/_source$/i, "");
    if (sourceName === "request_retry") {
      return moduleGroup("model:request_retry", "模型: 请求重试", "module-model", rawToken);
    }
    return moduleGroup(`model:${sourceName}`, `模型请求: ${humanizeModuleWord(sourceName)}`, "module-model", rawToken);
  }

  if (lower.includes("openai_source")) {
    return moduleGroup("model:openai", "模型请求: OpenAI", "module-model", rawToken);
  }

  if (lower.startsWith("core.")) {
    const label = CORE_MODULE_LABELS[lower] || `核心: ${humanizeModuleWord(lower.slice("core.".length))}`;
    return moduleGroup(`core:${lower}`, label, "module-core", rawToken);
  }

  if (lower.startsWith("star.")) {
    const label = CORE_MODULE_LABELS[lower] || `核心: ${humanizeModuleWord(lower.slice("star.".length))}`;
    return moduleGroup(`core:${lower}`, label, "module-core", rawToken);
  }

  if (lower.startsWith("method.")) {
    const label = METHOD_MODULE_LABELS[lower] || `方法: ${humanizeModuleWord(lower.slice("method.".length))}`;
    return moduleGroup(`method:${lower}`, label, "module-core", rawToken);
  }

  if (lower.startsWith("utils.")) {
    const label = CORE_MODULE_LABELS[lower] || `核心: ${humanizeModuleWord(lower.slice("utils.".length))}`;
    return moduleGroup(`utils:${lower}`, label, "module-core", rawToken);
  }

  if (/adapter|platform/i.test(token)) {
    return moduleGroup(`platform:${lower || "unknown"}`, `平台: ${humanizeModuleWord(token)}`, "module-platform", rawToken);
  }

  if (/^core$/i.test(token)) {
    return moduleGroup("core:astrbot", "AstrBot 核心", "module-core", rawToken);
  }

  if (/^plug$/i.test(token)) {
    return moduleGroup("plugin:unknown", "插件: 未识别", "module-plugin", rawToken);
  }

  // 形如 meme_manager.main / spectrecore.main 的插件模块
  if (/^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/i.test(lower) && !lower.startsWith("module:")) {
    const head = lower.split(".")[0];
    if (PLUGIN_DISPLAY_NAMES[head] || /plugin|manager|meme|spectre|heart|memory|living|relationship|period|poke|output|gitee|anysearch|bili/i.test(head)) {
      const display = PLUGIN_DISPLAY_NAMES[head] || humanizeModuleWord(head);
      return moduleGroup(`plugin:${head}`, `插件: ${display}`, "module-plugin", rawToken);
    }
  }

  const fallback = token || entry.fileName || "未识别";
  return moduleGroup(`module:${fallback.toLowerCase()}`, fallback, "module-other", rawToken);
}

export function aggregateModuleGroups(entries) {
  const groups = new Map();
  entries.forEach((entry) => {
    if (!entry.moduleName && !entry.scope && !entry.rawLevel) return;
    const group = cachedNormalizeModuleGroup(entry);
    const current = groups.get(group.key) || {
      key: group.key,
      label: group.label,
      className: group.className,
      value: 0,
      rawSamples: new Set(),
    };
    current.value += 1;
    if (group.raw) current.rawSamples.add(group.raw);
    groups.set(group.key, current);
  });

  return [...groups.values()]
    .map((item) => ({
      ...item,
      detail: [...item.rawSamples].slice(0, 4).join(" / "),
    }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, "zh-CN"));
}

export function eventTypeLabel(type) {
  return EVENT_TYPES[type]?.label || "事件";
}

export function eventTypeBadge(type) {
  return EVENT_TYPES[type]?.badge || "";
}

export function eventTypeClass(type) {
  return EVENT_TYPES[type]?.className || "";
}

/**
 * 将证据置信度数值/字符串转换为可读标签。
 * 后端目前未返回 confidence 字段，保留兼容处理。
 */
export function confidenceLabel(confidence) {
  if (confidence == null || confidence === "") return "--";
  const num = Number(confidence);
  if (Number.isNaN(num)) return String(confidence);
  if (num >= 0.9) return "高";
  if (num >= 0.7) return "较高";
  if (num >= 0.4) return "中";
  return "低";
}

export function stableHash(text) {
  let hash = 0;
  const value = String(text || "");
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

export function eventKey(spanId, type, entry, suffix = "") {
  const time = entryTimeMs(entry);
  const rawHash = stableHash(entry.raw || "");
  return `${spanId || "no-span"}:${type}:${time}:${rawHash}:${suffix}`;
}

export function evidenceFromEntry(entry, rule, parser = entry.trace ? "trace" : "plain", confidence = "high") {
  return {
    sourceName: entry.sourceName || "",
    path: entry.path || "",
    fileName: entry.fileName || "",
    lineNumber: entry.lineNumber || entry.lineIndex + 1,
    raw: entry.raw || "",
    rule,
    parser,
    confidence,
    spanId: entry.trace?.spanId || "",
    logEntryId: entry.id || "",
  };
}

export function evidenceDetailKey(event) {
  return detailKey("event-evidence", event.id, event.evidence?.logEntryId);
}

export function eventDurationLabel(ms, { prefix = "耗时" } = {}) {
  if (ms == null || !Number.isFinite(Number(ms)) || Number(ms) < 0) return "";
  return `${prefix} ${(Number(ms) / 1000).toFixed(1)} 秒`;
}

/** 端到端墙钟 ms：完成态用 wallMs，live 用 now-startTs */
export function sessionWallDurationMs(session, now = Date.now()) {
  if (!session) return null;
  if (session.wallMs != null && Number.isFinite(Number(session.wallMs))) {
    return Math.max(0, Number(session.wallMs));
  }
  const start = Number(session.startTs || 0);
  if (!Number.isFinite(start) || start <= 0) return null;
  const closed = ["complete", "error", "stale"].includes(session.status);
  const end = closed ? Number(session.lastTs || start) : now;
  if (!Number.isFinite(end) || end < start) return null;
  return Math.max(0, end - start);
}

/** 模型生成段 ms（stats） */
export function sessionGenerationMs(session) {
  if (!session) return null;
  const g = session.generationMs ?? null;
  if (g != null && Number.isFinite(Number(g)) && Number(g) >= 0) return Number(g);
  return null;
}

/**
 * 展示用「总耗时」：完成/错误优先墙钟，否则生成段；live 用墙钟进行中。
 */
export function sessionDisplayDurationMs(session, now = Date.now()) {
  if (!session) return null;
  const live = session.displayStatus === "running" || session.displayStatus === "generating"
    || (session.status !== "complete" && session.status !== "error" && session.status !== "stale"
      && (session.status === "running" || session.status === "generating"));
  // displayStatus 可能尚未写入，用 status
  const isLive = session.status === "running" || session.status === "generating";
  if (isLive) return sessionWallDurationMs(session, now);
  return session.wallMs ?? session.durationMs ?? sessionGenerationMs(session);
}

/** 平台 @ 提及：`[At:123]`（位置可能在正文前/后） */
const AT_MENTION_RE = /\[\s*At\s*:\s*\d+\s*\]/gi;

/**
 * 合并/身份匹配用正文规范化（不改 UI 展示原文）。
 * `[At:1] 摸摸头` 与 `摸摸头 [At:1]` → 同一 body + 同一 mentions。
 */
export function normalizeMessageOutlineForMatch(text) {
  const raw = String(text || "");
  const mentions = [];
  const without = raw.replace(AT_MENTION_RE, (match) => {
    const normalized = String(match || "").replace(/\s+/g, "").toLowerCase();
    if (normalized) mentions.push(normalized);
    return " ";
  });
  const body = compactText(without, 160).toLowerCase();
  if (!body && !mentions.length) return "";
  const mentionKey = [...new Set(mentions)].sort().join(",");
  return mentionKey ? `${body}|@${mentionKey}` : body;
}

export function messageDedupeKey(sender, content) {
  // 身份/去重：走 At 规范化，避免同句因 mention 位置拆成两条
  const text = normalizeMessageOutlineForMatch(content);
  return `${String(sender || "").trim().toLowerCase()}|${text}`;
}

/** 未完成会话 openIndex 键：umo|sender|normalizeOutline */
export function conversationKeyFrom({ umo = "", senderName = "", messageOutline = "" } = {}) {
  const outlineKey = normalizeMessageOutlineForMatch(messageOutline);
  if (!outlineKey) return "";
  const sender = String(senderName || "").trim().toLowerCase();
  const channel = String(umo || "").trim().toLowerCase();
  // 至少要有发送者或通道，避免仅正文过宽粘连
  if (!sender && !channel) return "";
  return `${channel}|${sender}|${outlineKey}`;
}

function splitSessionMessageKey(session) {
  const text = normalizeMessageOutlineForMatch(session?.messageOutline || "");
  if (!text) return "";
  return `${String(session?.senderName || "").trim().toLowerCase()}|${text}`;
}

function sessionConversationKey(session) {
  if (!session) return "";
  if (session.conversationKey) return session.conversationKey;
  return conversationKeyFrom({
    umo: session.umo,
    senderName: session.senderName,
    messageOutline: session.messageOutline,
  });
}

function sessionStartMs(session) {
  return Number(session?.startTs || session?.lastTs || 0) || 0;
}

function canMergeSplitSession(source, target) {
  if (!source || !target || source.spanId === target.spanId) return false;
  if (!source.hasMessageInTrace || source.enteredAgentFlow || source.status !== "running") return false;
  if (!target.enteredAgentFlow && !target.completed) return false;

  const sourceKey = splitSessionMessageKey(source);
  const targetKey = splitSessionMessageKey(target);
  // 两侧都有 messageOutline 时要求一致；一侧为空时放宽为仅比 sender
  if (sourceKey && targetKey && sourceKey !== targetKey) return false;
  if (!sourceKey && !targetKey) {
    const sourceSender = String(source.senderName || "").trim().toLowerCase();
    const targetSender = String(target.senderName || "").trim().toLowerCase();
    if (!sourceSender || !targetSender || sourceSender !== targetSender) return false;
  } else if (!sourceKey || !targetKey) {
    const sourceSender = String(source.senderName || "").trim().toLowerCase();
    const targetSender = String(target.senderName || "").trim().toLowerCase();
    if (sourceSender && targetSender && sourceSender !== targetSender) return false;
  }

  const sourceUmo = String(source.umo || "").trim();
  const targetUmo = String(target.umo || "").trim();
  // umo 一侧为空时不拦截；两侧都有才要求一致
  if (sourceUmo && targetUmo && sourceUmo !== targetUmo) return false;

  const sourceStart = sessionStartMs(source);
  const targetStart = sessionStartMs(target);
  if (!sourceStart || !targetStart) return false;
  const delta = Math.abs(targetStart - sourceStart);
  return delta <= SPLIT_SESSION_MERGE_WINDOW_MS;
}

function sessionIsPokeMessage(session) {
  return POKE_MESSAGE_PATTERN.test(String(session?.messageOutline || ""));
}

function sessionIdleMs(session, now) {
  return Math.max(0, now - (session?.lastTs || session?.startTs || 0));
}

function sessionIsStaleOpen(session, now, runningTimeoutMs) {
  if (!session) return false;
  if (session.status === "complete" || session.status === "error" || session.status === "stale") return false;
  if (session.status !== "running" && session.status !== "generating") return false;
  // 仅对已进入 Agent 的会话做 stale 收口；pre-agent 超时直接不可见
  if (!session.enteredAgentFlow && !session.completed) return false;
  return sessionIdleMs(session, now) > runningTimeoutMs;
}

function markStaleSessions(sessionList, now, runningTimeoutMs) {
  sessionList.forEach((session) => {
    if (!sessionIsStaleOpen(session, now, runningTimeoutMs)) return;
    // 仅投影收口：不改写 trace，只改展示状态
    session.status = "stale";
    session.stale = true;
  });
}

function isPreAgentVisible(session, now) {
  if (!session?.hasMessageInTrace || session.status !== "running") return false;
  if (session.enteredAgentFlow || session.completed) return false;
  // Poke / 明显非 Agent 交互：缩短可见窗口，避免长期占列表
  const limit = sessionIsPokeMessage(session) ? PRE_AGENT_POKE_VISIBLE_MS : PRE_AGENT_VISIBLE_MS;
  return sessionIdleMs(session, now) <= limit;
}

/** pre-agent 是否已有可合并的 agent/完成孪生（同 messageKey/sender/umo/时间窗） */
function hasAgentTwinSession(preAgent, sessionList) {
  if (!preAgent || !Array.isArray(sessionList) || !sessionList.length) return false;
  return sessionList.some((candidate) => canMergeSplitSession(preAgent, candidate));
}

function mergeTimestampMin(...values) {
  const normalized = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  return normalized.length ? Math.min(...normalized) : 0;
}

function mergeTimestampMax(...values) {
  const normalized = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  return normalized.length ? Math.max(...normalized) : 0;
}

function sortedSessionEventIds(eventIds, eventById) {
  return [...new Set(eventIds || [])]
    .filter((id) => eventById.has(id))
    .sort((a, b) => {
      const eventA = eventById.get(a);
      const eventB = eventById.get(b);
      return (eventA?.timestamp || 0) - (eventB?.timestamp || 0)
        || String(eventA?.type || "").localeCompare(String(eventB?.type || ""))
        || String(a).localeCompare(String(b));
    });
}

function dedupeSessionMessageEvents(eventIds, eventById, removedEventIds) {
  const seen = new Set();
  const next = [];
  eventIds.forEach((id) => {
    const event = eventById.get(id);
    if (!event) return;
    // message_in / persona：同 key 只留一条，避免双 span 入站各打一次
    if ((event.type === "message_in" || event.type === "persona") && (event.messageKey || event.detail)) {
      const key = event.type === "message_in"
        ? `${event.type}:${event.messageKey || event.detail}`
        : `${event.type}:${compactText(event.detail || "", 80)}`;
      if (seen.has(key)) {
        removedEventIds.add(id);
        return;
      }
      seen.add(key);
    }
    next.push(id);
  });
  return next;
}

export function sessionSourceLabel(session) {
  const umo = String(session?.umo || "");
  if (/Scheduler/i.test(session?.senderName || "") || /Scheduler/i.test(umo)) return "定时任务";
  if (/GroupMessage/i.test(umo)) return "群聊";
  if (/PrivateMessage|FriendMessage|DirectMessage/i.test(umo)) return "私聊";
  return "其他";
}

const IMAGE_REPLY_TOOLS = new Set([
  "aiimg_generate",
  "aiimg_batch_generate",
  "gitee_draw_image",
  "gitee_edit_image",
]);

const ACTION_REPLY_TOOLS = new Set([
  "delete_msg",
  "send_like",
  "set_group_ban",
  "set_group_card",
]);

const IMAGE_REPLY_PATTERNS = [
  /already been generated and sent to the user/i,
  /do not send another confirmation message/i,
  /已经生成并发送给用户/i,
  /图片.*已发送/i,
];

const EMOJI_ONLY_RESPONSE_PATTERN = /^&&([a-zA-Z]+)&&$/;
const POKE_MESSAGE_PATTERN = /\[ComponentType\.Poke\]/i;

function sessionResponseTextValue(session) {
  return String(session?.response || "").trim();
}

function sessionToolNames(session) {
  return (session?.tools || [])
    .map((tool) => String(tool?.name || "").trim().toLowerCase())
    .filter(Boolean);
}

function sessionToolResults(session) {
  return (session?.tools || [])
    .map((tool) => String(tool?.result || ""))
    .filter(Boolean);
}

function sessionHasTool(session, toolSet) {
  return sessionToolNames(session).some((name) => toolSet.has(name));
}

function sessionHasToolResult(session, patterns) {
  return sessionToolResults(session).some((result) => patterns.some((pattern) => pattern.test(result)));
}

function sessionOutputTokenCount(session) {
  return tokenValue(session?.tokenUsage, ["output", "output_text", "completion_tokens"]);
}

function sessionHasLoggedTextResponse(session) {
  const response = sessionResponseTextValue(session);
  return Boolean(response) && !EMOJI_ONLY_RESPONSE_PATTERN.test(response);
}

function sessionLooksLikeImageReply(session) {
  return sessionHasTool(session, IMAGE_REPLY_TOOLS) || sessionHasToolResult(session, IMAGE_REPLY_PATTERNS);
}

function sessionLooksLikeActionReply(session) {
  return sessionHasTool(session, ACTION_REPLY_TOOLS);
}

function sessionLooksLikeEmojiReply(session) {
  const response = sessionResponseTextValue(session);
  if (EMOJI_ONLY_RESPONSE_PATTERN.test(response)) return true;
  if (!response && POKE_MESSAGE_PATTERN.test(String(session?.messageOutline || ""))) return true;
  if (sessionLooksLikeImageReply(session) || sessionLooksLikeActionReply(session)) return false;
  return session.status === "complete"
    && !response
    && sessionOutputTokenCount(session) > 0
    && sessionOutputTokenCount(session) <= 8;
}

export function sessionReplyKind(session) {
  if (!session) return "pending";
  if (session.status === "error") return "error";
  if (sessionLooksLikeEmojiReply(session)) return "emoji";
  if (sessionHasLoggedTextResponse(session)) return "text";
  if (sessionLooksLikeImageReply(session)) return "image";
  if (sessionLooksLikeActionReply(session)) return "action";
  if (session.status === "complete") return "unknown";
  return "pending";
}

export function sessionReplyHint(session) {
  const kind = session?.replyKind || sessionReplyKind(session);
  if (kind === "image") {
    return "该会话已完成，图片已由绘图工具直接发送，日志里没有保留完整的文本正文。";
  }
  if (kind === "action") {
    return "该会话已完成，主要结果是执行动作类工具，例如撤回、点赞或群管理，日志里没有保留文本正文。";
  }
  if (kind === "emoji") {
    return "该会话已完成，可能通过表情包、戳一戳或其他轻互动方式完成了回复。";
  }
  if (kind === "unknown") {
    return "该会话已完成，但日志中没有记录最终文本正文，可能是非文本回复，也可能是正文未被 trace 保留下来。";
  }
  return "";
}

export function sessionDisplayStatus(session) {
  if (!session) return "pending";
  if (session.status === "complete" && !sessionHasLoggedTextResponse(session)) return "empty";
  if (session.status === "complete") return "complete";
  if (session.status === "error") return "error";
  if (session.status === "stale") return "stale";
  if (session.status === "generating") return "generating";
  if (session.status === "running") return "running";
  return "pending";
}

export function tokenTotal(tokenUsage) {
  return Object.values(safeObject(tokenUsage)).reduce((sum, value) => {
    const number = Number(value);
    return Number.isFinite(number) ? sum + number : sum;
  }, 0);
}

export function tokenValue(tokenUsage, keys) {
  const usage = safeObject(tokenUsage);
  return keys.reduce((sum, key) => {
    const number = Number(usage[key]);
    return Number.isFinite(number) ? sum + number : sum;
  }, 0);
}

export function addStat(map, key, detail = "") {
  const label = key || "未识别";
  const item = map.get(label) || { label, value: 0, detail };
  item.value += 1;
  if (detail && !item.detail) item.detail = detail;
  map.set(label, item);
}

export function statMapItems(map, className = "module-trace") {
  return [...map.values()]
    .map((item) => ({ ...item, className, unit: "次" }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, "zh-CN"));
}

export function parseEventBusMessage(entry) {
  if (!/core\.event_bus/i.test(entry.moduleName || "")) return null;
  const text = String(entry.message || "");
  const match = text.match(/(?:\[[^\]]+\]\s*)+([^/\n:]+)\/([^:\n]+):\s*(.*)$/);
  if (!match) return null;
  return {
    sender: match[1].trim(),
    senderId: match[2].trim(),
    content: match[3].trim(),
  };
}

export function isPluginHandlerLifecycleLog(entry, text) {
  return /star\.star_manager/i.test(entry.moduleName || "")
    && /(处理函数|handler|移除了|注册了|加载|卸载|enabled|disabled)/i.test(text);
}

export function isPlainOutgoingMessageLog(entry) {
  if (entry.level === "debug") return false;
  const text = `${entry.moduleName || ""} ${entry.message || ""} ${entry.raw || ""}`;
  if (isPluginHandlerLifecycleLog(entry, text)) return false;
  return /\bsend_message\b|Prepare to send|发送(?:群|私聊|好友|平台)?消息(?:成功|到|给)|发送回复(?:成功|到|给)/i.test(text);
}

const PLAIN_TOOL_CALL_PATTERNS = [
  /tool_call[:\s]*(.+?)(?:\s*[\(\.:]|\s*$)/i,
  /调用工具[：:\s]*([A-Za-z0-9_\-.]+)/i,
  /\[tool[:\s]+([A-Za-z0-9_\-.]+)\]/i,
  /tool_name[:\s]*['"]?([A-Za-z0-9_\-.]+)['"]?/i,
  /工具[：:\s]*([A-Za-z0-9_\-.]+?)(?:\s*(?:参数|args|\||$))/i,
];

const PLAIN_TOOL_RESULT_PATTERNS = [
  /tool_result[:\s]*(.+?)(?:\s*$)/i,
  /工具(?:返回|结果)[：:\s]*(.+?)(?:\s*$)/i,
  /\[tool_result\](.+?)(?:\s*$)/i,
];

export function isPlainToolCallLog(entry) {
  if (entry.trace) return null;
  // completion / provider repr 正文里常含 tool_calls 字段，禁止当 plain tool 事件
  if (isPlainProviderResponseLog(entry)) return null;
  const text = `${entry.message || ""} ${entry.summary || ""} ${entry.raw || ""}`;
  if (/\bcompletion:\s*ChatCompletion\b/i.test(text) || /\bChatCompletion\(/i.test(text) || /\bLLMResponse\(/i.test(text)) {
    return null;
  }
  for (const pattern of PLAIN_TOOL_CALL_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return { type: "tool_call", name: match[1].trim() || "未知工具" };
    }
  }
  return null;
}

export function isPlainToolResultLog(entry, toolName) {
  if (entry.trace) return null;
  if (isPlainProviderResponseLog(entry)) return null;
  const text = `${entry.message || ""} ${entry.summary || ""} ${entry.raw || ""}`;
  if (/\bcompletion:\s*ChatCompletion\b/i.test(text) || /\bChatCompletion\(/i.test(text) || /\bLLMResponse\(/i.test(text)) {
    return null;
  }
  for (const pattern of PLAIN_TOOL_RESULT_PATTERNS) {
    if (pattern.test(text)) return { type: "tool_result", name: toolName || "未知工具" };
  }
  return null;
}

const PLAIN_MEMORY_PATTERNS = [
  /memory_recall|memory_reflection|memory_processor/i,
  /记忆召回|检索到.*记忆|记忆反射|记忆注入|记忆格式化|操作成功完成.*记忆/i,
];

export function isPlainMemoryLog(entry) {
  const text = `${entry.moduleName || ""} ${entry.message || ""} ${entry.summary || ""} ${entry.raw || ""}`;
  if (entry.trace) return null;
  return PLAIN_MEMORY_PATTERNS.some((pattern) => pattern.test(text));
}

const PLAIN_WAKING_PATTERNS = [
  /waking_check/i,
  /enabled_plugins_name/i,
];

export function isPlainWakingLog(entry) {
  const text = `${entry.moduleName || ""} ${entry.message || ""} ${entry.summary || ""} ${entry.raw || ""}`;
  if (entry.trace) return null;
  return PLAIN_WAKING_PATTERNS.some((pattern) => pattern.test(text));
}

const PLAIN_HOOK_PATTERNS = [
  /pipeline\.context_utils/i,
  /hook\([^)]*Event\)/i,
];

export function isPlainHookLog(entry) {
  const text = `${entry.moduleName || ""} ${entry.message || ""} ${entry.summary || ""} ${entry.raw || ""}`;
  if (entry.trace) return null;
  return PLAIN_HOOK_PATTERNS.some((pattern) => pattern.test(text));
}

const PLAIN_AGENT_STAGE_PATTERNS = [
  /agent_sub_stages/i,
  /runners\.tool_loop_agent_runner/i,
  /runners\.base/i,
  /Agent state transition/i,
  /ready to request llm/i,
  /acquired session lock/i,
];

export function isPlainAgentStageLog(entry) {
  const text = `${entry.moduleName || ""} ${entry.message || ""} ${entry.summary || ""} ${entry.raw || ""}`;
  if (entry.trace) return null;
  return PLAIN_AGENT_STAGE_PATTERNS.some((pattern) => pattern.test(text));
}

const PLAIN_PIPELINE_PATTERNS = [
  /pipeline\.scheduler/i,
  /pipeline 执行完毕/i,
  /pipeline execution completed/i,
];

export function isPlainPipelineLog(entry) {
  const text = `${entry.moduleName || ""} ${entry.message || ""} ${entry.summary || ""} ${entry.raw || ""}`;
  if (entry.trace) return null;
  return PLAIN_PIPELINE_PATTERNS.some((pattern) => pattern.test(text));
}

const PLAIN_PROVIDER_RESPONSE_PATTERNS = [
  /sources\..*_source/i,
  /sources\.request_retry/i,
  /completion:\s*(?:ChatCompletion|Message|id='|id=")/i,
  /\bLLMResponse\(/i,
];

export function isPlainProviderResponseLog(entry) {
  const text = `${entry.moduleName || ""} ${entry.message || ""} ${entry.summary || ""} ${entry.raw || ""}`;
  if (entry.trace) return null;
  // request_retry 走 warn，不归 provider_response
  if (/request_retry/i.test(entry.moduleName || "") || /request_retry/i.test(text)) {
    return false;
  }
  return PLAIN_PROVIDER_RESPONSE_PATTERNS.some((pattern) => pattern.test(text));
}

function decodeReprString(value) {
  const text = String(value || "");
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char !== "\\" || i >= text.length - 1) {
      out += char;
      continue;
    }
    const next = text[++i];
    if (next === "n") out += "\n";
    else if (next === "r") out += "\r";
    else if (next === "t") out += "\t";
    else if (next === "\\" || next === "'" || next === '"') out += next;
    else out += next;
  }
  return out;
}

function readReprFieldValue(text, startIndex) {
  let idx = startIndex;
  while (idx < text.length && /\s/.test(text[idx])) idx += 1;
  const rest = text.slice(idx, idx + 8).toLowerCase();
  if (rest.startsWith("none") || rest.startsWith("null")) return { value: "", end: idx + 4 };
  const quote = text[idx];
  if (quote !== "'" && quote !== '"') return null;
  idx += 1;
  let raw = "";
  while (idx < text.length) {
    const char = text[idx];
    if (char === "\\") {
      raw += char;
      idx += 1;
      if (idx < text.length) raw += text[idx];
      idx += 1;
      continue;
    }
    if (char === quote) {
      return { value: decodeReprString(raw), end: idx + 1 };
    }
    raw += char;
    idx += 1;
  }
  return null;
}

function extractReprField(text, fieldNames) {
  const source = String(text || "");
  for (const fieldName of fieldNames) {
    const pattern = `${fieldName}=`;
    let from = 0;
    while (from < source.length) {
      const index = source.indexOf(pattern, from);
      if (index < 0) break;
      const prev = index > 0 ? source[index - 1] : "";
      if (prev && /[A-Za-z0-9_]/.test(prev)) {
        from = index + pattern.length;
        continue;
      }
      const parsed = readReprFieldValue(source, index + pattern.length);
      if (parsed) {
        if (String(parsed.value || "").trim()) return parsed.value;
        from = parsed.end;
      } else {
        from = index + pattern.length;
      }
    }
  }
  return "";
}

function extractCompletionId(text) {
  const value = String(text || "");
  const match = value.match(/\b(?:id|request_id)=['"]([^'"]+)['"]/i)
    || value.match(/"id"\s*:\s*"([^"]+)"/i)
    || value.match(/"request_id"\s*:\s*"([^"]+)"/i);
  return match ? match[1] : "";
}

function extractReasoningTokenCount(text) {
  const value = String(text || "");
  const match = value.match(/\breasoning_tokens\s*=\s*(\d+)/i)
    || value.match(/"reasoning_tokens"\s*:\s*(\d+)/i);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isFinite(number) ? number : null;
}

function normalizeCompareText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 严格 response 对齐：相等，或更长侧以完整 shorter 开头/结尾。
 * 废除任意 includes（≥12 子串），避免并发会话交叉绑定。
 */
function responseTextMatches(left, right) {
  const a = normalizeCompareText(left);
  const b = normalizeCompareText(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length > b.length ? a : b;
  // 过短文本不做边界扩展匹配，降低误绑
  if (shorter.length < 12) return false;
  return longer.startsWith(shorter) || longer.endsWith(shorter);
}

/** 同 completion / 同正文+思考 时标记为等价候选（用于 used set） */
function candidatePayloadSame(left, right) {
  if (!left || !right) return false;
  if (left.completionId && right.completionId && left.completionId === right.completionId) return true;
  if (left.reasoningContent !== right.reasoningContent) return false;
  if (!responseTextMatches(left.responseText, right.responseText)) return false;
  return Math.abs((left.timestamp || 0) - (right.timestamp || 0)) <= 5000;
}

/** 统一 entry 时间到毫秒：行内 timestamp 优先，否则 fileMtime(秒)×1000 */
export function entryTimeMs(entry) {
  const ts = Number(entry?.timestamp);
  if (Number.isFinite(ts) && ts > 0) return ts;
  const mtime = Number(entry?.fileMtime);
  if (Number.isFinite(mtime) && mtime > 0) {
    // fileMtime 来自后端 st_mtime（秒）；若已是 ms 量级则不再放大
    return mtime > 1e12 ? mtime : mtime * 1000;
  }
  return 0;
}

/** 与 trace buildTraceInfo 对齐的思考字段别名 */
const REASONING_FIELD_NAMES = [
  "reasoning_content",
  "reasoning",
  "thinking",
  "reason_content",
  "reasoningContent",
  "reasonContent",
];

const RESPONSE_FIELD_NAMES = ["content", "text", "resp", "response"];

function scoreNaturalLanguageField(value) {
  const text = String(value || "").trim();
  if (!text) return -1;
  // 空对象 / 纯 JSON 工具载荷：低分，避免抢到自然语言 content
  if (/^[{[][\s\S]*[}\]]$/.test(text) && !/[\u4e00-\u9fff]/.test(text) && text.length < 400) {
    return Math.min(text.length, 20);
  }
  if (text === "{}" || text === "[]" || text === "null" || text === "None") return -1;
  let score = text.length;
  if (/[\u4e00-\u9fff]/.test(text)) score += 80;
  if (/[。！？，、；：]/.test(text)) score += 20;
  if (/^[{[]/.test(text) && /[}\]]$/.test(text)) score -= 40;
  return score;
}

/**
 * 多段 content= 时取最长/最后非空自然语言，跳过 content={} 与纯 JSON 工具载荷。
 */
function extractReprFieldBest(text, fieldNames) {
  const source = String(text || "");
  let best = "";
  let bestScore = -1;
  for (const fieldName of fieldNames) {
    const pattern = `${fieldName}=`;
    let from = 0;
    while (from < source.length) {
      const index = source.indexOf(pattern, from);
      if (index < 0) break;
      const prev = index > 0 ? source[index - 1] : "";
      if (prev && /[A-Za-z0-9_]/.test(prev)) {
        from = index + pattern.length;
        continue;
      }
      const parsed = readReprFieldValue(source, index + pattern.length);
      if (!parsed) {
        from = index + pattern.length;
        continue;
      }
      const value = String(parsed.value || "").trim();
      const score = scoreNaturalLanguageField(value);
      // 同分时取后出现的（通常是最终回复 content，而非 tool payload）
      if (score > bestScore || (score === bestScore && score >= 0 && value.length >= best.length)) {
        best = value;
        bestScore = score;
      }
      from = parsed.end;
    }
  }
  return bestScore >= 0 ? best : "";
}

function extractJsonStringFieldBest(text, fieldNames) {
  const source = String(text || "");
  let best = "";
  let bestScore = -1;
  for (const fieldName of fieldNames) {
    const re = new RegExp(
      `["']${fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']\\s*:\\s*("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`,
      "ig",
    );
    let match;
    while ((match = re.exec(source))) {
      const quoted = match[1];
      const inner = quoted.slice(1, -1);
      const value = decodeReprString(inner).trim();
      const score = scoreNaturalLanguageField(value);
      if (score > bestScore || (score === bestScore && score >= 0 && value.length >= best.length)) {
        best = value;
        bestScore = score;
      }
    }
  }
  return bestScore >= 0 ? best : "";
}

/**
 * 从日志文本中解析 JSON 风格 "field": "..." 字符串值（支持简单转义）。
 */
function extractJsonStringField(text, fieldNames) {
  return extractJsonStringFieldBest(text, fieldNames);
}

/**
 * 尝试从整段 raw 中找 JSON 对象并读取字段（trace 以外的嵌套 provider 日志）。
 */
function extractJsonObjectField(text, fieldNames) {
  const source = String(text || "");
  const start = source.indexOf("{");
  if (start < 0) return "";
  let best = "";
  let bestScore = -1;
  // 从首个 { 起尝试若干截断解析，避免全行非 JSON 时白跑
  for (const end of [source.lastIndexOf("}"), source.length - 1]) {
    if (end <= start) continue;
    try {
      const obj = JSON.parse(source.slice(start, end + 1));
      if (!obj || typeof obj !== "object") continue;
      const queue = [obj];
      while (queue.length) {
        const cur = queue.shift();
        if (!cur || typeof cur !== "object") continue;
        for (const name of fieldNames) {
          const raw = cur[name];
          if (typeof raw !== "string") continue;
          const value = raw.trim();
          const score = scoreNaturalLanguageField(value);
          if (score > bestScore || (score === bestScore && score >= 0 && value.length >= best.length)) {
            best = value;
            bestScore = score;
          }
        }
        Object.values(cur).forEach((child) => {
          if (child && typeof child === "object") queue.push(child);
        });
      }
    } catch {
      // ignore
    }
  }
  return bestScore >= 0 ? best : "";
}

function extractTextField(raw, fieldNames) {
  return extractReprFieldBest(raw, fieldNames)
    || extractJsonStringField(raw, fieldNames)
    || extractJsonObjectField(raw, fieldNames)
    || "";
}

function looksLikeReasoningPayload(raw) {
  const text = String(raw || "");
  if (REASONING_FIELD_NAMES.some((name) => new RegExp(`${name}\\s*=`, "i").test(text))) return true;
  if (REASONING_FIELD_NAMES.some((name) => new RegExp(`["']${name}["']\\s*:`, "i").test(text))) return true;
  return false;
}

/**
 * 从 plain 日志抽取思考候选。export 供 fixture 单测。
 * @param {{ trace?: unknown, raw?: string, message?: string, id?: string, timestamp?: number, fileMtime?: number, moduleName?: string, summary?: string }} entry
 */
export function extractPlainReasoningCandidate(entry) {
  if (!entry || entry.trace) return null;
  const raw = String(entry.raw || entry.message || "");
  if (!looksLikeReasoningPayload(raw)) return null;

  const reasoningContent = extractTextField(raw, REASONING_FIELD_NAMES);
  if (!String(reasoningContent || "").trim()) return null;

  // 非空思考仍要求 provider / ChatCompletion 上下文，避免任意日志误抽
  const providerLike = isPlainProviderResponseLog(entry) || /\b(?:ChatCompletion|LLMResponse)\(/i.test(raw);
  if (!providerLike) return null;

  return {
    entry,
    logEntryId: entry.id || "",
    timestamp: entryTimeMs(entry),
    reasoningContent,
    responseText: extractTextField(raw, RESPONSE_FIELD_NAMES),
    completionId: extractCompletionId(raw),
    reasoningTokens: extractReasoningTokenCount(raw),
    kind: /completion:\s*ChatCompletion/i.test(raw)
      ? "completion"
      : (/\bLLMResponse\(/i.test(raw) ? "llm-response" : "provider"),
  };
}

function candidateSortForSession(referenceTs) {
  return (a, b) => {
    const aKind = a.kind === "completion" ? 0 : 1;
    const bKind = b.kind === "completion" ? 0 : 1;
    const aDelta = Math.abs((a.timestamp || 0) - referenceTs);
    const bDelta = Math.abs((b.timestamp || 0) - referenceTs);
    return aKind - bKind
      || aDelta - bDelta
      || String(a.completionId || "").localeCompare(String(b.completionId || ""))
      || String(a.logEntryId || "").localeCompare(String(b.logEntryId || ""));
  };
}

function candidateLooksLikeJsonPayload(candidate) {
  const text = String(candidate?.responseText || "").trim();
  if (!text) return false;
  if (text === "{}" || text === "[]") return true;
  return /^[{[]/.test(text) && /[}\]]$/.test(text) && !/[\u4e00-\u9fff]/.test(text) && text.length < 400;
}

/**
 * 多候选时：有 session.response 则仅严格 response 匹配；
 * 多命中且思考内容不同 → 弃绑；无 response 时仅单候选可绑。
 */
function selectReasoningCandidate(windowCandidates, session, referenceTs) {
  if (!windowCandidates.length) return null;
  const sessionResponse = String(session.response || "").trim();
  const hasResponse = Boolean(sessionResponse);
  const sessionLooksNatural = hasResponse && scoreNaturalLanguageField(sessionResponse) >= 40;

  if (hasResponse) {
    const responseMatches = windowCandidates.filter((candidate) => {
      if (!responseTextMatches(sessionResponse, candidate.responseText)) return false;
      // 侧路 JSON / 空对象 dump 不得挂到自然语言回复会话
      if (sessionLooksNatural && candidateLooksLikeJsonPayload(candidate)) return false;
      return true;
    });
    if (!responseMatches.length) return null;

    const uniqueContents = new Set(
      responseMatches.map((candidate) => String(candidate.reasoningContent || "").trim()).filter(Boolean),
    );
    // 同一 response 撞上多段不同思考 → 宁可空也不错挂
    if (uniqueContents.size > 1) return null;

    return responseMatches.sort(candidateSortForSession(referenceTs))[0];
  }

  // empty 完成：无正文可校验时，单候选且非 JSON side-call 才绑；多候选一律不猜
  const usable = windowCandidates.filter((candidate) => !candidateLooksLikeJsonPayload(candidate));
  if (usable.length === 1) return usable[0];
  return null;
}

const PLAIN_MESSAGE_CLEANUP_PATTERNS = [
  /event_handler_modules\.message_utils/i,
  /开始清理已总结消息|消息清理完成|跳过未知消息组件/i,
];

export function isPlainMessageCleanupLog(entry) {
  const text = `${entry.moduleName || ""} ${entry.message || ""} ${entry.summary || ""} ${entry.raw || ""}`;
  if (entry.trace) return null;
  return PLAIN_MESSAGE_CLEANUP_PATTERNS.some((pattern) => pattern.test(text));
}

const PLAIN_PLUGIN_LIFECYCLE_PATTERNS = [
  /star\.star_manager/i,
  /utils\.logger/i,
  /删除模块|加载模块|卸载模块|注册模块|插件初始化|Plugin Reload|资源清理|重新配置|发现平台|创建 PlatformAdapter|注册 bot 实例/i,
];

export function isPlainPluginLifecycleLog(entry) {
  const text = `${entry.moduleName || ""} ${entry.message || ""} ${entry.summary || ""} ${entry.raw || ""}`;
  if (entry.trace) return null;
  return PLAIN_PLUGIN_LIFECYCLE_PATTERNS.some((pattern) => pattern.test(text));
}

const PLAIN_CONVERSATION_PATTERNS = [
  /managers\.conversation_manager/i,
  /storage\.conversation_store/i,
  /event_handler_modules\.group_capture/i,
  /添加消息|会话信息|捕获群聊消息|原始sender对象|最终发送者信息/i,
];

export function isPlainConversationLog(entry) {
  const text = `${entry.moduleName || ""} ${entry.message || ""} ${entry.summary || ""} ${entry.raw || ""}`;
  if (entry.trace) return null;
  return PLAIN_CONVERSATION_PATTERNS.some((pattern) => pattern.test(text));
}

const PLAIN_DECORATE_PATTERNS = [
  /result_decorate\.stage/i,
  /respond\.stage/i,
  /on_decorating_result/i,
];

export function isPlainDecorateLog(entry) {
  const text = `${entry.moduleName || ""} ${entry.message || ""} ${entry.summary || ""} ${entry.raw || ""}`;
  if (entry.trace) return null;
  return PLAIN_DECORATE_PATTERNS.some((pattern) => pattern.test(text));
}

// ---------------------------------------------------------------------------
// 已装插件 plain 事件：优先标签 / 模块路径，避免过宽中文
// ---------------------------------------------------------------------------

function plainEntryText(entry) {
  return `${entry.moduleName || ""} ${entry.message || ""} ${entry.summary || ""} ${entry.raw || ""}`;
}

function isPlugScope(entry) {
  return String(entry.scope || "").toLowerCase() === "plug";
}

const PLAIN_DEBOUNCE_PATTERNS = [
  /astrbot_plugin_debounce/i,
  /\[Debounce\]/i,
  /完整概率\s*:\s*[\d.]+\s*\|\s*判定\s*:/i,
];

export function isPlainDebounceLog(entry) {
  if (entry.trace) return false;
  return PLAIN_DEBOUNCE_PATTERNS.some((pattern) => pattern.test(plainEntryText(entry)));
}

const PLAIN_MESSAGE_MERGE_PATTERNS = [
  /astrbot_plugin_nuoxiaomiao(?:_guard)?/i,
  /\[糯小喵\]\s*(?:merge|merged|dropped dialogue|on_llm_request blocked)/i,
  /\[糯小喵\]\s*merge\s+(?:started|append|release)/i,
];

export function isPlainMessageMergeLog(entry) {
  if (entry.trace) return false;
  const text = plainEntryText(entry);
  // 糯小喵的 meme 转 GIF 等噪声不记为 merge 事件
  if (/converted static meme|cleaned temp meme/i.test(text) && !/merge|dropped dialogue|blocked/i.test(text)) {
    return false;
  }
  if (/astrbot_plugin_nuoxiaomiao/i.test(entry.moduleName || "") || /\[糯小喵\]/i.test(text)) {
    return /merge|dropped dialogue|blocked|on_llm_request/i.test(text);
  }
  return PLAIN_MESSAGE_MERGE_PATTERNS.some((pattern) => pattern.test(text));
}

const PLAIN_HEARTFLOW_PATTERNS = [
  /astrbot_plugin_heartflow/i,
  /心流触发主动回复|心流设置唤醒标志|心流判断不通过|小参数模型判断成功/i,
  /冷却中，距上次回复还有|机器人回复已写入缓冲区/i,
];

export function isPlainHeartflowLog(entry) {
  if (entry.trace) return false;
  return PLAIN_HEARTFLOW_PATTERNS.some((pattern) => pattern.test(plainEntryText(entry)));
}

const PLAIN_MEME_PATTERNS = [
  /meme_manager(?:\.|$)/i,
  /\[meme_manager\]/i,
];

export function isPlainMemeLog(entry) {
  if (entry.trace) return false;
  return PLAIN_MEME_PATTERNS.some((pattern) => pattern.test(plainEntryText(entry)));
}

const PLAIN_CONTEXT_COMPACT_PATTERNS = [
  /AstrNa\s*已压缩/i,
  /AstrNa\s*已优化身份元数据/i,
  /group_chat_context_optimizer/i,
  /modules\.identity_metadata/i,
];

export function isPlainContextCompactLog(entry) {
  if (entry.trace) return false;
  return PLAIN_CONTEXT_COMPACT_PATTERNS.some((pattern) => pattern.test(plainEntryText(entry)));
}

const PLAIN_OUTPUT_PIPELINE_PATTERNS = [
  /\[Splitter\]/i,
  /智能引用/i,
  /step\.split/i,
  /core\.send_tracker/i,
];

export function isPlainOutputPipelineLog(entry) {
  if (entry.trace) return false;
  const text = plainEntryText(entry);
  // 核心 pipeline.scheduler 留给 pipeline 事件；出站仅 Plug 或明确标签
  if (/pipeline\.scheduler/i.test(text)) return false;
  if (isPlugScope(entry) && (/core\.pipeline/i.test(entry.moduleName || "") || PLAIN_OUTPUT_PIPELINE_PATTERNS.some((p) => p.test(text)))) {
    return true;
  }
  return PLAIN_OUTPUT_PIPELINE_PATTERNS.some((pattern) => pattern.test(text));
}

const PLAIN_GROUP_ANALYSIS_PATTERNS = [
  /\[群分析插件\]/i,
  /\[群分析相册\]/i,
  /\[分发器\]/i,
  /qq_group_daily_analysis/i,
  /自动分析任务执行|定时分析报告|增量分析/i,
];

export function isPlainGroupAnalysisLog(entry) {
  if (entry.trace) return false;
  return PLAIN_GROUP_ANALYSIS_PATTERNS.some((pattern) => pattern.test(plainEntryText(entry)));
}

const PLAIN_PROACTIVE_PATTERNS = [
  /spectrecore(?:\.|$)/i,
  /收到大模型回复喵|检测到读空气标记/i,
  /读空气/i,
];

export function isPlainProactiveLog(entry) {
  if (entry.trace) return false;
  const text = plainEntryText(entry);
  // 避免把「主动回复率」聊天正文误标（需 module 或明确标签）
  if (/spectrecore/i.test(entry.moduleName || "") || /收到大模型回复喵|检测到读空气标记|读空气标记/i.test(text)) {
    return true;
  }
  return false;
}

const PLAIN_RELATIONSHIP_PATTERNS = [
  /astrbot_plugin_yeli_relationship/i,
  /\[关系本\]/i,
];

export function isPlainRelationshipLog(entry) {
  if (entry.trace) return false;
  return PLAIN_RELATIONSHIP_PATTERNS.some((pattern) => pattern.test(plainEntryText(entry)));
}

const PLAIN_TOOL_AUTH_PATTERNS = [
  /tool_auth|工具鉴权|鉴权拒绝|无权限调用工具/i,
];

export function isPlainToolAuthLog(entry) {
  if (entry.trace) return false;
  return PLAIN_TOOL_AUTH_PATTERNS.some((pattern) => pattern.test(plainEntryText(entry)));
}

function makePlainEvent(entry, type, title, options = {}) {
  return {
    id: `plain:${entry.id}`,
    timestamp: entryTimeMs(entry),
    type,
    title,
    detail: compactText(entry.summary || entry.message || entry.raw, options.detailLen || 220),
    meta: [entry.scope, entry.moduleName].filter(Boolean).join(" | "),
    raw: entry.raw,
    sensitive: options.sensitive ?? false,
    evidence: evidenceFromEntry(entry, options.evidenceSource || `plain:${type}`, "plain", options.confidence || "medium"),
  };
}

export function plainLogEvent(entry) {
  if (entry.trace) return null;
  const eventBus = parseEventBusMessage(entry);
  if (eventBus) {
    return {
      id: `plain:${entry.id}`,
      timestamp: entryTimeMs(entry),
      type: "message_in",
      title: eventBus.sender ? `收到 ${eventBus.sender} 的消息` : "收到平台消息",
      detail: compactText(eventBus.content || "空消息或平台通知", 180),
      meta: [entry.scope, entry.moduleName].filter(Boolean).join(" | "),
      raw: entry.raw,
      sensitive: true,
      sensitiveMeta: true,
      messageKey: messageDedupeKey(eventBus.sender, eventBus.content),
      evidence: evidenceFromEntry(entry, "core.event_bus", "plain", "high"),
    };
  }

  // 插件诊断事件：放在通用 hook/pipeline/warn 之前，避免被吞
  if (isPlainDebounceLog(entry)) {
    return makePlainEvent(entry, "debounce", "防抖判定", { sensitive: false, confidence: "high" });
  }
  if (isPlainMessageMergeLog(entry)) {
    return makePlainEvent(entry, "message_merge", "消息合并", { sensitive: true, confidence: "high" });
  }
  if (isPlainHeartflowLog(entry)) {
    return makePlainEvent(entry, "heartflow", "心流判定", { sensitive: true, confidence: "high" });
  }
  if (isPlainMemeLog(entry)) {
    return makePlainEvent(entry, "meme", "表情匹配", { sensitive: false, confidence: "medium" });
  }
  if (isPlainContextCompactLog(entry)) {
    return makePlainEvent(entry, "context_compact", "上下文压缩", { sensitive: false, confidence: "high" });
  }
  if (isPlainOutputPipelineLog(entry)) {
    return makePlainEvent(entry, "output_pipeline", "出站管线", { sensitive: false, confidence: "medium" });
  }
  if (isPlainGroupAnalysisLog(entry)) {
    return makePlainEvent(entry, "group_analysis", "群分析任务", { sensitive: false, confidence: "medium" });
  }
  if (isPlainProactiveLog(entry)) {
    return makePlainEvent(entry, "proactive", "主动回复", { sensitive: true, confidence: "medium" });
  }
  if (isPlainRelationshipLog(entry)) {
    return makePlainEvent(entry, "relationship", "关系本", { sensitive: true, confidence: "medium" });
  }
  if (isPlainToolAuthLog(entry)) {
    return makePlainEvent(entry, "tool_auth", "工具鉴权", { sensitive: false, confidence: "high" });
  }

  // 记忆操作、唤醒检查、Pipeline Hook、Agent 阶段、Pipeline 调度
  if (isPlainMemoryLog(entry)) {
    return {
      id: `plain:${entry.id}`,
      timestamp: entryTimeMs(entry),
      type: "memory",
      title: "记忆操作",
      detail: compactText(entry.summary || entry.message || entry.raw, 220),
      meta: [entry.scope, entry.moduleName].filter(Boolean).join(" | "),
      raw: entry.raw,
      sensitive: true,
      evidence: evidenceFromEntry(entry, "plain:memory", "plain", "medium"),
    };
  }

  if (isPlainWakingLog(entry)) {
    return {
      id: `plain:${entry.id}`,
      timestamp: entryTimeMs(entry),
      type: "waking",
      title: "唤醒检查",
      detail: compactText(entry.summary || entry.message || entry.raw, 180),
      meta: [entry.scope, entry.moduleName].filter(Boolean).join(" | "),
      raw: entry.raw,
      sensitive: false,
      evidence: evidenceFromEntry(entry, "plain:waking", "plain", "low"),
    };
  }

  if (isPlainHookLog(entry)) {
    return {
      id: `plain:${entry.id}`,
      timestamp: entryTimeMs(entry),
      type: "hook",
      title: "Pipeline Hook",
      detail: compactText(entry.summary || entry.message || entry.raw, 220),
      meta: [entry.scope, entry.moduleName].filter(Boolean).join(" | "),
      raw: entry.raw,
      sensitive: false,
      evidence: evidenceFromEntry(entry, "plain:hook", "plain", "low"),
    };
  }

  if (isPlainAgentStageLog(entry)) {
    return {
      id: `plain:${entry.id}`,
      timestamp: entryTimeMs(entry),
      type: "agent_stage",
      title: "Agent 阶段",
      detail: compactText(entry.summary || entry.message || entry.raw, 220),
      meta: [entry.scope, entry.moduleName].filter(Boolean).join(" | "),
      raw: entry.raw,
      sensitive: false,
      evidence: evidenceFromEntry(entry, "plain:agent_stage", "plain", "low"),
    };
  }

  if (isPlainPipelineLog(entry)) {
    return {
      id: `plain:${entry.id}`,
      timestamp: entryTimeMs(entry),
      type: "pipeline",
      title: "Pipeline 执行",
      detail: compactText(entry.summary || entry.message || entry.raw, 180),
      meta: [entry.scope, entry.moduleName].filter(Boolean).join(" | "),
      raw: entry.raw,
      sensitive: false,
      evidence: evidenceFromEntry(entry, "plain:pipeline", "plain", "low"),
    };
  }

  if (isPlainProviderResponseLog(entry)) {
    return {
      id: `plain:${entry.id}`,
      timestamp: entryTimeMs(entry),
      type: "provider_response",
      title: "模型响应",
      detail: compactText(entry.summary || entry.message || entry.raw, 220),
      meta: [entry.scope, entry.moduleName].filter(Boolean).join(" | "),
      raw: entry.raw,
      sensitive: true,
      evidence: evidenceFromEntry(entry, "plain:provider_response", "plain", "medium"),
    };
  }

  if (isPlainMessageCleanupLog(entry)) {
    return {
      id: `plain:${entry.id}`,
      timestamp: entryTimeMs(entry),
      type: "message_cleanup",
      title: "消息清理",
      detail: compactText(entry.summary || entry.message || entry.raw, 220),
      meta: [entry.scope, entry.moduleName].filter(Boolean).join(" | "),
      raw: entry.raw,
      sensitive: false,
      evidence: evidenceFromEntry(entry, "plain:message_cleanup", "plain", "low"),
    };
  }

  if (isPlainDecorateLog(entry)) {
    return {
      id: `plain:${entry.id}`,
      timestamp: entryTimeMs(entry),
      type: "decorate",
      title: "结果装饰",
      detail: compactText(entry.summary || entry.message || entry.raw, 220),
      meta: [entry.scope, entry.moduleName].filter(Boolean).join(" | "),
      raw: entry.raw,
      sensitive: false,
      evidence: evidenceFromEntry(entry, "plain:decorate", "plain", "low"),
    };
  }

  if (isPlainConversationLog(entry)) {
    return {
      id: `plain:${entry.id}`,
      timestamp: entryTimeMs(entry),
      type: "conversation",
      title: "会话操作",
      detail: compactText(entry.summary || entry.message || entry.raw, 220),
      meta: [entry.scope, entry.moduleName].filter(Boolean).join(" | "),
      raw: entry.raw,
      sensitive: true,
      evidence: evidenceFromEntry(entry, "plain:conversation", "plain", "low"),
    };
  }

  if (isPlainPluginLifecycleLog(entry)) {
    return {
      id: `plain:${entry.id}`,
      timestamp: entryTimeMs(entry),
      type: "plugin_lifecycle",
      title: "插件生命周期",
      detail: compactText(entry.summary || entry.message || entry.raw, 220),
      meta: [entry.scope, entry.moduleName].filter(Boolean).join(" | "),
      raw: entry.raw,
      sensitive: false,
      evidence: evidenceFromEntry(entry, "plain:plugin_lifecycle", "plain", "low"),
    };
  }

  if (entry.level === "error") {
    return {
      id: `plain:${entry.id}`,
      timestamp: entryTimeMs(entry),
      type: "error",
      title: "日志错误",
      detail: compactText(entry.summary || entry.message || entry.raw, 240),
      meta: [entry.scope, entry.moduleName].filter(Boolean).join(" | "),
      raw: entry.raw,
      sensitive: true,
      evidence: evidenceFromEntry(entry, "level:error", "plain", "high"),
    };
  }

  if (entry.level === "warn") {
    return {
      id: `plain:${entry.id}`,
      timestamp: entryTimeMs(entry),
      type: "warn",
      title: "日志警告",
      detail: compactText(entry.summary || entry.message || entry.raw, 220),
      meta: [entry.scope, entry.moduleName].filter(Boolean).join(" | "),
      raw: entry.raw,
      sensitive: true,
      evidence: evidenceFromEntry(entry, "level:warn", "plain", "high"),
    };
  }

  if (isPlainOutgoingMessageLog(entry)) {
    return {
      id: `plain:${entry.id}`,
      timestamp: entryTimeMs(entry),
      type: "message_out",
      title: "发送 API 日志",
      detail: compactText(entry.summary || entry.message || entry.raw, 220),
      meta: [entry.scope, entry.moduleName].filter(Boolean).join(" | "),
      raw: entry.raw,
      sensitive: true,
      evidence: evidenceFromEntry(entry, "plain:send_message", "plain", "high"),
    };
  }

  const toolCall = isPlainToolCallLog(entry);
  if (toolCall) {
    return {
      id: `plain:${entry.id}`,
      timestamp: entryTimeMs(entry),
      type: "tool_call",
      title: `工具调用 ${toolCall.name}`,
      detail: compactText(entry.summary || entry.message || entry.raw, 220),
      meta: [entry.scope, entry.moduleName, toolCall.name].filter(Boolean).join(" | "),
      raw: entry.raw,
      sensitive: true,
      toolName: toolCall.name,
      evidence: evidenceFromEntry(entry, "plain:tool_call", "plain", "high"),
    };
  }

  const toolResult = isPlainToolResultLog(entry);
  if (toolResult) {
    return {
      id: `plain:${entry.id}`,
      timestamp: entryTimeMs(entry),
      type: "tool_result",
      title: `工具返回 ${toolResult.name}`,
      detail: compactText(entry.summary || entry.message || entry.raw, 220),
      meta: [entry.scope, entry.moduleName].filter(Boolean).join(" | "),
      raw: entry.raw,
      sensitive: true,
      toolName: toolResult.name,
      evidence: evidenceFromEntry(entry, "plain:tool_result", "plain", "medium"),
    };
  }

  return null;
}

export function buildTraceInsights(entries) {
  const traceEntries = entries
    .filter((entry) => entry.trace)
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0) || a.globalIndex - b.globalIndex);
  const plainReasoningCandidates = entries
    .filter((entry) => !entry.trace)
    .map((entry) => extractPlainReasoningCandidate(entry))
    .filter(Boolean)
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  const sessions = new Map();
  // spanId → session：同 span 续写 O(1)
  const spanIndex = new Map();
  // conversationKey → 未完成 session：入站即归属，不靠事后 merge
  const openByConversation = new Map();
  const events = [];
  const toolCalls = [];
  const newestTraceTs = Math.max(0, ...traceEntries.map((entry) => entry.timestamp || entry.trace?.time || 0));
  const now = Math.max(Date.now(), newestTraceTs);
  const slowToolMs = state.ui.slowToolMs || DEFAULT_SLOW_TOOL_MS;
  const slowSessionMs = state.ui.slowSessionMs || DEFAULT_SLOW_SESSION_MS;
  const runningTimeoutMs = state.ui.runningTimeoutMs || DEFAULT_RUNNING_TIMEOUT_MS;

  function registerSpan(session, spanId) {
    if (!session || !spanId) return;
    spanIndex.set(spanId, session);
    if (session.spanId === spanId) return;
    const aliases = new Set([...(session.aliasSpanIds || []), spanId].filter(Boolean));
    aliases.delete(session.spanId);
    session.aliasSpanIds = [...aliases];
  }

  function rememberOpenSession(session) {
    if (!session) return;
    const key = conversationKeyFrom({
      umo: session.umo,
      senderName: session.senderName,
      messageOutline: session.messageOutline,
    });
    if (!key) return;
    const prevKey = session.conversationKey || "";
    if (prevKey && prevKey !== key && openByConversation.get(prevKey) === session) {
      openByConversation.delete(prevKey);
    }
    session.conversationKey = key;
    if (session.status === "complete" || session.status === "error" || session.status === "stale") {
      if (openByConversation.get(key) === session) openByConversation.delete(key);
      return;
    }
    openByConversation.set(key, session);
  }

  function closeOpenSession(session) {
    if (!session) return;
    const key = session.conversationKey || sessionConversationKey(session);
    if (key && openByConversation.get(key) === session) openByConversation.delete(key);
  }

  function findOpenSessionForTrace(trace, ts) {
    const key = conversationKeyFrom({
      umo: trace.umo,
      senderName: trace.senderName,
      messageOutline: trace.messageOutline,
    });
    if (!key) return null;
    const open = openByConversation.get(key);
    if (!open) return null;
    if (open.status === "complete" || open.status === "error" || open.status === "stale") {
      openByConversation.delete(key);
      return null;
    }
    const openStart = sessionStartMs(open);
    const entryTs = Number(ts || 0);
    if (openStart && entryTs && Math.abs(entryTs - openStart) > SPLIT_SESSION_MERGE_WINDOW_MS) {
      return null;
    }
    // umo 双侧冲突拒绝（conversationKey 已含 umo；此处防空 key 降级）
    const openUmo = String(open.umo || "").trim();
    const entryUmo = String(trace.umo || "").trim();
    if (openUmo && entryUmo && openUmo !== entryUmo) return null;
    return open;
  }

  function pushEvent(event) {
    const normalized = {
      id: event.id || `${event.spanId || ""}:${event.type}:${event.timestamp || 0}:${events.length}`,
      timestamp: event.timestamp || 0,
      spanId: event.spanId || "",
      type: event.type,
      title: event.title || eventTypeLabel(event.type),
      detail: event.detail || "",
      meta: event.meta || "",
      durationMs: event.durationMs ?? null,
      raw: event.raw || "",
      sensitive: Boolean(event.sensitive),
      sensitiveMeta: Boolean(event.sensitiveMeta),
      messageKey: event.messageKey || "",
      evidence: event.evidence || null,
    };
    events.push(normalized);
    return normalized;
  }

  function pushSessionEvent(session, event) {
    const normalized = pushEvent(event);
    if (session) session.events.push(normalized.id);
    return normalized;
  }

  function ensureSession(entry) {
    const trace = entry.trace || {};
    const spanId = trace.spanId || entry.id;
    const ts = entry.timestamp || trace.time || 0;
    const hasMessageInTrace = trace.action === "message_in"
      || Boolean(trace.senderName || trace.umo || trace.messageOutline);

    // 1) 同 span 续写
    let session = spanIndex.get(spanId) || sessions.get(spanId);
    if (session) {
      session.lastTs = Math.max(session.lastTs || 0, ts || 0);
      if (trace.senderName) session.senderName = trace.senderName;
      if (trace.umo) session.umo = trace.umo;
      if (trace.messageOutline) {
        // 展示：保留更完整的一份 outline
        const prev = String(session.messageOutline || "");
        const next = String(trace.messageOutline || "");
        if (!prev || next.length >= prev.length) session.messageOutline = next;
      }
      if (hasMessageInTrace) session.hasMessageInTrace = true;
      rememberOpenSession(session);
      return session;
    }

    // 2) 不同 span：入站归属到未完成同 conversationKey 会话
    const open = findOpenSessionForTrace(trace, ts);
    if (open) {
      registerSpan(open, spanId);
      open.lastTs = Math.max(open.lastTs || 0, ts || 0);
      if (trace.senderName) open.senderName = trace.senderName;
      if (trace.umo) open.umo = trace.umo;
      if (trace.messageOutline) {
        const prev = String(open.messageOutline || "");
        const next = String(trace.messageOutline || "");
        if (!prev || next.length >= prev.length) open.messageOutline = next;
      }
      if (hasMessageInTrace) open.hasMessageInTrace = true;
      // 挂载 alias：不重复合成 message_in
      rememberOpenSession(open);
      return open;
    }

    // 3) 新建：从第一条 trace 起就是唯一 session 对象
    session = {
      spanId,
      aliasSpanIds: [],
      startTs: ts || 0,
      lastTs: ts || 0,
      senderName: trace.senderName || "",
      umo: trace.umo || "",
      messageOutline: trace.messageOutline || "",
      conversationKey: conversationKeyFrom({
        umo: trace.umo,
        senderName: trace.senderName,
        messageOutline: trace.messageOutline,
      }),
      personaId: "",
      status: "running",
      response: "",
      durationMs: null,
      generationMs: null,
      wallMs: null,
      timeToFirstTokenMs: null,
      tokenUsage: {},
      reasoningContent: "",
      reasoningLogEntryId: "",
      reasoningTs: null,
      reasoningTokens: null,
      reasoningSource: "",
      reasoningCompletionId: "",
      providerId: "",
      model: "",
      modelRequest: null,
      enteredAgentFlow: false,
      hasMessageInTrace,
      tools: [],
      events: [],
    };
    sessions.set(spanId, session);
    registerSpan(session, spanId);
    rememberOpenSession(session);
    pushSessionEvent(session, {
      id: eventKey(spanId, "message_in", entry),
      timestamp: ts,
      spanId,
      type: "message_in",
      title: trace.senderName ? `收到 ${trace.senderName} 的消息` : "收到消息",
      detail: compactText(trace.messageOutline || "消息内容未记录", 180),
      meta: trace.umo || "",
      raw: entry.raw,
      sensitive: true,
      sensitiveMeta: true,
      messageKey: messageDedupeKey(trace.senderName, trace.messageOutline),
      evidence: evidenceFromEntry(entry, `trace:${trace.action || "message_in"}`, "trace", "high"),
    });
    return session;
  }

  function mergeSessionIntoTarget(source, target, eventById, removedEventIds) {
    // 安全网：乱序/缺字段时补折叠；主路径已在 ensureSession 入站归属
    const aliasSpanIds = new Set([
      ...(target.aliasSpanIds || []),
      source.spanId,
      ...(source.aliasSpanIds || []),
    ].filter(Boolean));
    target.aliasSpanIds = [...aliasSpanIds];
    registerSpan(target, source.spanId);
    (source.aliasSpanIds || []).forEach((id) => registerSpan(target, id));

    const startTs = mergeTimestampMin(target.startTs, source.startTs);
    const lastTs = mergeTimestampMax(target.lastTs, source.lastTs);
    if (startTs) target.startTs = startTs;
    if (lastTs) target.lastTs = lastTs;

    target.hasMessageInTrace = Boolean(target.hasMessageInTrace || source.hasMessageInTrace);
    if (!target.senderName && source.senderName) target.senderName = source.senderName;
    if (!target.umo && source.umo) target.umo = source.umo;
    if (!target.messageOutline && source.messageOutline) target.messageOutline = source.messageOutline;
    if (!target.personaId && source.personaId) target.personaId = source.personaId;
    if (!target.conversationKey && source.conversationKey) target.conversationKey = source.conversationKey;
    if (!target.reasoningContent && source.reasoningContent) {
      target.reasoningContent = source.reasoningContent;
      target.reasoningLogEntryId = source.reasoningLogEntryId || "";
      target.reasoningTs = source.reasoningTs || null;
      target.reasoningTokens = source.reasoningTokens ?? null;
      target.reasoningSource = source.reasoningSource || "";
      target.reasoningCompletionId = source.reasoningCompletionId || "";
    } else if (target.reasoningTokens == null && source.reasoningTokens != null) {
      target.reasoningTokens = source.reasoningTokens;
    }
    if (!target.reasoningCompletionId && source.reasoningCompletionId) {
      target.reasoningCompletionId = source.reasoningCompletionId;
    }
    if (target.generationMs == null && source.generationMs != null) {
      target.generationMs = source.generationMs;
    }
    if (target.wallMs == null && source.wallMs != null) {
      target.wallMs = source.wallMs;
    }
    if (target.durationMs == null && source.durationMs != null) {
      target.durationMs = source.durationMs;
    }
    if (target.timeToFirstTokenMs == null && source.timeToFirstTokenMs != null) {
      target.timeToFirstTokenMs = source.timeToFirstTokenMs;
    }
    // modelRequest：优先较新 prepare；否则补齐缺失
    if (source.modelRequest) {
      const sourceTs = Number(source.modelRequest.prepareTs || 0);
      const targetTs = Number(target.modelRequest?.prepareTs || 0);
      if (!target.modelRequest || sourceTs >= targetTs) {
        target.modelRequest = source.modelRequest;
      }
    }

    if (Array.isArray(source.tools) && source.tools.length) {
      const existingTools = new Set((target.tools || []).map((tool) => tool.id || `${tool.name}:${tool.startTs || 0}`));
      source.tools.forEach((tool) => {
        tool.spanId = target.spanId;
        const key = tool.id || `${tool.name}:${tool.startTs || 0}`;
        if (!existingTools.has(key)) {
          existingTools.add(key);
          target.tools.push(tool);
        }
      });
    }

    (source.events || []).forEach((eventId) => {
      const event = eventById.get(eventId);
      if (event) event.spanId = target.spanId;
    });
    const sortedEventIds = sortedSessionEventIds([
      ...(target.events || []),
      ...(source.events || []),
    ], eventById);
    target.events = dedupeSessionMessageEvents(sortedEventIds, eventById, removedEventIds);
    closeOpenSession(source);
    rememberOpenSession(target);
  }

  /** 安全网：补扫仍分裂的 pre→agent；主路径不依赖此步 */
  function mergeSplitSessions() {
    const eventById = new Map(events.map((event) => [event.id, event]));
    const removedEventIds = new Set();
    const allSessions = [...sessions.values()].sort((a, b) => sessionStartMs(a) - sessionStartMs(b));
    const targets = allSessions.filter((session) => session.enteredAgentFlow || session.completed);

    allSessions.forEach((source) => {
      if (!source.hasMessageInTrace || source.enteredAgentFlow || source.status !== "running") return;
      // 已被入站归属挂到别人名下的不会再以独立 session 存在
      if (!sessions.has(source.spanId)) return;
      const target = targets
        .filter((candidate) => canMergeSplitSession(source, candidate))
        .sort((a, b) => {
          const sourceStart = sessionStartMs(source);
          return Math.abs(sessionStartMs(a) - sourceStart) - Math.abs(sessionStartMs(b) - sourceStart)
            || sessionStartMs(a) - sessionStartMs(b);
        })[0];
      if (!target) return;
      mergeSessionIntoTarget(source, target, eventById, removedEventIds);
      sessions.delete(source.spanId);
      closeOpenSession(source);
    });

    if (removedEventIds.size) {
      for (let i = events.length - 1; i >= 0; i--) {
        if (removedEventIds.has(events[i].id)) events.splice(i, 1);
      }
    }
  }

  function sessionCompleteEvent(session) {
    const ids = new Set(session.events || []);
    return events
      .filter((event) => ids.has(event.id) && event.type === "message_out")
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0] || null;
  }

  function assignReasoningFromCandidate(session, candidate, source = "plain") {
    if (!session || !candidate || !candidate.reasoningContent) return;
    session.reasoningContent = candidate.reasoningContent;
    session.reasoningLogEntryId = candidate.logEntryId || "";
    session.reasoningTs = candidate.timestamp || null;
    session.reasoningTokens = candidate.reasoningTokens ?? session.reasoningTokens ?? null;
    session.reasoningSource = source;
    session.reasoningCompletionId = candidate.completionId || session.reasoningCompletionId || "";
  }

  function attachPlainReasoningToSessions() {
    if (!plainReasoningCandidates.length) return;
    const usedLogEntries = new Set();
    // 有 response 时窗口略放宽（±120s）；无 response 仍严格（前 60s / 后 30s）
    // 强 key（有 response）会话优先，避免仅靠时间顺序抢占候选
    const completed = [...sessions.values()]
      .filter((session) => !session.reasoningContent && session.status === "complete")
      .sort((a, b) => {
        const aHas = Boolean(String(a.response || "").trim()) ? 0 : 1;
        const bHas = Boolean(String(b.response || "").trim()) ? 0 : 1;
        return aHas - bHas || (a.lastTs || 0) - (b.lastTs || 0);
      });
    completed.forEach((session) => {
      const completeEvent = sessionCompleteEvent(session);
      const referenceTs = completeEvent?.timestamp || session.lastTs || session.startTs || 0;
      if (!referenceTs) return;
      const hasResponse = Boolean(String(session.response || "").trim());
      const windowBeforeMs = hasResponse ? 120 * 1000 : 60 * 1000;
      const windowAfterMs = hasResponse ? 120 * 1000 : 30 * 1000;
      const windowCandidates = plainReasoningCandidates.filter((candidate) => {
        if (!candidate.logEntryId || usedLogEntries.has(candidate.logEntryId)) return false;
        const ts = candidate.timestamp || 0;
        if (!ts) return false;
        return ts >= referenceTs - windowBeforeMs && ts <= referenceTs + windowAfterMs;
      });
      if (!windowCandidates.length) return;

      const selected = selectReasoningCandidate(windowCandidates, session, referenceTs);
      if (!selected) return;
      assignReasoningFromCandidate(session, selected);
      plainReasoningCandidates.forEach((candidate) => {
        if (candidate.logEntryId === selected.logEntryId) {
          usedLogEntries.add(candidate.logEntryId);
          return;
        }
        if (candidatePayloadSame(candidate, selected)) usedLogEntries.add(candidate.logEntryId);
      });
    });
  }

  function hydrateAndPersistReasoningSticky() {
    const activeSpanIds = new Set();
    for (const session of sessions.values()) {
      if (session.spanId) activeSpanIds.add(session.spanId);
      (session.aliasSpanIds || []).forEach((id) => {
        if (id) activeSpanIds.add(id);
      });
      // rebuild 后 dump 可能已出窗：先按 span/alias 回填
      if (!session.reasoningContent) hydrateSessionReasoning(session);
      if (session.reasoningContent) rememberSessionReasoning(session);
    }
    evictReasoningSticky(activeSpanIds);
  }

  traceEntries.forEach((entry) => {
    const trace = entry.trace;
    const action = trace.action || "";
    const session = ensureSession(entry);
    const spanId = session.spanId;
    const ts = entry.timestamp || trace.time || 0;

    if (action === "sel_persona") {
      session.personaId = trace.personaId || "";
      const personaDetail = trace.personaId || "未记录规则 ID";
      // 同会话重复 sel_persona（双 span）只记一次
      const hasPersona = (session.events || []).some((eventId) => {
        const ev = events.find((item) => item.id === eventId);
        return ev?.type === "persona" && compactText(ev.detail || "", 80) === compactText(personaDetail, 80);
      });
      if (!hasPersona) {
        pushSessionEvent(session, {
          id: eventKey(spanId, "persona", entry),
          timestamp: ts,
          spanId,
          type: "persona",
          title: "选择聊天规则",
          detail: personaDetail,
          meta: trace.personaToolCount == null ? "" : `${trace.personaToolCount} 个可用工具`,
          raw: entry.raw,
          evidence: evidenceFromEntry(entry, "trace:sel_persona", "trace", "high"),
        });
      }
      return;
    }

    if (action === "astr_agent_prepare") {
      session.status = "generating";
      session.enteredAgentFlow = true;
      session.providerId = trace.providerId || session.providerId;
      session.model = trace.model || session.model;
      // prepare 快照：日志有 system_prompt + 工具名，无完整 messages[]
      const systemPrompt = String(trace.systemPrompt || "").trim() ? String(trace.systemPrompt) : "";
      const toolNames = Array.isArray(trace.toolNames) ? trace.toolNames.filter(Boolean) : [];
      if (systemPrompt || toolNames.length || trace.providerId || trace.model) {
        session.modelRequest = {
          systemPrompt,
          toolNames,
          stream: trace.stream ?? null,
          providerId: trace.providerId || session.providerId || "",
          model: trace.model || session.model || "",
          messageOutline: trace.messageOutline || session.messageOutline || "",
          prepareTs: ts,
          logEntryId: entry.id || "",
        };
      }
      pushSessionEvent(session, {
        id: eventKey(spanId, "model_start", entry),
        timestamp: ts,
        spanId,
        type: "model_start",
        title: "开始生成回复",
        detail: compactText(trace.messageOutline || session.messageOutline || "进入模型请求阶段", 180),
        meta: [
          [trace.providerId, trace.model].filter(Boolean).join(" | "),
          systemPrompt ? `系统提示 ${systemPrompt.length} 字` : "",
          toolNames.length ? `工具 ${toolNames.length}` : "",
        ].filter(Boolean).join(" · "),
        raw: entry.raw,
        sensitive: true,
        evidence: evidenceFromEntry(entry, "trace:astr_agent_prepare", "trace", "high"),
      });
      return;
    }

    if (action === "agent_tool_call") {
      session.enteredAgentFlow = true;
      // 工具调用已进入 Agent，badge 与真实阶段一致：生成中
      if (session.status === "running") session.status = "generating";
      const call = {
        id: trace.toolCallId || eventKey(spanId, "tool_call", entry),
        spanId,
        name: trace.toolName || "未知工具",
        args: trace.toolArgs,
        startTs: trace.toolStartTs || ts,
        endTs: null,
        durationMs: null,
        result: "",
        status: "running",
        senderName: session.senderName,
        messageOutline: session.messageOutline,
        evidenceLogEntryId: entry.id || "",
        resultLogEntryId: "",
      };
      toolCalls.push(call);
      session.tools.push(call);
      pushSessionEvent(session, {
        id: eventKey(spanId, "tool_call", entry, call.id),
        timestamp: ts,
        spanId,
        type: "tool_call",
        title: `调用工具 ${call.name}`,
        detail: compactJson(call.args, 220) || "无参数",
        meta: session.senderName || "",
        raw: entry.raw,
        sensitive: true,
        sensitiveMeta: true,
        evidence: evidenceFromEntry(entry, "trace:agent_tool_call", "trace", "high"),
      });
      return;
    }

    if (action === "agent_tool_result") {
      session.enteredAgentFlow = true;
      const callId = trace.toolCallId || "";
      const call = [...toolCalls].reverse().find((item) => item.id === callId && item.status === "running")
        || [...toolCalls].reverse().find((item) => item.spanId === spanId && item.status === "running");
      const endTs = trace.toolResultTs || ts;
      let name = "未知工具";
      let durationMs = null;
      if (call) {
        call.endTs = endTs;
        call.durationMs = call.startTs ? Math.max(0, endTs - call.startTs) : null;
        call.result = trace.toolResult || "";
        call.status = "done";
        call.resultLogEntryId = entry.id || call.resultLogEntryId || "";
        name = call.name;
        durationMs = call.durationMs;
      }
      pushSessionEvent(session, {
        id: eventKey(spanId, "tool_result", entry, callId),
        timestamp: ts,
        spanId,
        type: durationMs != null && durationMs >= slowToolMs ? "slow" : "tool_result",
        title: durationMs != null && durationMs >= slowToolMs ? `工具较慢 ${name}` : `工具返回 ${name}`,
        detail: compactText(trace.toolResult || "工具已返回", 240),
        meta: eventDurationLabel(durationMs),
        durationMs,
        raw: entry.raw,
        sensitive: true,
        evidence: evidenceFromEntry(entry, "trace:agent_tool_result", "trace", "high"),
      });
      return;
    }

    if (action === "astr_agent_complete") {
      session.status = "complete";
      session.enteredAgentFlow = true;
      session.completed = true;
      session.response = trace.response || "";
      // generationMs = stats 生成段；wallMs = 端到端（startTs→本事件）
      session.generationMs = trace.generationMs ?? trace.durationMs ?? null;
      session.timeToFirstTokenMs = trace.timeToFirstTokenMs ?? null;
      if (session.timeToFirstTokenMs != null && Number(session.timeToFirstTokenMs) <= 0) {
        session.timeToFirstTokenMs = null;
      }
      session.tokenUsage = trace.tokenUsage || {};
      if (trace.reasoningContent) {
        session.reasoningContent = trace.reasoningContent;
        session.reasoningLogEntryId = entry.id || "";
        session.reasoningTs = ts;
        session.reasoningTokens = tokenValue(trace.tokenUsage, ["reasoning_tokens", "reasoning", "reasoningTokens"]) || null;
        session.reasoningSource = "trace";
      }
      session.providerId = trace.providerId || session.providerId;
      session.model = trace.model || session.model;
      session.lastTs = Math.max(session.lastTs || 0, ts || 0);
      if (session.startTs && session.lastTs >= session.startTs) {
        session.wallMs = Math.max(0, session.lastTs - session.startTs);
      }
      // durationMs 兼容字段 = 总耗时（墙钟优先）
      session.durationMs = session.wallMs ?? session.generationMs ?? null;
      closeOpenSession(session);
      const genMs = session.generationMs;
      pushSessionEvent(session, {
        id: eventKey(spanId, "message_out", entry),
        timestamp: ts,
        spanId,
        type: "message_out",
        title: "发送回复",
        detail: compactText(trace.response || "回复内容未记录", 220),
        meta: [
          session.wallMs != null ? eventDurationLabel(session.wallMs, { prefix: "总耗时" }) : "",
          genMs != null ? eventDurationLabel(genMs, { prefix: "生成" }) : "",
        ].filter(Boolean).join(" · "),
        durationMs: session.wallMs ?? genMs,
        generationMs: genMs,
        raw: entry.raw,
        sensitive: true,
        evidence: evidenceFromEntry(entry, "trace:astr_agent_complete", "trace", "high"),
      });
      // 慢会话：按端到端墙钟判断（用户体感）
      const slowBasis = session.wallMs ?? genMs;
      if (slowBasis != null && slowBasis >= slowSessionMs) {
        pushSessionEvent(session, {
          id: eventKey(spanId, "slow", entry),
          timestamp: ts,
          spanId,
          type: "slow",
          title: "会话响应较慢",
          detail: compactText(session.messageOutline || "该会话耗时超过阈值", 180),
          meta: eventDurationLabel(slowBasis, { prefix: "总耗时" }),
          durationMs: slowBasis,
          raw: entry.raw,
          sensitive: true,
          evidence: evidenceFromEntry(entry, "trace:slow_session", "trace", "high"),
        });
      }
      return;
    }

    if (action === "astr_agent_error" || entry.level === "error") {
      session.status = "error";
      session.enteredAgentFlow = true;
      session.lastTs = Math.max(session.lastTs || 0, ts || 0);
      if (session.startTs && session.lastTs >= session.startTs) {
        session.wallMs = Math.max(0, session.lastTs - session.startTs);
        session.durationMs = session.wallMs ?? session.generationMs ?? null;
      }
      closeOpenSession(session);
      pushSessionEvent(session, {
        id: eventKey(spanId, "error", entry),
        timestamp: ts,
        spanId,
        type: "error",
        title: "会话错误",
        detail: compactText(entry.summary || entry.raw, 240),
        meta: session.wallMs != null
          ? eventDurationLabel(session.wallMs, { prefix: "总耗时" })
          : (session.senderName || ""),
        durationMs: session.wallMs ?? null,
        raw: entry.raw,
        sensitive: true,
        sensitiveMeta: true,
        evidence: evidenceFromEntry(entry, action === "astr_agent_error" ? "trace:astr_agent_error" : "trace:error_level", "trace", "high"),
      });
    }
  });

  mergeSplitSessions();
  attachPlainReasoningToSessions();
  hydrateAndPersistReasoningSticky();
  markStaleSessions([...sessions.values()], now, runningTimeoutMs);
  // stale 收口后从 openIndex 摘除，避免同文案粘到旧会话
  [...sessions.values()].forEach((session) => {
    if (session.status === "complete" || session.status === "error" || session.status === "stale") {
      closeOpenSession(session);
    }
  });

  // 收口：stale 也补 wallMs；durationMs 统一为墙钟优先
  [...sessions.values()].forEach((session) => {
    if (session.startTs && session.lastTs && session.lastTs >= session.startTs) {
      if (session.status === "complete" || session.status === "error" || session.status === "stale") {
        session.wallMs = Math.max(0, session.lastTs - session.startTs);
      }
    }
    if (session.status === "complete" || session.status === "error" || session.status === "stale") {
      session.durationMs = session.wallMs ?? session.generationMs ?? session.durationMs ?? null;
    }
  });

  const tracedMessageKeys = new Set(
    events
      .filter((event) => event.type === "message_in" && event.messageKey)
      .map((event) => event.messageKey),
  );

  entries
    .filter((entry) => !entry.trace)
    .forEach((entry) => {
      const event = plainLogEvent(entry);
      if (event?.type === "message_in" && event.messageKey && tracedMessageKeys.has(event.messageKey)) return;
      if (event) pushEvent(event);
    });

  const allTraceSessions = [...sessions.values()].sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  const visibleSessions = allTraceSessions
    .filter((session) => {
      // 已完成 / 已进入 Agent（含 stale 未完成）：始终可见
      if (session.enteredAgentFlow || session.completed) return true;
      // agent 孪生已出现时立刻隐藏 pre-agent，避免一句消息两张并发卡
      if (hasAgentTwinSession(session, allTraceSessions)) return false;
      // pre-agent：短窗口 / Poke 更短；超时不展示
      return isPreAgentVisible(session, now);
    })
    .map((session) => {
      const replyKind = sessionReplyKind(session);
      const enriched = { ...session, replyKind };
      return {
        ...enriched,
        replyHint: sessionReplyHint(enriched),
        displayStatus: sessionDisplayStatus(enriched),
      };
    });
  const runningSessions = allTraceSessions.filter((session) => {
    if (session.status === "complete" || session.status === "error" || session.status === "stale") return false;
    return now - (session.lastTs || 0) <= runningTimeoutMs;
  });
  const runningTools = toolCalls.filter((call) => call.status === "running" && now - (call.startTs || 0) <= runningTimeoutMs);

  const toolStatsMap = new Map();
  toolCalls.forEach((call) => {
    const key = call.name || "未知工具";
    const current = toolStatsMap.get(key) || { label: key, value: 0, totalDuration: 0, maxDuration: 0, running: 0, completed: 0 };
    current.value += 1;
    if (call.status === "running") {
      current.running += 1;
    } else {
      current.completed += 1;
      current.totalDuration += call.durationMs || 0;
      current.maxDuration = Math.max(current.maxDuration, call.durationMs || 0);
    }
    toolStatsMap.set(key, current);
  });
  const toolStats = [...toolStatsMap.values()]
    .map((item) => ({
      ...item,
      avgDuration: item.completed ? item.totalDuration / item.completed : 0,
      className: item.running ? "module-trace" : "module-plugin",
      detail: `平均 ${(item.completed ? item.totalDuration / item.completed / 1000 : 0).toFixed(1)} 秒 / 最大 ${(item.maxDuration / 1000).toFixed(1)} 秒 / 运行中 ${item.running}`,
      unit: "次",
    }))
    .sort((a, b) => b.value - a.value || b.avgDuration - a.avgDuration);

  const sourceMap = new Map();
  const senderMap = new Map();
  const personaMap = new Map();
  visibleSessions.forEach((session) => {
    addStat(sourceMap, sessionSourceLabel(session));
    addStat(senderMap, session.senderName || "未记录发送者");
    addStat(personaMap, session.personaId || "未记录规则");
  });

  const completedSessions = visibleSessions.filter((session) => session.status === "complete");
  // 延迟分桶按端到端墙钟（durationMs 已统一）
  const durationSessions = completedSessions.filter((session) => Number.isFinite(Number(session.durationMs ?? session.wallMs)));
  const durations = durationSessions.map((session) => Number(session.durationMs ?? session.wallMs));
  const tokenTotals = completedSessions.map((session) => tokenTotal(session.tokenUsage));
  const inputTokens = completedSessions.map((session) => tokenValue(session.tokenUsage, ["input", "input_text", "input_other", "input_cached", "prompt_tokens"]));
  const outputTokens = completedSessions.map((session) => tokenValue(session.tokenUsage, ["output", "output_text", "completion_tokens"]));
  const ttftValues = completedSessions
    .map((session) => Number(session.timeToFirstTokenMs))
    .filter((value) => Number.isFinite(value) && value > 0);
  const latencyBuckets = [
    { label: "5 秒内", value: durations.filter((duration) => duration < 5000).length, className: "level-info", unit: "次" },
    { label: "5-15 秒", value: durations.filter((duration) => duration >= 5000 && duration < 15000).length, className: "module-trace", unit: "次" },
    { label: "15-30 秒", value: durations.filter((duration) => duration >= 15000 && duration < 30000).length, className: "level-warn", unit: "次" },
    { label: "30 秒以上", value: durations.filter((duration) => duration >= 30000).length, className: "level-error", unit: "次" },
  ].filter((item) => item.value > 0);
  const latencyStats = {
    completed: completedSessions.length,
    measured: durations.length,
    avgDurationMs: average(durations),
    maxDurationMs: durations.length ? Math.max(...durations) : 0,
    avgTimeToFirstTokenMs: average(ttftValues),
    totalTokens: tokenTotals.reduce((sum, value) => sum + value, 0),
    inputTokens: inputTokens.reduce((sum, value) => sum + value, 0),
    outputTokens: outputTokens.reduce((sum, value) => sum + value, 0),
    avgTokens: average(tokenTotals),
    slowThresholdMs: slowSessionMs,
  };

  const sortedEvents = events.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  // --- 插件分布统计 ---
  const pluginMap = new Map();
  entries.forEach((entry) => {
    if (!entry.moduleName && !entry.scope && !entry.level) return;
    const group = cachedNormalizeModuleGroup(entry);
    if (!group || !group.key.startsWith("plugin:")) return;
    const pluginName = group.key.replace("plugin:", "");
    const current = pluginMap.get(pluginName) || { label: pluginName, value: 0, detail: "" };
    current.value += 1;
    pluginMap.set(pluginName, current);
  });
  const pluginStats = [...pluginMap.values()]
    .map((item) => ({ ...item, className: "module-plugin", unit: "条" }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, "zh-CN"));

  // --- 工具调用详情统计（含 plain log 识别） ---
  const toolDetailMap = new Map();
  sortedEvents.filter((e) => e.type === "tool_call").forEach((event) => {
    const name = event.toolName || event.title.replace(/^工具调用\s*/, "").trim() || "未知工具";
    const current = toolDetailMap.get(name) || { label: name, value: 0, className: "level-warn", unit: "次", detail: "" };
    current.value += 1;
    toolDetailMap.set(name, current);
  });
  sortedEvents.filter((e) => e.type === "tool_result").forEach((event) => {
    const name = event.toolName || event.title.replace(/^工具返回\s*/, "").trim() || "未知工具";
    const current = toolDetailMap.get(name) || { label: name, value: 0, className: "level-info", unit: "次", detail: "" };
    current.value += 1;
    toolDetailMap.set(name, current);
  });
  const toolDetailStats = [...toolDetailMap.values()]
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, "zh-CN"));

  return {
    allTraceSessions,
    sessions: visibleSessions,
    runningSessions,
    toolCalls,
    runningTools,
    toolStats,
    events: sortedEvents,
    messageOutCount: sortedEvents.filter((event) => event.type === "message_out").length,
    messageInCount: sortedEvents.filter((event) => event.type === "message_in").length,
    slowCount: sortedEvents.filter((event) => event.type === "slow").length,
    errorCount: sortedEvents.filter((event) => event.type === "error").length,
    toolCallCount: sortedEvents.filter((event) => event.type === "tool_call" || event.type === "tool_result").length,
    sourceStats: statMapItems(sourceMap, "module-platform"),
    senderStats: statMapItems(senderMap, "module-plugin"),
    personaStats: statMapItems(personaMap, "module-trace"),
    pluginStats,
    toolDetailStats,
    latencyStats,
    latencyBuckets,
  };
}
