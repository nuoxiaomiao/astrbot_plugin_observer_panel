// ============================================================================
// 组件 - 事件列表
// ============================================================================

import { state } from "../state.js?v=20260709-mobile1";
import { IMPORTANT_EVENT_TYPES } from "../config.js?v=20260709-mobile1";
import { formatTime, formatCompactLogTime } from "../utils/format.js?v=20260709-mobile1";
import {
  $,
  setText,
  badge,
  emptyBlock,
  emptyState,
  detailRow,
  privacyText,
  renderSignature,
  bindDetailsState,
  pruneOpenDetails,
  eventChainDetailKey,
  renderRawLogBlock,
} from "../utils/dom.js?v=20260709-mobile1";
import {
  eventTypeLabel,
  eventTypeBadge,
  eventTypeClass,
  confidenceLabel,
  eventDurationLabel,
  evidenceDetailKey,
} from "../log/analytics.js?v=20260709-mobile1";
import { focusLogEntry } from "./log-list.js?v=20260709-mobile1";

let renderLogsRef = () => {};

export function initEventListActions(actions) {
  renderLogsRef = actions.renderLogs;
}

function eventListSignature(events, limit) {
  return [
    "events",
    state.privacyMode,
    limit,
    events.map((event) => [
      event.id,
      event.timestamp,
      event.type,
      event.title,
      event.detail,
      event.meta,
      event.durationMs,
      event.evidence?.logEntryId,
      event.evidence?.rule,
    ]),
  ];
}

export function filterEvents(events) {
  return events.filter((event) => {
    if (state.eventType !== "all" && event.type !== state.eventType) return false;
    return true;
  });
}

export function renderEventList(id, events, limit = 40) {
  const visible = events.slice(0, limit);
  const el = renderSignature(id, eventListSignature(visible, limit));
  if (!el) return;
  el.innerHTML = "";
  const allowChain = id === "importantEventList";
  if (allowChain) {
    const chainKeys = new Set(visible.filter((event) => event.spanId).map((event) => eventChainDetailKey(event)));
    const evidenceKeys = new Set(visible.filter((event) => event.evidence).map((event) => evidenceDetailKey(event)));
    pruneOpenDetails("event-chain:", chainKeys);
    pruneOpenDetails("event-evidence:", evidenceKeys);
  }
  if (!visible.length) {
    el.appendChild(emptyState("events"));
    return;
  }
  const fragment = document.createDocumentFragment();
  visible.forEach((event) => {
    const item = document.createElement("article");
    item.className = `event-item ${eventTypeClass(event.type)}`;
    if (allowChain) {
      item.dataset.eventId = event.id;
      item.classList.add("selectable");
      if (state.selectedEventId && event.id === state.selectedEventId) {
        item.classList.add("selected");
      }
      item.tabIndex = 0;
      item.addEventListener("click", () => selectImportantEvent(event.id));
      item.addEventListener("keydown", (evt) => {
        if (evt.key === "Enter" || evt.key === " ") {
          evt.preventDefault();
          selectImportantEvent(event.id);
        }
      });
    }
    const head = document.createElement("div");
    head.className = "event-head";
    const left = document.createElement("div");
    left.className = "event-title";
    const title = document.createElement("strong");
    title.textContent = event.title || eventTypeLabel(event.type);
    const meta = document.createElement("small");
    meta.textContent = [
      formatTime(event.timestamp),
      event.sensitiveMeta ? privacyText(event.meta) : event.meta,
    ].filter(Boolean).join(" | ");
    left.append(title, meta);
    head.append(left, badge(eventTypeLabel(event.type), eventTypeBadge(event.type)));
    const detail = document.createElement("p");
    detail.textContent = event.sensitive ? privacyText(event.detail) : (event.detail || "--");
    item.append(head, detail);
    if (allowChain) {
      const hint = document.createElement("small");
      hint.className = "event-select-hint";
      hint.textContent = "点击查看证据";
      item.appendChild(hint);
    }
    fragment.appendChild(item);
  });
  el.appendChild(fragment);
}

export function currentImportantEvents() {
  const insights = state.traceInsights;
  if (!insights) return [];
  return filterEvents(insights.events.filter((event) => IMPORTANT_EVENT_TYPES.has(event.type)));
}

export function selectedImportantEvent() {
  const events = currentImportantEvents();
  return events.find((event) => event.id === state.selectedEventId) || events[0] || null;
}

export function selectImportantEvent(eventId) {
  state.selectedEventId = eventId || "";
  // 仅就地切换高亮，避免重建列表 DOM 触发整列入场动画重播
  const list = $("importantEventList");
  if (list) {
    list.querySelectorAll(".event-item").forEach((el) => {
      el.classList.toggle("selected", !!state.selectedEventId && el.dataset.eventId === state.selectedEventId);
    });
  }
  renderDetailPanel();
  // 平板抽屉断点（≤1400px 且非手机内联区）下，选中事件时滑出详情抽屉
  if (state.selectedEventId && window.matchMedia("(max-width: 1400px) and (min-width: 981px)").matches) {
    document.querySelector(".workspace-detail")?.classList.add("open");
    document.body.classList.add("detail-open");
  }
}

export function renderDetailPanel() {
  const body = $("detailBody");
  if (!body) return;
  body.innerHTML = "";
  // 内容重建后触发一次入场动画（尊重动画开关 / reduced-motion）
  body.classList.remove("detail-enter");
  void body.offsetWidth; // 强制 reflow，使重复选择也能重播动画
  body.classList.add("detail-enter");
  const title = $("detailTitle");
  const stamp = $("detailStamp");
  const event = selectedImportantEvent();
  if (!event) {
    if (title) title.textContent = state.activeTab === "logs" ? "事件详情" : "工作区详情";
    if (stamp) stamp.textContent = "--";
    const empty = document.createElement("div");
    empty.className = "detail-empty";
    const strong = document.createElement("strong");
    strong.textContent = "选择事件查看证据";
    const span = document.createElement("span");
    span.textContent = "点击重要信息后，这里会显示判定规则、来源行号和原始日志。";
    empty.append(strong, span);
    body.appendChild(empty);
    return;
  }

  if (!state.selectedEventId) state.selectedEventId = event.id;
  if (title) title.textContent = event.title || eventTypeLabel(event.type);
  if (stamp) stamp.textContent = formatCompactLogTime({ timestamp: event.timestamp });

  const summary = document.createElement("section");
  summary.className = "detail-section";
  summary.append(
    detailRow("事件类型", eventTypeLabel(event.type)),
    detailRow("时间", formatTime(event.timestamp)),
    detailRow("摘要", event.sensitive ? privacyText(event.detail) : event.detail),
  );
  body.appendChild(summary);

  const evidence = event.evidence;
  if (evidence) {
    const evidenceSection = document.createElement("section");
    evidenceSection.className = "detail-section";
    const heading = document.createElement("h3");
    heading.textContent = "证据";
    evidenceSection.append(
      heading,
      detailRow("判定规则", evidence.rule),
      detailRow("解析来源", evidence.parser === "trace" ? "Trace 日志" : "普通日志"),
      detailRow("置信度", confidenceLabel(evidence.confidence)),
      detailRow("来源文件", evidence.fileName || evidence.path),
      detailRow("行号", evidence.lineNumber ? `第 ${evidence.lineNumber} 行` : "--"),
      detailRow("span_id", evidence.spanId || event.spanId || "--"),
    );
    const locate = document.createElement("button");
    locate.type = "button";
    locate.textContent = "定位原文";
    locate.addEventListener("click", () => focusLogEntry(evidence.logEntryId));
    evidenceSection.appendChild(locate);
    if (!state.privacyMode && evidence.raw) {
      const raw = renderRawLogBlock({
        raw: evidence.raw,
        level: event.type === "error" ? "error" : (event.type === "warn" || event.type === "slow" ? "warn" : ""),
        type: evidence.parser === "trace" ? "Trace JSON" : "Plain",
        parser: evidence.parser,
        maxLength: 2200,
      });
      raw.classList.add("evidence-raw-block");
      evidenceSection.appendChild(raw);
    }
    body.appendChild(evidenceSection);
  }
}

export function getSessionChainEvents(event) {
  if (!event.spanId || !state.traceInsights?.events) return [];
  return state.traceInsights.events
    .filter((item) => item.spanId === event.spanId)
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}

export function buildEventChainList(chainEvents) {
  const list = document.createElement("div");
  list.className = "event-chain-list";
  chainEvents.forEach((item) => {
    const row = document.createElement("div");
    row.className = `event-chain-row ${eventTypeClass(item.type)}`;
    const left = document.createElement("span");
    left.textContent = `${formatCompactLogTime({ timestamp: item.timestamp })} | ${eventTypeLabel(item.type)}`;
    const right = document.createElement("strong");
    const duration = eventDurationLabel(item.durationMs);
    const detail = item.sensitive ? privacyText(item.detail) : item.detail;
    right.textContent = [item.title, duration, detail].filter(Boolean).join(" | ");
    row.append(left, right);
    list.appendChild(row);
  });
  return list;
}

export function renderDetailEventChain(event) {
  const chainEvents = getSessionChainEvents(event);
  if (chainEvents.length <= 1) return null;
  const section = document.createElement("section");
  section.className = "detail-section";
  const heading = document.createElement("h3");
  heading.textContent = `会话链路 ${chainEvents.length} 步`;
  section.appendChild(heading);
  section.appendChild(buildEventChainList(chainEvents));
  return section;
}

export function renderEventChain(event) {
  const chainEvents = getSessionChainEvents(event);
  if (chainEvents.length <= 1) return null;
  const details = document.createElement("details");
  details.className = "event-chain";
  bindDetailsState(details, eventChainDetailKey(event));
  const summary = document.createElement("summary");
  summary.textContent = `查看会话链路 ${chainEvents.length} 步`;
  details.appendChild(summary);
  details.appendChild(buildEventChainList(chainEvents));
  return details;
}
