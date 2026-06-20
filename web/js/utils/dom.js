// ============================================================================
// 工具函数 - DOM 操作 / UI 辅助
// ============================================================================

import { state } from "../state.js?v=20260620-sessionlive1";
import {
  DEFAULT_RUNNING_TIMEOUT_MS,
  DEFAULT_SLOW_SESSION_MS,
  DEFAULT_SLOW_TOOL_MS,
  DEFAULT_IMPORTANT_EVENT_LIMIT,
  DEFAULT_LOG_PAGE_SIZE,
  DEFAULT_RAW_CLIP_LENGTH,
} from "../config.js?v=20260620-sessionlive1";
import { formatCompactLogTime, clampNumber, boolValue } from "./format.js?v=20260620-sessionlive1";

export function $(id) {
  return document.getElementById(id);
}

/**
 * 设置元素文本内容
 * @param {string} id - 元素 ID
 * @param {*} value - 要设置的值
 */
export function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value == null || value === "" ? "--" : String(value);
}

/**
 * 显示提示消息
 * @param {string} message - 消息内容
 */
export function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  window.clearTimeout(toast._timer);
  toast._timer = window.setTimeout(() => el.classList.remove("show"), 3200);
}

export function applyPublicConfig(config) {
  const ui = config?.ui || {};
  const runningTimeoutMinutes = clampNumber(ui.running_timeout_minutes, DEFAULT_RUNNING_TIMEOUT_MS / 60000, 1, 1440);
  const slowSessionSeconds = clampNumber(ui.slow_session_seconds, DEFAULT_SLOW_SESSION_MS / 1000, 1, 3600);
  const slowToolSeconds = clampNumber(ui.slow_tool_seconds, DEFAULT_SLOW_TOOL_MS / 1000, 1, 3600);
  state.ui = {
    runningTimeoutMs: runningTimeoutMinutes * 60 * 1000,
    slowSessionMs: slowSessionSeconds * 1000,
    slowToolMs: slowToolSeconds * 1000,
    importantEventLimit: Math.round(clampNumber(ui.important_event_limit, DEFAULT_IMPORTANT_EVENT_LIMIT, 10, 500)),
    rawClipLength: DEFAULT_RAW_CLIP_LENGTH,
  };
  state.logPageSize = Math.round(clampNumber(ui.log_page_size, DEFAULT_LOG_PAGE_SIZE, 20, 500));
  state.privacyMode = boolValue(ui.privacy_mode, false);
  state.refreshMs = Math.max(2000, Number(config?.refresh_interval_seconds || 5) * 1000);
  document.body.classList.toggle("privacy-mode", state.privacyMode);
}

export function privacyText(text, fallback = "隐私模式已隐藏内容") {
  if (!state.privacyMode) return text;
  return text ? fallback : text;
}

export function getLogSearchText() {
  return (($("logFilter")?.value || "").trim().toLowerCase());
}

export function clippedText(text, maxLength = state.ui.rawClipLength) {
  const value = String(text || "");
  if (value.length <= maxLength) {
    return { text: value, clipped: false };
  }
  return {
    text: `${value.slice(0, maxLength)}\n\n[原文过长，已裁剪 ${value.length - maxLength} 个字符]`,
    clipped: true,
  };
}

export function stableKeyText(text, maxLength = 180) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function detailKey(prefix, ...parts) {
  return `${prefix}:${parts.map((part) => stableKeyText(part, 220)).join(":")}`;
}

export function renderSignature(id, parts) {
  const el = $(id);
  if (!el) return null;
  let signature;
  try {
    signature = JSON.stringify(parts);
  } catch (err) {
    signature = String(parts);
  }
  if (el.dataset.renderSignature === signature) return null;
  el.dataset.renderSignature = signature;
  return el;
}

// 兼容旧缓存模块：某些浏览器可能暂时混用新旧前端文件，
// 旧模块中的裸 renderSignature 调用可退回到全局绑定。
if (typeof globalThis.renderSignature !== "function") {
  globalThis.renderSignature = renderSignature;
}

/**
 * 渲染键值对列表
 * @param {string} id - 容器元素 ID
 * @param {object} entries - 键值对对象
 */
export function renderKv(id, entries) {
  const el = $(id);
  if (!el) return;
  el.innerHTML = "";
  Object.entries(entries).forEach(([key, value]) => {
    const rowEl = document.createElement("div");
    rowEl.className = "kv-row";
    const left = document.createElement("div");
    left.className = "kv-key";
    left.textContent = key;
    const right = document.createElement("div");
    right.className = "kv-value";
    right.textContent = value == null || value === "" ? "--" : String(value);
    rowEl.append(left, right);
    el.appendChild(rowEl);
  });
}

/**
 * 创建详细信息行元素
 * @param {string} label - 标签
 * @param {*} value - 值
 * @returns {HTMLElement} 行元素
 */
export function detailRow(label, value) {
  const rowEl = document.createElement("div");
  rowEl.className = "detail-row";
  const key = document.createElement("span");
  key.textContent = label;
  const val = document.createElement("strong");
  val.textContent = value == null || value === "" ? "--" : String(value);
  rowEl.append(key, val);
  return rowEl;
}

/**
 * 创建徽章元素
 * @param {string} text - 文本
 * @param {string} kind - 类型
 * @returns {HTMLElement} 徽章元素
 */
export function badge(text, kind) {
  const el = document.createElement("span");
  el.className = `badge ${kind || ""}`;
  el.textContent = text;
  return el;
}

/**
 * 创建空状态元素
 * @param {string} text - 提示文本
 * @returns {HTMLElement} 空状态元素
 */
export function emptyBlock(text) {
  const empty = document.createElement("div");
  empty.className = "empty";
  empty.textContent = text;
  return empty;
}

export function textSpan(text, className) {
  const el = document.createElement("span");
  el.className = className;
  el.textContent = text || "--";
  return el;
}

export function smallPill(text, kind) {
  const el = document.createElement("span");
  el.className = `mini-badge ${kind || ""}`;
  el.textContent = text;
  return el;
}

export function cssEscape(value) {
  if (window.CSS?.escape) return CSS.escape(value);
  return String(value || "").replace(/["\\]/g, "\\$&");
}

export function bindDetailsState(details, key) {
  if (!details || !key) return;
  if (details.dataset.boundKey === key) return;
  details.dataset.detailKey = key;
  details.dataset.boundKey = key;
  details.open = state.openDetails.has(key);
  details.addEventListener("toggle", () => {
    if (details.open) {
      state.openDetails.add(key);
    } else {
      state.openDetails.delete(key);
    }
  });
}

export function pruneOpenDetails(prefix, activeKeys) {
  if (!(activeKeys instanceof Set)) return;
  state.openDetails.forEach((key) => {
    if (key.startsWith(prefix) && !activeKeys.has(key)) {
      state.openDetails.delete(key);
    }
  });
}

export function eventChainDetailKey(event) {
  return detailKey("event-chain", event.spanId, event.type, event.timestamp, event.title);
}

export function logEntryDetailKey(entry) {
  return detailKey("log-entry", entry.path, entry.timestamp || entry.fileMtime || "", entry.summary || entry.message || "", entry.raw);
}

export function renderWorkspaceChrome() {
  const titles = {
    overview: ["总览", "当前运行状态"],
    astrbot: ["AstrBot", "会话、模型与日志维度"],
    logs: ["日志分析", "重要信息、证据和原始日志"],
    system: ["系统", "主机、进程、磁盘与网络"],
  };
  const [title, meta] = titles[state.activeTab] || titles.overview;
  setText("workspaceTitle", title);
  setText("workspaceMeta", meta);
  setText("sidebarStatusText", `AstrBot 在线 · ${formatCompactLogTime({ timestamp: Date.now() })}`);
  if (state.activeTab !== "logs") {
    // detail panel is rendered by caller when needed
  }
}
