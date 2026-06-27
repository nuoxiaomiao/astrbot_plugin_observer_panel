// ============================================================================
// 日志分析与 trace 洞察
// ============================================================================

import { state } from "../state.js?v=20260627-calm1";
import {
  DEFAULT_SLOW_SESSION_MS,
  DEFAULT_SLOW_TOOL_MS,
  DEFAULT_RUNNING_TIMEOUT_MS,
  CORE_MODULE_LABELS,
  METHOD_MODULE_LABELS,
  PLUG_MODULE_LABELS,
  TRACE_ACTION_LABELS,
  EVENT_TYPES,
} from "../config.js?v=20260627-calm1";
import { average } from "../utils/format.js?v=20260627-calm1";
import {
  compactText,
  compactJson,
  safeObject,
  bracketParts,
} from "../utils/log-text.js?v=20260627-calm1";
import { getLogSearchText, detailKey, stableKeyText } from "../utils/dom.js?v=20260627-calm1";
import { buildLogEntries } from "./parser.js?v=20260627-calm1";
import { logFilesSignature, recentAnalysisEntries } from "./cache.js?v=20260627-calm1";

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

export function matchLogText(haystack, matcher) {
  if (!matcher) return true;
  if (matcher.regex) return matcher.regex.test(haystack);
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
    const entryTime = entry.timestamp || (entry.fileMtime ? entry.fileMtime * 1000 : 0);
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
  match = raw.match(/(?:插件|plugin)[：:\s]*([A-Za-z0-9_\-.]+)/i);
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
  return moduleGroup(`plugin:${name}`, `插件: ${name}`, "module-plugin", raw || value);
}

export function pluginGroupFromMessage(message) {
  const text = String(message || "");
  const match = text.match(/\b(?:plugin|hook\([^)]*\))\s*-\u003e\s*([A-Za-z0-9_.-]+)(?:\s*-\s*([A-Za-z0-9_.:-]+))?/i);
  if (match) return pluginModuleGroup(match[1], match[0]);
  const zhMatch = text.match(/(?:插件|plugin)[：:\s]*([A-Za-z0-9_\-.]+)/i);
  if (zhMatch) return pluginModuleGroup(zhMatch[1], zhMatch[0]);
  const bracketMatch = text.match(/\[([^\]]*astrbot_plugin_[^\]]*)\]/i);
  if (bracketMatch) return pluginModuleGroup(bracketMatch[1], bracketMatch[0]);
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

  if (String(entry.scope || "").toLowerCase() === "plug" && PLUG_MODULE_LABELS[lower]) {
    return moduleGroup(`plug:${lower}`, PLUG_MODULE_LABELS[lower], "module-plugin", rawToken);
  }

  if (lower.includes("aiocqhttp") || message.includes("RawMessage <Event")) {
    return moduleGroup("platform:aiocqhttp", "平台: aiocqhttp", "module-platform", rawToken);
  }

  if (lower.startsWith("sources.")) {
    const sourceName = lower.slice("sources.".length).split(".")[0].replace(/_source$/i, "");
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

  if (/adapter|platform/i.test(token)) {
    return moduleGroup(`platform:${lower || "unknown"}`, `平台: ${humanizeModuleWord(token)}`, "module-platform", rawToken);
  }

  if (/^core$/i.test(token)) {
    return moduleGroup("core:astrbot", "AstrBot 核心", "module-core", rawToken);
  }

  if (/^plug$/i.test(token)) {
    return moduleGroup("plugin:unknown", "插件: 未识别", "module-plugin", rawToken);
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
  const time = entry.timestamp || (entry.fileMtime ? entry.fileMtime * 1000 : 0);
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

export function eventDurationLabel(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return "";
  return `耗时 ${(Number(ms) / 1000).toFixed(1)} 秒`;
}

export function messageDedupeKey(sender, content) {
  const text = compactText(content || "", 160).toLowerCase();
  return `${String(sender || "").trim().toLowerCase()}|${text}`;
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
  const text = `${entry.message || ""} ${entry.summary || ""} ${entry.raw || ""}`;
  if (entry.trace) return null;
  for (const pattern of PLAIN_TOOL_CALL_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return { type: "tool_call", name: match[1].trim() || "未知工具" };
    }
  }
  return null;
}

export function isPlainToolResultLog(entry, toolName) {
  const text = `${entry.message || ""} ${entry.summary || ""} ${entry.raw || ""}`;
  if (entry.trace) return null;
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
];

export function isPlainPipelineLog(entry) {
  const text = `${entry.moduleName || ""} ${entry.message || ""} ${entry.summary || ""} ${entry.raw || ""}`;
  if (entry.trace) return null;
  return PLAIN_PIPELINE_PATTERNS.some((pattern) => pattern.test(text));
}

const PLAIN_PROVIDER_RESPONSE_PATTERNS = [
  /sources\..*_source/i,
  /completion:\s*(?:ChatCompletion|Message|id='|id=")/i,
];

export function isPlainProviderResponseLog(entry) {
  const text = `${entry.moduleName || ""} ${entry.message || ""} ${entry.summary || ""} ${entry.raw || ""}`;
  if (entry.trace) return null;
  return PLAIN_PROVIDER_RESPONSE_PATTERNS.some((pattern) => pattern.test(text));
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
  /on_decorating_result/i,
];

export function isPlainDecorateLog(entry) {
  const text = `${entry.moduleName || ""} ${entry.message || ""} ${entry.summary || ""} ${entry.raw || ""}`;
  if (entry.trace) return null;
  return PLAIN_DECORATE_PATTERNS.some((pattern) => pattern.test(text));
}

export function plainLogEvent(entry) {
  if (entry.trace) return null;
  const eventBus = parseEventBusMessage(entry);
  if (eventBus) {
    return {
      id: `plain:${entry.id}`,
      timestamp: entry.timestamp || entry.fileMtime || 0,
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

  // 新增：记忆操作、唤醒检查、Pipeline Hook、Agent 阶段、Pipeline 调度
  if (isPlainMemoryLog(entry)) {
    return {
      id: `plain:${entry.id}`,
      timestamp: entry.timestamp || entry.fileMtime || 0,
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
      timestamp: entry.timestamp || entry.fileMtime || 0,
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
      timestamp: entry.timestamp || entry.fileMtime || 0,
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
      timestamp: entry.timestamp || entry.fileMtime || 0,
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
      timestamp: entry.timestamp || entry.fileMtime || 0,
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
      timestamp: entry.timestamp || entry.fileMtime || 0,
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
      timestamp: entry.timestamp || entry.fileMtime || 0,
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
      timestamp: entry.timestamp || entry.fileMtime || 0,
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
      timestamp: entry.timestamp || entry.fileMtime || 0,
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
      timestamp: entry.timestamp || entry.fileMtime || 0,
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
      timestamp: entry.timestamp || entry.fileMtime || 0,
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
      timestamp: entry.timestamp || entry.fileMtime || 0,
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
      timestamp: entry.timestamp || entry.fileMtime || 0,
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
      timestamp: entry.timestamp || entry.fileMtime || 0,
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
      timestamp: entry.timestamp || entry.fileMtime || 0,
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
  const sessions = new Map();
  const events = [];
  const toolCalls = [];
  const newestTraceTs = Math.max(0, ...traceEntries.map((entry) => entry.timestamp || entry.trace?.time || 0));
  const now = Math.max(Date.now(), newestTraceTs);
  const slowToolMs = state.ui.slowToolMs || DEFAULT_SLOW_TOOL_MS;
  const slowSessionMs = state.ui.slowSessionMs || DEFAULT_SLOW_SESSION_MS;
  const runningTimeoutMs = state.ui.runningTimeoutMs || DEFAULT_RUNNING_TIMEOUT_MS;

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
    let session = sessions.get(spanId);
    if (!session) {
      session = {
        spanId,
        startTs: entry.timestamp || trace.time || 0,
        lastTs: entry.timestamp || trace.time || 0,
        senderName: trace.senderName || "",
        umo: trace.umo || "",
        messageOutline: trace.messageOutline || "",
        personaId: "",
        status: "running",
        response: "",
        durationMs: null,
        timeToFirstTokenMs: null,
        tokenUsage: {},
        providerId: "",
        model: "",
        enteredAgentFlow: false,
        tools: [],
        events: [],
      };
      sessions.set(spanId, session);
      pushSessionEvent(session, {
        id: eventKey(spanId, "message_in", entry),
        timestamp: entry.timestamp || trace.time || 0,
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
    }
    session.lastTs = Math.max(session.lastTs || 0, entry.timestamp || trace.time || 0);
    if (trace.senderName) session.senderName = trace.senderName;
    if (trace.umo) session.umo = trace.umo;
    if (trace.messageOutline) session.messageOutline = trace.messageOutline;
    return session;
  }

  traceEntries.forEach((entry) => {
    const trace = entry.trace;
    const action = trace.action || "";
    const session = ensureSession(entry);
    const spanId = session.spanId;
    const ts = entry.timestamp || trace.time || 0;

    if (action === "sel_persona") {
      session.personaId = trace.personaId || "";
      pushSessionEvent(session, {
        id: eventKey(spanId, "persona", entry),
        timestamp: ts,
        spanId,
        type: "persona",
        title: "选择聊天规则",
        detail: trace.personaId || "未记录规则 ID",
        meta: trace.personaToolCount == null ? "" : `${trace.personaToolCount} 个可用工具`,
        raw: entry.raw,
        evidence: evidenceFromEntry(entry, "trace:sel_persona", "trace", "high"),
      });
      return;
    }

    if (action === "astr_agent_prepare") {
      session.status = "generating";
      session.enteredAgentFlow = true;
      session.providerId = trace.providerId || session.providerId;
      session.model = trace.model || session.model;
      pushSessionEvent(session, {
        id: eventKey(spanId, "model_start", entry),
        timestamp: ts,
        spanId,
        type: "model_start",
        title: "开始生成回复",
        detail: compactText(trace.messageOutline || session.messageOutline || "进入模型请求阶段", 180),
        meta: [trace.providerId, trace.model].filter(Boolean).join(" | "),
        raw: entry.raw,
        sensitive: true,
        evidence: evidenceFromEntry(entry, "trace:astr_agent_prepare", "trace", "high"),
      });
      return;
    }

    if (action === "agent_tool_call") {
      session.enteredAgentFlow = true;
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
      session.durationMs = trace.durationMs;
      session.timeToFirstTokenMs = trace.timeToFirstTokenMs;
      session.tokenUsage = trace.tokenUsage || {};
      session.providerId = trace.providerId || session.providerId;
      session.model = trace.model || session.model;
      pushSessionEvent(session, {
        id: eventKey(spanId, "message_out", entry),
        timestamp: ts,
        spanId,
        type: "message_out",
        title: "发送回复",
        detail: compactText(trace.response || "回复内容未记录", 220),
        meta: trace.durationMs == null ? "" : `生成${eventDurationLabel(trace.durationMs)}`,
        durationMs: trace.durationMs,
        raw: entry.raw,
        sensitive: true,
        evidence: evidenceFromEntry(entry, "trace:astr_agent_complete", "trace", "high"),
      });
      if (trace.durationMs != null && trace.durationMs >= slowSessionMs) {
        pushSessionEvent(session, {
          id: eventKey(spanId, "slow", entry),
          timestamp: ts,
          spanId,
          type: "slow",
          title: "会话响应较慢",
          detail: compactText(session.messageOutline || "该会话耗时超过阈值", 180),
          meta: eventDurationLabel(trace.durationMs),
          durationMs: trace.durationMs,
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
      pushSessionEvent(session, {
        id: eventKey(spanId, "error", entry),
        timestamp: ts,
        spanId,
        type: "error",
        title: "会话错误",
        detail: compactText(entry.summary || entry.raw, 240),
        meta: session.senderName || "",
        raw: entry.raw,
        sensitive: true,
        sensitiveMeta: true,
        evidence: evidenceFromEntry(entry, action === "astr_agent_error" ? "trace:astr_agent_error" : "trace:error_level", "trace", "high"),
      });
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
    .filter((session) => session.enteredAgentFlow || session.completed)
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
    if (session.status === "complete" || session.status === "error") return false;
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
  const durationSessions = completedSessions.filter((session) => Number.isFinite(Number(session.durationMs)));
  const durations = durationSessions.map((session) => Number(session.durationMs));
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
