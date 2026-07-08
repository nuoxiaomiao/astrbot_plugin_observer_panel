// ============================================================================
// 工具函数 - DOM 操作 / UI 辅助
// ============================================================================

import { state } from "../state.js?v=20260627-calm4";
import {
  DEFAULT_RUNNING_TIMEOUT_MS,
  DEFAULT_SLOW_SESSION_MS,
  DEFAULT_SLOW_TOOL_MS,
  DEFAULT_IMPORTANT_EVENT_LIMIT,
  DEFAULT_LOG_PAGE_SIZE,
  DEFAULT_RAW_CLIP_LENGTH,
} from "../config.js?v=20260627-calm4";
import { formatCompactLogTime, clampNumber, boolValue } from "./format.js?v=20260627-calm4";

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
 * 带数字渐变效果的 setText
 * @param {string} id - 元素 ID
 * @param {string|number} rawValue - 新值
 * @param {number} duration - 动画时长 ms，默认 400
 */
export function setTextAnimated(id, rawValue, duration = 400) {
  const el = $(id);
  if (!el) return;
  const strVal = rawValue == null || rawValue === "" ? "--" : String(rawValue);

  // 非数字 → 直接设
  const numMatch = strVal.match(/^(-?\d+(?:\.\d+)?)/);
  if (!numMatch) { el.textContent = strVal; return; }

  const current = parseFloat(el.textContent) || 0;
  const target = parseFloat(numMatch[1]);
  if (Math.abs(target - current) < 0.3) { el.textContent = strVal; triggerPulse(el); return; }

  const suffix = strVal.slice(numMatch[1].length); // 保留 "%" 等单位
  const startTime = performance.now();

  const tick = (now) => {
    const t = Math.min((now - startTime) / duration, 1);
    const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
    const val = current + (target - current) * eased;
    el.textContent = val.toFixed(1) + suffix;
    if (t < 1) {
      requestAnimationFrame(tick);
    } else {
      // ★ 动画完成 → 精确值 + 脉冲高亮
      el.textContent = strVal;
      triggerPulse(el);
    }
  };
  requestAnimationFrame(tick);
}

function triggerPulse(el) {
  el.classList.remove("updated");
  void el.offsetWidth;
  el.classList.add("updated");
  window.setTimeout(() => el.classList.remove("updated"), 800);
}

/**
 * 显示提示消息（支持队列和点击关闭）
 * @param {string} message - 消息内容
 * @param {number} duration - 显示时长 ms，默认动态计算
 */
export function toast(message, duration) {
  if (duration == null) {
    const baseDelay = 2000;
    const charDelay = message.length > 30 ? (message.length > 60 ? 1500 : 1000) : 0;
    duration = baseDelay + charDelay;
  }
  toast._queue = toast._queue || [];
  toast._queue.push({ message, duration });
  if (toast._queue.length > 1) return;
  showNextToast();
}

function showNextToast() {
  const q = toast._queue;
  if (!q || q.length === 0) return;
  const el = $("toast");
  if (!el) { q.length = 0; return; }
  const { message, duration } = q[0];
  el.textContent = message;
  el.classList.remove("visible");
  el.classList.add("show");
  void el.offsetWidth;
  el.classList.add("visible");

  // 点击可关闭
  el.onclick = () => {
    el.classList.remove("visible");
    window.clearTimeout(toast._timer);
    toast._timer = window.setTimeout(() => {
      el.classList.remove("show");
      q.shift();
      showNextToast();
    }, 250);
  };

  window.clearTimeout(toast._timer);
  toast._timer = window.setTimeout(() => {
    el.classList.remove("visible");
    toast._timer = window.setTimeout(() => {
      el.classList.remove("show");
      q.shift();
      showNextToast();
    }, 250);
  }, duration);
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

const RAW_JSON_IMPORTANT_KEYS = new Set([
  "action",
  "span_id",
  "type",
  "level",
  "name",
  "umo",
  "sender_name",
  "message_outline",
  "fields",
  "resp",
  "tool_name",
  "tool_result",
]);

function rawLogAccent(level, type, raw) {
  const levelText = String(level || "").toLowerCase();
  if (["error", "warn", "info", "debug", "trace"].includes(levelText)) return levelText;
  const typeText = String(type || "").toLowerCase();
  if (typeText.includes("error")) return "error";
  if (typeText.includes("warn") || typeText.includes("slow")) return "warn";
  if (typeText.includes("trace")) return "trace";
  const value = String(raw || "");
  if (/"level"\s*:\s*"(?:ERROR|ERR|CRITICAL|FATAL)"/i.test(value)) return "error";
  if (/"level"\s*:\s*"WARN(?:ING)?"/i.test(value)) return "warn";
  if (/"type"\s*:\s*"trace"/i.test(value)) return "trace";
  return "other";
}

function rawLogTypeLabel(raw, type, parser) {
  const typeText = String(type || "").trim();
  const parserText = String(parser || "").trim();
  if (typeText) return typeText;
  if (parserText === "trace" || /"type"\s*:\s*"trace"/i.test(String(raw || ""))) return "Trace JSON";
  if (String(raw || "").trim().startsWith("{")) return "JSON";
  return "Plain";
}

function appendRawJsonHighlighted(parent, text, parseSource = text) {
  const value = String(text || "");
  const parseValue = String(parseSource || "");
  const start = value.indexOf("{");
  const parseStart = parseValue.indexOf("{");
  if (start < 0 || parseStart < 0) {
    parent.textContent = value;
    return;
  }
  const jsonText = parseValue.slice(parseStart).trim();
  try {
    JSON.parse(jsonText);
  } catch (err) {
    parent.textContent = value;
    return;
  }

  if (start > 0) parent.appendChild(document.createTextNode(value.slice(0, start)));
  const source = value.slice(start);
  const tokenRe = /("(?:\\.|[^"\\])*")(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  let lastIndex = 0;
  let match;
  while ((match = tokenRe.exec(source)) !== null) {
    if (match.index > lastIndex) {
      parent.appendChild(document.createTextNode(source.slice(lastIndex, match.index)));
    }
    const token = match[0];
    const span = document.createElement("span");
    if (match[1]) {
      const isKey = Boolean(match[2]);
      span.className = isKey ? "raw-json-key" : "raw-json-string";
      if (isKey) {
        try {
          const key = JSON.parse(match[1]);
          if (RAW_JSON_IMPORTANT_KEYS.has(key)) span.classList.add("important");
        } catch (err) {
          // Keep normal key styling if the token cannot be unescaped.
        }
      }
    } else if (/^(?:true|false|null)$/.test(token)) {
      span.className = "raw-json-literal";
    } else {
      span.className = "raw-json-number";
    }
    span.textContent = token;
    parent.appendChild(span);
    lastIndex = match.index + token.length;
  }
  if (lastIndex < source.length) {
    parent.appendChild(document.createTextNode(source.slice(lastIndex)));
  }
}

export function renderRawLogBlock({ raw, level = "", type = "", parser = "", maxLength = state.ui.rawClipLength, lazy = false } = {}) {
  const value = String(raw || "");
  const clipped = clippedText(value, maxLength);
  const accent = rawLogAccent(level, type || parser, value);
  const block = document.createElement("div");
  block.className = `raw-log-block raw-log-${accent}`;
  block.dataset.loaded = "false";

  const head = document.createElement("div");
  head.className = "raw-log-head";
  const typeChip = document.createElement("span");
  typeChip.className = "raw-log-chip raw-log-type";
  typeChip.textContent = rawLogTypeLabel(value, type, parser);
  const levelChip = document.createElement("span");
  levelChip.className = `raw-log-chip raw-log-level-${accent}`;
  levelChip.textContent = String(level || accent || "other").toUpperCase();
  const lengthChip = document.createElement("span");
  lengthChip.className = "raw-log-chip";
  lengthChip.textContent = `${value.length} 字符`;
  head.append(typeChip, levelChip, lengthChip);
  if (clipped.clipped) {
    const clipChip = document.createElement("span");
    clipChip.className = "raw-log-chip raw-log-clipped";
    clipChip.textContent = "已裁剪";
    head.appendChild(clipChip);
  }

  const text = document.createElement("pre");
  text.className = "raw-log-text";
  text.tabIndex = 0;
  text.textContent = lazy ? "展开后加载原文" : "";

  const load = () => {
    if (block.dataset.loaded === "true") return;
    text.textContent = "";
    appendRawJsonHighlighted(text, clipped.text, value);
    block.dataset.loaded = "true";
  };
  block.loadRawLog = load;
  block.append(head, text);
  if (!lazy) load();
  return block;
}

export function hydrateRawLogBlock(block) {
  if (block && typeof block.loadRawLog === "function") block.loadRawLog();
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
 * 渲染键值对列表（增量更新）
 * @param {string} id - 容器元素 ID
 * @param {object} entries - 键值对对象
 */
export function renderKv(id, entries) {
  const el = $(id);
  if (!el) return;

  // 建立现有行索引
  const existing = new Map();
  el.querySelectorAll('.kv-row').forEach(row => {
    const k = row.dataset.kvKey;
    if (k) existing.set(k, row);
  });

  const fragment = document.createDocumentFragment();
  Object.entries(entries).forEach(([key, value]) => {
    let row = existing.get(key);
    if (!row) {
      row = document.createElement("div");
      row.className = "kv-row";
      row.dataset.kvKey = key;
      row.innerHTML = '<div class="kv-key"></div><div class="kv-value"></div>';
      fragment.appendChild(row);
    } else {
      existing.delete(key);
    }
    row.firstElementChild.textContent = key;
    row.lastElementChild.textContent = value == null || value === "" ? "--" : String(value);
  });

  // 移除多余旧行
  existing.forEach(row => row.remove());
  // 追加新行
  el.appendChild(fragment);
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

/**
 * 创建增强的空状态元素
 * @param {string} type - 空状态类型 (logs, events, sessions)
 * @returns {HTMLElement}
 */
export function emptyState(type = "default") {
  const messages = {
    logs: {
      icon: "📭",
      title: "没有匹配的日志",
      hint: "尝试调整时间范围、搜索条件或刷新数据"
    },
    events: {
      icon: "✨",
      title: "没有检测到重要事件",
      hint: "系统运行正常，或尝试刷新查看最新数据"
    },
    sessions: {
      icon: "💬",
      title: "暂无会话数据",
      hint: "等待新的对话会话创建"
    },
    default: {
      icon: "📦",
      title: "暂无数据",
      hint: "刷新页面以查看最新内容"
    }
  };

  const msg = messages[type] || messages.default;
  const container = document.createElement("div");
  container.className = "empty-state";
  container.innerHTML = `
    <div class="empty-icon">${msg.icon}</div>
    <p class="empty-title">${msg.title}</p>
    <p class="empty-hint">${msg.hint}</p>
  `;
  return container;
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
