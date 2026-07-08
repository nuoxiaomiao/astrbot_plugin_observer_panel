// ============================================================================
// 组件 - 日志流
// ============================================================================

import { state } from "../state.js?v=20260708-telemetry1";
import { LEVELS } from "../config.js?v=20260708-telemetry1";
import { formatCompactLogTime } from "../utils/format.js?v=20260708-telemetry1";
import {
  $,
  setText,
  emptyBlock,
  emptyState,
  textSpan,
  smallPill,
  cssEscape,
  bindDetailsState,
  pruneOpenDetails,
  logEntryDetailKey,
  getLogSearchText,
  stableKeyText,
  renderSignature,
  renderRawLogBlock,
  hydrateRawLogBlock,
} from "../utils/dom.js?v=20260708-telemetry1";
import { compactText } from "../utils/log-text.js?v=20260708-telemetry1";
import { buildLogTextMatcher, cachedNormalizeModuleGroup } from "../log/analytics.js?v=20260708-telemetry1";

let selectTabRef = () => {};
let syncDetailVisibilityRef = () => {};
let renderWorkspaceChromeRef = () => {};
let renderLogsRef = () => {};

export function initLogListActions(actions) {
  selectTabRef = actions.selectTab;
  syncDetailVisibilityRef = actions.syncDetailVisibility;
  renderWorkspaceChromeRef = actions.renderWorkspaceChrome;
  renderLogsRef = actions.renderLogs;
}

export function renderLogStream(entries) {
  const list = $("logList");
  if (!list) return;
  list.className = "log-list";
  if (!entries.length) {
    setText("logStreamMeta", "0 行");
    setText("logPageInfo", "--");
    const emptyList = renderSignature("logList", ["empty", state.logLevel, getLogSearchText(), state.logRegex, state.privacyMode]);
    if (!emptyList) return;
    emptyList.innerHTML = "";
    list.appendChild(emptyState("logs"));
    return;
  }

  const newest = [...entries].reverse();
  const totalPages = Math.max(1, Math.ceil(newest.length / state.logPageSize));
  state.logPage = Math.min(Math.max(1, state.logPage), totalPages);
  const start = (state.logPage - 1) * state.logPageSize;
  const pageEntries = newest.slice(start, start + state.logPageSize);
  const activeDetailKeys = new Set(
    pageEntries
      .filter((entry) => !state.privacyMode && (entry.raw || "") !== (entry.summary || ""))
      .map((entry) => logEntryDetailKey(entry)),
  );
  pruneOpenDetails("log-entry:", activeDetailKeys);
  setText("logStreamMeta", `${entries.length} 行`);
  setText("logPageInfo", `第 ${state.logPage} / ${totalPages} 页`);
  const prev = $("logPrevPage");
  const next = $("logNextPage");
  if (prev) prev.disabled = state.logPage <= 1;
  if (next) next.disabled = state.logPage >= totalPages;

  const signature = [
    "log-stream",
    state.privacyMode,
    state.logLevel,
    getLogSearchText(),
    state.logRegex,
    state.logPage,
    state.logPageSize,
    state.highlightLogEntryId,
    entries.length,
    pageEntries.map((entry) => [
      entry.id,
      entry.level,
      entry.timestamp,
      entry.fileMtime,
      stableKeyText(entry.summary, 180),
      String(entry.raw || "").length,
      stableKeyText(entry.raw, 160),
    ]),
  ];
  if (!renderSignature("logList", signature)) return;
  // 重建前记录滚动位置，重建后恢复，避免"滑到顶部再滑回"打断用户操作（问题3）
  const savedScrollTop = list.scrollTop;
  list.innerHTML = "";

  const fragment = document.createDocumentFragment();
  pageEntries.forEach((entry) => {
    const rowEl = document.createElement("article");
    rowEl.className = `log-entry level-${entry.level}`;
    if (state.highlightLogEntryId && entry.id === state.highlightLogEntryId) {
      rowEl.classList.add("highlight");
    }
    rowEl.dataset.logEntryId = entry.id;
    const module = cachedNormalizeModuleGroup(entry);
    const sourceText = [entry.sourceName, entry.scope, entry.moduleName].filter(Boolean).join(" | ");
    rowEl.title = sourceText || entry.path || "";
    const meta = document.createElement("div");
    meta.className = "log-entry-meta";
    meta.append(
      smallPill(LEVELS[entry.level].label, LEVELS[entry.level].badge),
      textSpan(formatCompactLogTime(entry), "log-time"),
      textSpan(entry.lineNumber ? `行 ${entry.lineNumber}` : "--", "log-line"),
      textSpan(module.label || entry.moduleName || "--", "log-module")
    );
    const summary = document.createElement("div");
    summary.className = "log-entry-summary";
    if (state.privacyMode) {
      summary.textContent = "隐私模式已隐藏原始日志内容";
    } else {
      const summaryText = compactText(entry.summary || entry.message || entry.raw, 260);
      appendHighlighted(summary, summaryText);
    }
    rowEl.append(meta, summary);
    if (!state.privacyMode && (entry.raw || "") !== (entry.summary || "")) {
      const details = document.createElement("details");
      details.className = "log-entry-details";
      bindDetailsState(details, logEntryDetailKey(entry));
      const toggle = document.createElement("summary");
      toggle.textContent = "展开原文";
      const rawBlock = renderRawLogBlock({
        raw: entry.raw,
        level: entry.level,
        type: entry.trace ? `trace:${entry.trace.action || "event"}` : "plain",
        lazy: true,
      });
      details.addEventListener("toggle", () => {
        if (details.open) hydrateRawLogBlock(rawBlock);
      });
      if (details.open) hydrateRawLogBlock(rawBlock);
      details.append(toggle, rawBlock);
      rowEl.appendChild(details);
    }
    fragment.appendChild(rowEl);
  });
  list.appendChild(fragment);
  // 恢复滚动位置：无显式定位请求时保持用户当前滚动（问题3）
  if (state.pendingScrollHighlight) {
    scrollHighlightedLogEntry();
    state.pendingScrollHighlight = false;
  } else if (state.logScrollLocked && savedScrollTop !== null) {
    // 使用 requestAnimationFrame 确保布局完成后再恢复滚动位置
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        list.scrollTop = savedScrollTop;
      });
    });
  }
}

export function syncLogLevelButtons() {
  document.querySelectorAll(".level-filter").forEach((button) => {
    button.classList.toggle("active", button.dataset.level === state.logLevel);
  });
}

export function scrollHighlightedLogEntry() {
  if (!state.highlightLogEntryId) return;
  const row = document.querySelector(`[data-log-entry-id="${cssEscape(state.highlightLogEntryId)}"]`);
  if (row) {
    row.scrollIntoView({ block: "center", behavior: "smooth" });

    // 2.5 秒后自动移除高亮
    window.clearTimeout(scrollHighlightedLogEntry._timer);
    scrollHighlightedLogEntry._timer = window.setTimeout(() => {
      if (row.classList.contains("highlight")) {
        row.classList.remove("highlight");
      }
    }, 2500);
  }
}

export function focusLogEntry(logEntryId, options = {}) {
  if (!logEntryId || !state.logCache.entries?.length) return;
  selectTabRef("logs");
  document.querySelectorAll(".tab").forEach((tab) => {
    const active = tab.dataset.tab === "logs";
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  });
  document.querySelectorAll(".view").forEach((view) => {
    const active = view.id === "logs";
    view.classList.toggle("active", active);
    view.hidden = !active;
  });

  syncDetailVisibilityRef();
  renderWorkspaceChromeRef();

  const input = $("logFilter");
  if (input) input.value = "";
  state.logLevel = "all";
  syncLogLevelButtons();
  state.highlightLogEntryId = logEntryId;
  state.pendingScrollHighlight = true; // 标记：本次渲染后需滚动到高亮项

  const entries = [...state.logCache.entries].reverse();
  const index = entries.findIndex((entry) => entry.id === logEntryId);
  if (index >= 0) {
    if (options.expandRaw) {
      state.openDetails.add(logEntryDetailKey(entries[index]));
    }
    state.logPage = Math.floor(index / state.logPageSize) + 1;
  }
  renderLogsRef();
  // 兜底：若 renderLogs 因签名未变而跳过渲染，仍需滚动一次
  window.setTimeout(scrollHighlightedLogEntry, 50);
}

/**
 * 将文本写入元素，并用 <mark> 标记匹配当前搜索词的部分（XSS 安全）。
 * @param {HTMLElement} parent - 目标元素
 * @param {string} text - 原始文本
 */
export function appendHighlighted(parent, text) {
  const value = String(text || "");
  const matcher = buildLogTextMatcher();
  if (!matcher) {
    parent.textContent = value;
    return;
  }
  let re;
  if (matcher.regex) {
    re = matcher.regex;
    // 若原标志不含 g 则补上，用于全局匹配；保留原有 i/m 等标志
    if (!re.global) re = new RegExp(re.source, `${re.flags}g`);
  } else {
    // 子串模式：转义正则元字符
    const charsToEscape = ".*+?^${}()|[]\\";
    const escaped = matcher.substr.split("").map((c) => (charsToEscape.includes(c) ? "\\" + c : c)).join("");
    re = new RegExp(escaped, "gi");
  }
  let lastIndex = 0;
  let match;
  while ((match = re.exec(value)) !== null) {
    const matchedText = match[0];
    if (!matchedText) {
      // 避免零宽匹配导致死循环
      re.lastIndex += 1;
      continue;
    }
    if (match.index > lastIndex) {
      parent.appendChild(document.createTextNode(value.slice(lastIndex, match.index)));
    }
    const mark = document.createElement("mark");
    mark.textContent = matchedText;
    parent.appendChild(mark);
    lastIndex = match.index + matchedText.length;
  }
  if (lastIndex < value.length) {
    parent.appendChild(document.createTextNode(value.slice(lastIndex)));
  }
  if (lastIndex === 0) {
    // 没有任何匹配，直接写全文
    parent.textContent = value;
  }
}
