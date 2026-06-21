// ============================================================================
// 视图 - AstrBot
// ============================================================================

import { state } from "../state.js?v=20260621-flow3";
import { MODULE_CHART_LIMIT } from "../config.js?v=20260621-flow3";
import {
  formatTime,
  formatNumber,
  formatCompactLogTime,
} from "../utils/format.js?v=20260621-flow3";
import {
  $,
  setText,
  emptyBlock,
  privacyText,
  renderSignature,
  badge,
} from "../utils/dom.js?v=20260621-flow3";
import { compactJson, compactText } from "../utils/log-text.js?v=20260621-flow3";
import { renderBarChart } from "../components/chart.js?v=20260621-flow3";
import {
  countBy,
  aggregateModuleGroups,
  eventTypeLabel,
  eventTypeClass,
  sessionSourceLabel,
} from "../log/analytics.js?v=20260621-flow3";

export function functionCard(title, value, meta, kind = "") {
  const item = document.createElement("article");
  item.className = `function-card ${kind || ""}`;
  const label = document.createElement("span");
  label.textContent = title;
  const number = document.createElement("strong");
  number.textContent = value == null || value === "" ? "--" : String(value);
  const hint = document.createElement("small");
  hint.textContent = meta || "--";
  item.append(label, number, hint);
  return item;
}

export function renderAstrBot() {
  if (!state.traceInsights) return;
  renderAstrBotVisuals(state.traceInsights, state.logCache.entries || []);
}

function sessionStatusMeta(session) {
  if (!session) return { label: "待完成", kind: "debug" };
  if (session.displayStatus === "empty") {
    if (session.replyKind === "image") return { label: "图片回复", kind: "warn" };
    if (session.replyKind === "action") return { label: "动作执行", kind: "warn" };
    if (session.replyKind === "emoji") return { label: "表情互动", kind: "warn" };
    return { label: "正文未记录", kind: "warn" };
  }
  if (session.displayStatus === "complete") return { label: "已回复", kind: "ok" };
  if (session.displayStatus === "error") return { label: "错误", kind: "bad" };
  if (session.displayStatus === "generating") return { label: "生成中", kind: "warn" };
  if (session.displayStatus === "running") return { label: "进行中", kind: "debug" };
  return { label: "待完成", kind: "debug" };
}

function sessionIsLive(session) {
  return session?.displayStatus === "running" || session?.displayStatus === "generating";
}

function sessionLiveClass(session) {
  if (!sessionIsLive(session)) return "";
  return session.displayStatus === "generating" ? "is-generating" : "is-running";
}

function withLiveBadge(chip, label, liveClass = "") {
  if (!liveClass) return chip;
  chip.classList.add("session-live-badge", liveClass);
  chip.textContent = "";
  const text = document.createElement("span");
  text.className = `session-live-text ${liveClass}`;
  text.textContent = label;
  chip.appendChild(text);
  return chip;
}

function buildSessionStatus(status, session) {
  const wrap = document.createElement("div");
  wrap.className = "session-status-cluster";
  const chip = badge(status.label, status.kind);
  wrap.appendChild(withLiveBadge(chip, status.label, sessionIsLive(session) ? sessionLiveClass(session) : ""));
  return wrap;
}

function formatDurationMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return "--";
  return `${(number / 1000).toFixed(number >= 10000 ? 1 : 2)} 秒`;
}

function sessionResponsePlaceholder(session) {
  if (!session) return "--";
  if (session.displayStatus === "complete" || session.displayStatus === "empty") {
    return session.replyHint || "该会话已完成，但日志中没有文本回复正文。";
  }
  if (session.displayStatus === "error") {
    return "该会话执行出错，未生成最终回复。";
  }
  return "会话仍在进行中，等待最终回复日志。";
}

function syncSessionListSelection() {
  const list = $("sessionList");
  if (!list) return;
  list.querySelectorAll(".session-card[data-span-id]").forEach((item) => {
    const active = item.dataset.spanId === state.selectedSessionId;
    item.classList.toggle("selected", active);
    item.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

function buildSessionCard(session) {
  const item = document.createElement("article");
  item.className = "session-card is-new";
  item.tabIndex = 0;
  item.setAttribute("role", "button");

  const head = document.createElement("div");
  head.className = "session-card-head";

  const titleWrap = document.createElement("div");
  titleWrap.className = "session-card-title";
  const sender = document.createElement("strong");
  const time = document.createElement("small");
  titleWrap.append(sender, time);

  const status = document.createElement("div");
  status.className = "session-card-status";
  head.append(titleWrap, status);

  const message = document.createElement("p");
  message.className = "session-card-message";

  const footer = document.createElement("div");
  footer.className = "session-card-footer";
  const duration = document.createElement("span");
  duration.className = "session-card-duration";
  footer.append(duration);

  item.append(head, message, footer);
  item.addEventListener("click", () => selectSession(item.dataset.spanId));
  item.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectSession(item.dataset.spanId);
    }
  });
  updateSessionCard(item, session);
  return item;
}

function updateSessionCard(item, session) {
  item.dataset.spanId = session.spanId || "";
  item.className = "session-card";
  if (session.spanId === state.selectedSessionId) item.classList.add("selected");
  if (sessionIsLive(session)) item.classList.add("is-live", sessionLiveClass(session));
  item.setAttribute("aria-pressed", session.spanId === state.selectedSessionId ? "true" : "false");
  item.setAttribute("aria-busy", sessionIsLive(session) ? "true" : "false");

  const { label, kind } = sessionStatusMeta(session);
  const sender = item.querySelector(".session-card-title strong");
  const time = item.querySelector(".session-card-title small");
  const status = item.querySelector(".session-card-status");
  const message = item.querySelector(".session-card-message");
  const duration = item.querySelector(".session-card-duration");

  if (sender) {
    sender.textContent = state.privacyMode
      ? "隐私模式"
      : compactText(session.senderName || sessionSourceLabel(session) || "未记录发送者", 24);
  }
  if (time) {
    time.textContent = `${formatCompactLogTime({ timestamp: session.lastTs || session.startTs || 0 })} | ${sessionSourceLabel(session)}`;
  }
  if (status) {
    status.replaceChildren(buildSessionStatus({ label, kind }, session));
  }
  if (message) {
    message.textContent = privacyText(
      compactText(session.messageOutline || "消息内容未记录", 96),
      "隐私模式已隐藏消息内容",
    );
  }
  if (duration) {
    duration.textContent = session.durationMs != null
      ? `总耗时 ${formatDurationMs(session.durationMs)}`
      : (sessionIsLive(session) ? "等待更多阶段..." : "耗时未记录");
  }
}

function patchSessionList(list, sessions) {
  const existing = new Map(
    [...list.querySelectorAll(".session-card[data-span-id]")]
      .map((item) => [item.dataset.spanId, item]),
  );
  const fragment = document.createDocumentFragment();
  sessions.forEach((session) => {
    let item = existing.get(session.spanId);
    if (!item) {
      item = buildSessionCard(session);
    } else {
      existing.delete(session.spanId);
      updateSessionCard(item, session);
    }
    fragment.appendChild(item);
  });
  list.replaceChildren(fragment);
}

function sessionDetailSignature(session) {
  if (!session) return ["astrbot-session-detail", "empty", state.privacyMode];
  const toolsSig = (session.tools || [])
    .map((t) => `${t.id || t.name}:${t.status || ""}:${t.startTs || 0}:${t.endTs || 0}`)
    .join("|");
  return [
    "astrbot-session-detail",
    state.privacyMode,
    session.spanId,
    session.displayStatus,
    session.replyKind,
    session.startTs,
    session.lastTs,
    session.senderName,
    session.messageOutline,
    session.response,
    session.durationMs,
    session.timeToFirstTokenMs,
    session.providerId,
    session.model,
    JSON.stringify(session.tokenUsage || {}),
    (session.events || []).join(","),
    toolsSig,
  ];
}

function selectSession(spanId) {
  state.selectedSessionId = spanId || "";
  renderAstrBot();
}

function ensureSelectedSession(sessions) {
  if (!Array.isArray(sessions) || !sessions.length) {
    state.selectedSessionId = "";
    return null;
  }
  const current = sessions.find((session) => session.spanId === state.selectedSessionId);
  if (current) return current;
  state.selectedSessionId = sessions[0].spanId;
  return sessions[0];
}

function renderSessionList(insights) {
  const sessions = insights.sessions || [];
  const selected = ensureSelectedSession(sessions);
  const list = $("sessionList");
  const imageReplies = sessions.filter((item) => item.replyKind === "image").length;
  const actionReplies = sessions.filter((item) => item.replyKind === "action").length;
  const emojiReplies = sessions.filter((item) => item.replyKind === "emoji").length;
  const unknownReplies = sessions.filter((item) => item.displayStatus === "empty" && !["image", "action", "emoji"].includes(item.replyKind)).length;
  setText(
    "sessionListHint",
    sessions.length
      ? `已进入 Agent ${sessions.length} 条 | 图片 ${imageReplies} | 动作 ${actionReplies} | 表情 ${emojiReplies} | 正文未记录 ${unknownReplies}`
      : "0 条 Agent 会话",
  );
  if (!list) return selected;
  if (!sessions.length) {
    list.innerHTML = "";
    list.appendChild(emptyBlock("暂无已进入 Agent 流程的会话。只有真正被唤醒并进入回复链路的 trace 会话才会显示在这里。"));
    return null;
  }
  patchSessionList(list, sessions);
  syncSessionListSelection();
  return selected;
}

function buildDetailKv(label, value) {
  const row = document.createElement("div");
  row.className = "session-kv-row";
  const key = document.createElement("span");
  key.textContent = label;
  const val = document.createElement("strong");
  val.textContent = value == null || value === "" ? "--" : String(value);
  row.append(key, val);
  return row;
}

function buildTokenSummary(tokenUsage) {
  const usage = tokenUsage || {};
  const rows = [
    ["总计", Object.values(usage).reduce((sum, value) => sum + (Number.isFinite(Number(value)) ? Number(value) : 0), 0)],
    ["输入", ["input", "input_text", "input_other", "input_cached", "prompt_tokens"].reduce((sum, key) => sum + (Number.isFinite(Number(usage[key])) ? Number(usage[key]) : 0), 0)],
    ["输出", ["output", "output_text", "completion_tokens"].reduce((sum, key) => sum + (Number.isFinite(Number(usage[key])) ? Number(usage[key]) : 0), 0)],
  ];
  const wrap = document.createElement("div");
  wrap.className = "session-kv-grid";
  rows.forEach(([label, value]) => {
    wrap.appendChild(buildDetailKv(label, value ? formatNumber(value) : "--"));
  });
  return wrap;
}

function buildEventTimeline(session, insights) {
  const ids = new Set(session.events || []);
  const live = sessionIsLive(session);
  const items = (insights.events || [])
    .filter((event) => ids.has(event.id))
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  if (!items.length) return emptyBlock("该会话暂无可展示的阶段事件。");
  const list = document.createElement("div");
  list.className = "session-timeline";
  items.forEach((event, index) => {
    const row = document.createElement("article");
    row.className = `session-timeline-item ${eventTypeClass(event.type)}`;
    if (live && index === items.length - 1) {
      row.classList.add("is-live-latest", sessionLiveClass(session));
    }
    const head = document.createElement("div");
    head.className = "session-timeline-head";
    const left = document.createElement("strong");
    left.textContent = event.title || eventTypeLabel(event.type);
    const right = document.createElement("small");
    right.textContent = formatCompactLogTime({ timestamp: event.timestamp || 0 });
    head.append(left, right);
    const detail = document.createElement("p");
    detail.textContent = event.sensitive
      ? privacyText(event.detail, "隐私模式已隐藏事件内容")
      : (event.detail || "--");
    row.append(head, detail);
    list.appendChild(row);
  });
  return list;
}

function buildToolList(session) {
  const tools = session.tools || [];
  if (!tools.length) return emptyBlock("该会话没有工具调用。");
  const list = document.createElement("div");
  list.className = "session-tool-list";
  tools.forEach((tool) => {
    const item = document.createElement("article");
    item.className = "session-tool-item";
    if (tool.status === "running") item.classList.add("is-live", "is-generating");
    const head = document.createElement("div");
    head.className = "session-tool-head";
    const title = document.createElement("strong");
    title.textContent = tool.name || "未知工具";
    const meta = badge(tool.status === "running" ? "运行中" : "已完成", tool.status === "running" ? "warn" : "ok");
    if (tool.status === "running") {
      meta.classList.add("session-live-badge", "is-generating");
      meta.textContent = "";
      const metaText = document.createElement("span");
      metaText.className = "session-live-text is-generating";
      metaText.textContent = "运行中";
      meta.appendChild(metaText);
    }
    head.append(title, meta);
    const info = document.createElement("div");
    info.className = "session-tool-meta";
    info.append(
      buildDetailKv("开始", tool.startTs ? formatTime(tool.startTs) : "--"),
      buildDetailKv("结束", tool.endTs ? formatTime(tool.endTs) : "--"),
      buildDetailKv("耗时", tool.durationMs != null ? formatDurationMs(tool.durationMs) : "--"),
    );
    const args = document.createElement("pre");
    args.className = "session-code-block";
    args.textContent = privacyText(
      compactJson(tool.args, 800) || "无参数",
      "隐私模式已隐藏工具参数",
    );
    const result = document.createElement("pre");
    result.className = "session-code-block";
    result.textContent = privacyText(
      compactText(tool.result || "无返回内容", 1200),
      "隐私模式已隐藏工具返回",
    );
    item.append(head, info, args, result);
    list.appendChild(item);
  });
  return list;
}

function joinMeta(parts) {
  return parts.filter(Boolean).join(" | ");
}

function sessionEventItems(session, insights) {
  const ids = new Set(session.events || []);
  return (insights.events || [])
    .filter((event) => ids.has(event.id))
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}

function sessionTokenSum(tokenUsage, keys) {
  const usage = tokenUsage || {};
  return keys.reduce((sum, key) => {
    const value = Number(usage[key]);
    return Number.isFinite(value) ? sum + value : sum;
  }, 0);
}

function extractErrorCode(text) {
  const value = String(text || "");
  let match = value.match(/\bHTTP\s*(\d{3})\b/i)
    || value.match(/\bstatus(?:\s*code)?\s*[:=]?\s*(\d{3})\b/i)
    || value.match(/\berror(?:\s*code)?\s*[:=]?\s*(\d{3})\b/i);
  if (match) return match[1];
  match = value.match(/"code"\s*:\s*"([^"]+)"/i)
    || value.match(/\bcode\s*[:=]\s*([a-z_]+)\b/i);
  return match ? match[1] : "";
}

function looksLikeErrorText(text) {
  const raw = String(text || "").trim();
  if (!raw) return false;
  // 显式成功标志优先：不判失败
  if (/resultok\s*[:=]\s*true|"ok"\s*:\s*true|"success"\s*:\s*true|"success"\s*:\s*"true"|"status"\s*:\s*"ok"|"status"\s*:\s*"success"|操作成功|执行成功|调用成功/i.test(raw)) {
    return false;
  }
  // error 字段为空/null/false 时不算失败
  const cleaned = raw
    .replace(/"error"\s*:\s*(null|""|''|false|\[\]|\{\})\s*,?/gi, "")
    .replace(/"error_code"\s*:\s*0\b/gi, "")
    .replace(/"errorCode"\s*:\s*0\b/gi, "")
    .replace(/"has_error"\s*:\s*false\b/gi, "")
    .replace(/"success"\s*:\s*true\b/gi, "");
  // 收紧关键词：要求出现明确失败短语，而非单独的 error/结束
  return /failed|bad_request|invalid_request|请求失败|未成功|执行失败|调用失败|操作失败|traceback|exception:|error:\s*\d{3}|error\s*code\s*[:=]?\s*[1-9]/i.test(cleaned);
}

function buildFlowBadge(label, kind, liveClass = "") {
  return withLiveBadge(badge(label, kind), label, liveClass);
}

function buildFlowStep(step, index) {
  const row = document.createElement("article");
  row.className = `session-flow-step ${step.kind || ""} ${step.state || ""}`.trim();
  row.style.setProperty("--step-delay", `${index * 0.07}s`);
  if (step.liveClass) row.classList.add(step.liveClass);
  row.dataset.stepKey = step.key;

  const rail = document.createElement("div");
  rail.className = "session-flow-rail";
  const dot = document.createElement("span");
  dot.className = "session-flow-dot";
  rail.appendChild(dot);

  const main = document.createElement("div");
  main.className = "session-flow-main";

  const head = document.createElement("div");
  head.className = "session-flow-head";
  const title = document.createElement("strong");
  title.className = "session-flow-title";
  title.textContent = step.title;
  if (step.liveClass) title.classList.add("session-live-copy", step.liveClass);
  const aside = document.createElement("div");
  aside.className = "session-flow-aside";
  aside.appendChild(buildFlowBadge(step.badgeLabel, step.badgeKind, step.liveClass));
  head.append(title, aside);

  const body = document.createElement("p");
  body.className = "session-flow-body";
  if (step.liveClass && step.liveBody) body.classList.add("session-live-copy", step.liveClass);
  body.textContent = step.body || "--";

  const meta = document.createElement("div");
  meta.className = "session-flow-meta";
  const time = document.createElement("small");
  time.textContent = step.timeLabel || "--";
  meta.appendChild(time);
  if (step.meta) {
    const extra = document.createElement("small");
    extra.textContent = step.meta;
    meta.appendChild(extra);
  }

  main.append(head, body, meta);
  row.append(rail, main);
  return row;
}

function updateFlowStep(row, step, index) {
  row.className = `session-flow-step ${step.kind || ""} ${step.state || ""}`.trim();
  row.style.setProperty("--step-delay", `${index * 0.07}s`);
  if (step.liveClass) row.classList.add(step.liveClass);
  row.dataset.stepKey = step.key;

  const title = row.querySelector(".session-flow-title");
  if (title) {
    title.textContent = step.title;
    title.classList.toggle("session-live-copy", Boolean(step.liveClass));
    if (step.liveClass) title.classList.add(step.liveClass);
  }
  const body = row.querySelector(".session-flow-body");
  if (body) {
    body.textContent = step.body || "--";
    body.classList.toggle("session-live-copy", Boolean(step.liveClass && step.liveBody));
    if (step.liveClass && step.liveBody) body.classList.add(step.liveClass);
  }
  const badgeEl = row.querySelector(".session-flow-aside");
  if (badgeEl) {
    badgeEl.replaceChildren(buildFlowBadge(step.badgeLabel, step.badgeKind, step.liveClass));
  }
  const meta = row.querySelector(".session-flow-meta");
  if (meta) {
    meta.replaceChildren();
    const time = document.createElement("small");
    time.textContent = step.timeLabel || "--";
    meta.appendChild(time);
    if (step.meta) {
      const extra = document.createElement("small");
      extra.textContent = step.meta;
      meta.appendChild(extra);
    }
  }
}

function patchSessionFlow(container, steps, animateNew = true) {
  const existing = new Map(
    [...container.querySelectorAll(".session-flow-step[data-step-key]")]
      .map((item) => [item.dataset.stepKey, item]),
  );
  const fragment = document.createDocumentFragment();
  steps.forEach((step, index) => {
    let row = existing.get(step.key);
    if (!row) {
      row = buildFlowStep(step, index);
      if (animateNew) row.classList.add("is-new");
    } else {
      existing.delete(step.key);
      updateFlowStep(row, step, index);
    }
    fragment.appendChild(row);
  });
  container.replaceChildren(fragment);
}

function buildSessionJourney(session, insights) {
  const events = sessionEventItems(session, insights);
  const personaEvent = events.find((event) => event.type === "persona");
  const modelStartEvent = events.find((event) => event.type === "model_start");
  const messageOutEvent = [...events].reverse().find((event) => event.type === "message_out");
  const errorEvent = [...events].reverse().find((event) => event.type === "error");
  const tools = (session.tools || []).slice().sort((a, b) => (a.startTs || 0) - (b.startTs || 0));
  const outputTokens = sessionTokenSum(session.tokenUsage, ["output", "output_text", "completion_tokens"]);
  const live = sessionIsLive(session);
  const sessionStartTs = session.startTs || 0;
  const lastTs = session.lastTs || sessionStartTs;

  function stepDuration(fromTs, toTs) {
    if (!Number.isFinite(Number(fromTs)) || !Number.isFinite(Number(toTs))) return null;
    if (toTs <= fromTs) return null;
    return toTs - fromTs;
  }

  function stepMetaWithDuration(fromTs, toTs, extra) {
    const duration = stepDuration(fromTs, toTs);
    return joinMeta([
      duration != null ? `用时 ${formatDurationMs(duration)}` : "",
      extra || "",
    ]);
  }

  const steps = [];

  // 1. 接收消息：始终显示（会话创建时即存在）
  steps.push({
    key: "received",
    title: "接收到消息",
    body: privacyText(session.messageOutline || "日志中未记录触发消息内容", "隐私模式已隐藏消息内容"),
    timeLabel: sessionStartTs ? formatTime(sessionStartTs) : "--",
    meta: stepMetaWithDuration(sessionStartTs, personaEvent?.timestamp || modelStartEvent?.timestamp || lastTs, joinMeta([sessionSourceLabel(session), state.privacyMode ? "发送者已隐藏" : (session.senderName || "")])),
    badgeLabel: "已接收",
    badgeKind: "ok",
    state: "done",
    kind: "message",
  });

  // 2. 唤醒/规则选择：仅当 persona 事件已发生才显示
  if (personaEvent || session.personaId) {
    const nextTs = modelStartEvent?.timestamp || (tools[0]?.startTs || 0) || lastTs;
    steps.push({
      key: "persona",
      title: "检索记忆 / 唤醒规则",
      body: session.personaId || personaEvent?.detail || "已进入 Agent 处理流程",
      timeLabel: personaEvent?.timestamp ? formatTime(personaEvent.timestamp) : "--",
      meta: stepMetaWithDuration(personaEvent?.timestamp || sessionStartTs, nextTs, personaEvent?.meta || "已确认可用规则与工具集"),
      badgeLabel: "规则就绪",
      badgeKind: "ok",
      state: "done",
      kind: "context",
    });
  }

  // 3. 开始请求模型：仅当 astr_agent_prepare 已发生才显示
  //    这是 LLM 真正开始生成的时刻，不预先显示
  if (modelStartEvent || (session.enteredAgentFlow && (session.status === "complete" || session.status === "error" || session.status === "generating"))) {
    const requestStartTs = modelStartEvent?.timestamp
      || Math.max(...tools.map((t) => t.endTs || t.startTs || 0), sessionStartTs);
    const requestRunning = live && session.status !== "complete" && session.status !== "error";
    const requestEndTs = session.status === "complete" ? (messageOutEvent?.timestamp || (session.durationMs ? requestStartTs + (session.durationMs || 0) : lastTs)) : lastTs;
    steps.push({
      key: "request-start",
      title: "开始请求模型",
      body: [session.providerId, session.model].filter(Boolean).join(" / ") || "开始组织并生成最终回复",
      timeLabel: requestStartTs ? formatTime(requestStartTs) : "--",
      meta: stepMetaWithDuration(requestStartTs, requestRunning ? lastTs : requestEndTs, tools.length ? `后续工具 ${tools.length} 个` : "无额外工具调用"),
      badgeLabel: requestRunning ? "生成中" : "已发起",
      badgeKind: requestRunning ? "warn" : "ok",
      liveClass: requestRunning ? sessionLiveClass(session) : "",
      liveBody: requestRunning,
      state: requestRunning ? "running" : "done",
      kind: "request",
    });
  }

  // 4. 工具调用：按时间顺序展示已记录的工具，可能多轮
  //    工具发生在 astr_agent_prepare 之后（Agent 多轮调用）
  let prevToolEndTs = modelStartEvent?.timestamp || personaEvent?.timestamp || sessionStartTs;
  tools.forEach((tool, idx) => {
    const toolLive = tool.status === "running";
    const toolLiveClass = toolLive ? "is-generating" : "";
    const resultText = toolLive
      ? (compactJson(tool.args, 180) || "工具正在执行，等待返回结果。")
      : compactText(tool.result || "工具已完成，但没有返回正文。", 220);
    const code = extractErrorCode(tool.result);
    const errored = !toolLive && looksLikeErrorText(tool.result);
    const toolStart = tool.startTs || prevToolEndTs;
    const toolEnd = tool.endTs || lastTs;
    steps.push({
      key: `tool:${tool.id || tool.name || idx}`,
      title: `调用工具 ${tool.name || "未知工具"}`,
      body: privacyText(resultText, toolLive ? "隐私模式已隐藏工具参数" : "隐私模式已隐藏工具结果"),
      timeLabel: tool.startTs ? formatTime(tool.startTs) : "--",
      meta: toolLive
        ? stepMetaWithDuration(toolStart, lastTs, "执行中")
        : stepMetaWithDuration(toolStart, toolEnd, code ? `错误码 ${code}` : ""),
      badgeLabel: toolLive ? "进行中" : (errored ? "已失败" : "已完成"),
      badgeKind: toolLive ? "warn" : (errored ? "bad" : "ok"),
      liveClass: toolLiveClass,
      liveBody: toolLive,
      state: toolLive ? "running" : (errored ? "error" : "done"),
      kind: "tool",
    });
    if (!toolLive) prevToolEndTs = toolEnd;
  });

  // 5. 请求结果：仅当会话已完成或出错才显示（不预先显示"等待返回"）
  if (session.status === "complete") {
    const completeTs = messageOutEvent?.timestamp || lastTs;
    const startTs = modelStartEvent?.timestamp || sessionStartTs;
    steps.push({
      key: "request-result",
      title: "模型返回成功",
      body: [session.providerId, session.model].filter(Boolean).join(" / ") || "模型已返回结果",
      timeLabel: completeTs ? formatTime(completeTs) : "--",
      meta: joinMeta([
        session.durationMs != null ? `总耗时 ${formatDurationMs(session.durationMs)}` : stepDuration(startTs, completeTs) != null ? `用时 ${formatDurationMs(stepDuration(startTs, completeTs))}` : "",
        session.timeToFirstTokenMs != null ? `首 Token ${formatDurationMs(session.timeToFirstTokenMs)}` : "",
        outputTokens ? `输出 ${formatNumber(outputTokens)} Token` : "",
      ]),
      badgeLabel: "成功",
      badgeKind: "ok",
      state: "done",
      kind: "request",
    });
  } else if (session.status === "error") {
    const detail = compactText(errorEvent?.detail || "模型请求失败，未返回最终回复。", 220);
    const code = extractErrorCode(errorEvent?.detail || errorEvent?.raw || "");
    const errTs = errorEvent?.timestamp || lastTs;
    const startTs = modelStartEvent?.timestamp || sessionStartTs;
    steps.push({
      key: "request-result",
      title: "请求回复失败",
      body: privacyText(detail, "隐私模式已隐藏错误详情"),
      timeLabel: errTs ? formatTime(errTs) : "--",
      meta: joinMeta([
        session.durationMs != null ? `总耗时 ${formatDurationMs(session.durationMs)}` : stepDuration(startTs, errTs) != null ? `用时 ${formatDurationMs(stepDuration(startTs, errTs))}` : "",
        code ? `错误码 ${code}` : "",
      ]),
      badgeLabel: "失败",
      badgeKind: "bad",
      state: "error",
      kind: "request",
    });
  }

  // 6. 最终回复：仅当已完成或出错才显示正文，进行中不预先占位
  if (session.status === "complete" || session.displayStatus === "empty") {
    steps.push({
      key: "reply",
      title: session.displayStatus === "empty" ? "最终结果" : "最终回复",
      body: privacyText(
        session.response || sessionResponsePlaceholder(session),
        session.response ? "隐私模式已隐藏回复内容" : sessionResponsePlaceholder(session),
      ),
      timeLabel: lastTs ? formatTime(lastTs) : "--",
      meta: session.durationMs != null ? `总耗时 ${formatDurationMs(session.durationMs)}` : "",
      badgeLabel: session.displayStatus === "empty" ? "已完成" : "已回复",
      badgeKind: "ok",
      state: "done",
      kind: "reply",
    });
  } else if (session.status === "error") {
    steps.push({
      key: "reply",
      title: "最终结果",
      body: sessionResponsePlaceholder(session),
      timeLabel: lastTs ? formatTime(lastTs) : "--",
      meta: "",
      badgeLabel: "未完成",
      badgeKind: "bad",
      state: "error",
      kind: "reply",
    });
  }

  return steps;
}

function liveCurrentStep(session, insights) {
  const steps = buildSessionJourney(session, insights);
  if (!steps.length) return null;
  return steps[steps.length - 1];
}

function buildLiveStatusCard(session, insights) {
  const step = liveCurrentStep(session, insights);
  const card = document.createElement("article");
  card.className = "session-live-card";
  const liveClass = sessionLiveClass(session);
  if (liveClass) card.classList.add(liveClass);

  const head = document.createElement("div");
  head.className = "session-live-head";
  const titleWrap = document.createElement("div");
  titleWrap.className = "session-live-title-wrap";
  const phaseLabel = document.createElement("span");
  phaseLabel.className = "session-live-phase";
  phaseLabel.textContent = "当前阶段";
  const title = document.createElement("strong");
  title.className = "session-live-title";
  titleWrap.append(phaseLabel, title);
  const aside = document.createElement("div");
  aside.className = "session-live-aside";
  head.append(titleWrap, aside);

  const body = document.createElement("p");
  body.className = "session-live-body";

  const meta = document.createElement("div");
  meta.className = "session-live-meta";

  card.append(head, body, meta);
  patchLiveStatusCard(card, session, insights, step, false);
  return card;
}

function patchLiveStatusCard(card, session, insights, step, animate) {
  if (!step) step = liveCurrentStep(session, insights);
  if (!step) return;

  const title = card.querySelector(".session-live-title");
  const aside = card.querySelector(".session-live-aside");
  const body = card.querySelector(".session-live-body");
  const meta = card.querySelector(".session-live-meta");

  const newTitle = step.title || "--";
  const newBody = step.body || "--";
  const newMeta = joinMeta([step.timeLabel || "", step.meta || ""]);
  const liveClass = step.liveClass || sessionLiveClass(session);

  const oldTitle = title ? title.textContent : "";
  const oldBody = body ? body.textContent : "";
  const oldKey = card.dataset.stepKey || "";

  const contentChanged =
    oldKey !== (step.key || "") || oldTitle !== newTitle || oldBody !== newBody;

  if (animate && contentChanged) {
    card.classList.remove("is-refreshing");
    void card.offsetWidth;
    card.classList.add("is-refreshing");
  }

  card.classList.remove("is-generating", "is-running");
  if (liveClass) card.classList.add(liveClass);

  if (title) title.textContent = newTitle;
  if (aside) {
    aside.replaceChildren();
    aside.appendChild(
      buildFlowBadge(step.badgeLabel || "", step.badgeKind || "ok", liveClass),
    );
  }
  if (body) body.textContent = newBody;
  if (meta) {
    meta.replaceChildren();
    const metaText = document.createElement("small");
    metaText.textContent = newMeta;
    meta.appendChild(metaText);
  }

  card.dataset.stepKey = step.key || "";
}

function buildSessionOverview(session) {
  const status = sessionStatusMeta(session);
  const section = document.createElement("section");
  section.className = "session-overview-card";
  if (sessionIsLive(session)) section.classList.add("is-live", sessionLiveClass(session));

  const head = document.createElement("div");
  head.className = "session-overview-head";
  const titleWrap = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = state.privacyMode ? "已隐藏发送者" : (session.senderName || "未记录发送者");
  const subtitle = document.createElement("p");
  subtitle.textContent = joinMeta([
    sessionSourceLabel(session),
    session.startTs ? `开始于 ${formatTime(session.startTs)}` : "",
  ]);
  titleWrap.append(title, subtitle);
  head.append(titleWrap, buildSessionStatus(status, session));

  const meta = document.createElement("div");
  meta.className = "session-overview-meta";
  [
    ["模型", [session.providerId, session.model].filter(Boolean).join(" / ") || "--"],
    ["规则", session.personaId || "--"],
    ["工具", formatNumber((session.tools || []).length)],
    ["耗时", session.durationMs != null ? formatDurationMs(session.durationMs) : (sessionIsLive(session) ? "进行中" : "--")],
  ].forEach(([label, value]) => {
    const chip = document.createElement("div");
    chip.className = "session-overview-chip";
    const key = document.createElement("span");
    key.textContent = label;
    const val = document.createElement("strong");
    val.textContent = value;
    chip.append(key, val);
    meta.appendChild(chip);
  });

  section.append(head, meta);
  return section;
}

function renderSessionDetail(session, insights) {
  const detail = renderSignature("sessionDetail", sessionDetailSignature(session));
  const host = $("sessionDetail");
  if (!host) return;
  host.classList.toggle("session-detail-live", sessionIsLive(session));
  if (!session) {
    host.classList.remove("session-detail-live");
    host.dataset.currentSpanId = "";
    host.dataset.liveMode = "";
    if (detail) {
      host.innerHTML = "";
      host.appendChild(emptyBlock("选择一条有效会话后，这里会显示消息、回复、工具调用和阶段时间线。"));
    }
    return;
  }

  const currentSpanId = host.dataset.currentSpanId || "";
  const sameSession = currentSpanId === session.spanId;
  const wasLive = host.dataset.liveMode === "1";
  const isLive = sessionIsLive(session);
  const hasFlow = Boolean(host.querySelector(".session-flow"));
  const hasLiveCard = Boolean(host.querySelector(".session-live-card"));

  if (!sameSession) {
    host.dataset.currentSpanId = session.spanId || "";
  }

  if (isLive) {
    if (!sameSession || !hasLiveCard || wasLive === false) {
      host.dataset.liveMode = "1";
      host.innerHTML = "";
      const journey = document.createElement("section");
      journey.className = "session-journey";
      journey.appendChild(buildSessionOverview(session));
      const liveWrap = document.createElement("section");
      liveWrap.className = "session-live-wrap";
      const liveTitle = document.createElement("h3");
      liveTitle.textContent = "实时状态";
      const liveCard = buildLiveStatusCard(session, insights);
      liveWrap.append(liveTitle, liveCard);
      journey.append(liveWrap);
      host.appendChild(journey);
      return;
    }

    const overview = host.querySelector(".session-overview-card");
    if (overview) overview.replaceWith(buildSessionOverview(session));
    const liveCard = host.querySelector(".session-live-card");
    if (liveCard) patchLiveStatusCard(liveCard, session, insights, null, Boolean(detail));
    return;
  }

  host.dataset.liveMode = "0";

  if (!sameSession || (!hasFlow && !hasLiveCard)) {
    host.innerHTML = "";
    const journey = document.createElement("section");
    journey.className = "session-journey";
    journey.appendChild(buildSessionOverview(session));

    const flowWrap = document.createElement("section");
    flowWrap.className = "session-flow-wrap";
    const flowTitle = document.createElement("h3");
    flowTitle.textContent = "会话进程";
    const flow = document.createElement("div");
    flow.className = "session-flow";
    patchSessionFlow(flow, buildSessionJourney(session, insights), false);
    flowWrap.append(flowTitle, flow);

    journey.append(flowWrap);
    host.appendChild(journey);
    return;
  }

  const animateNew = Boolean(detail);
  const overview = host.querySelector(".session-overview-card");
  if (overview) overview.replaceWith(buildSessionOverview(session));

  if (hasLiveCard) {
    const flowWrap = document.createElement("section");
    flowWrap.className = "session-flow-wrap";
    const flowTitle = document.createElement("h3");
    flowTitle.textContent = "会话进程";
    const flow = document.createElement("div");
    flow.className = "session-flow";
    patchSessionFlow(flow, buildSessionJourney(session, insights), false);
    flowWrap.append(flowTitle, flow);
    const liveWrap = host.querySelector(".session-live-wrap");
    if (liveWrap && liveWrap.parentNode) {
      liveWrap.parentNode.replaceChild(flowWrap, liveWrap);
    }
    return;
  }

  const flow = host.querySelector(".session-flow");
  if (flow) patchSessionFlow(flow, buildSessionJourney(session, insights), animateNew);
}

export function renderRuntimeStats(insights) {
  if (!insights) return;
  const sourceItems = (insights.sourceStats || []).slice(0, 10);
  setText("sessionSourceHint", sourceItems.length ? `${sourceItems.length} 类来源` : "0 类来源");
  renderBarChart("sessionSourceChart", sourceItems);

  const personaItems = (insights.personaStats || []).slice(0, 10);
  setText("personaChartHint", personaItems.length ? `${personaItems.length} 条规则` : "0 条规则");
  renderBarChart("personaChart", personaItems);

  const senderItems = state.privacyMode
    ? [{ label: "隐私模式", value: insights.sessions.length, className: "module-other", detail: "发送者聚合已隐藏", unit: "次" }]
    : (insights.senderStats || []).slice(0, 10);
  setText("senderChartHint", state.privacyMode ? "发送者已隐藏" : `${senderItems.length} 个发送者`);
  renderBarChart("senderChart", senderItems);
}

export function renderLatencyChart(insights) {
  if (!insights) return;
  const latency = insights.latencyStats || {};
  const latencyItems = insights.latencyBuckets || [];
  const avgDuration = latency.measured ? `${(latency.avgDurationMs / 1000).toFixed(1)} 秒` : "--";
  const maxDuration = latency.measured ? `${(latency.maxDurationMs / 1000).toFixed(1)} 秒` : "--";
  const tokenHint = latency.completed ? `总 Token ${formatNumber(latency.totalTokens)} | 输出 ${formatNumber(latency.outputTokens)}` : "无完成会话";
  setText("latencyChartHint", `平均 ${avgDuration} | 最大 ${maxDuration} | ${tokenHint}`);
  renderBarChart("latencyChart", latencyItems);
}

export function setAstrbotNotice(message) {
  const view = $("astrbot");
  if (!view) return;
  let notice = view.querySelector(".astrbot-notice");
  if (!message) {
    if (notice) notice.remove();
    return;
  }
  if (!notice) {
    notice = document.createElement("div");
    notice.className = "astrbot-notice";
    const subtabs = view.querySelector(".subtabs");
    if (subtabs) {
      subtabs.insertAdjacentElement("afterend", notice);
    } else {
      view.insertBefore(notice, view.firstChild);
    }
  }
  notice.textContent = message;
}

function renderSessionVisuals(insights) {
  const selected = renderSessionList(insights);
  renderSessionDetail(selected, insights);
  renderRuntimeStats(insights);
}

export function renderAstrBotVisuals(insights, entries) {
  if (!insights) return;
  const hasVisibleSessions = (insights.sessions?.length || 0) > 0;
  const hasAnyTrace = (insights.allTraceSessions?.length || 0) > 0;
  setAstrbotNotice(
    hasAnyTrace
      ? ""
      : "暂无 Trace 日志数据，无法生成会话、模型与工具洞察。请确认 AstrBot 已开启 trace 日志（data/logs/astrbot.trace.log）。「日志分析」子页仍可基于普通日志展示。",
  );
  if (state.astrbotSubTab === "model") {
    renderLatencyChart(insights);
    renderToolChart(insights);
    return;
  }
  if (state.astrbotSubTab === "logs") {
    renderEventChart(insights);
    renderSourceChart(entries || []);
    return;
  }
  renderSessionVisuals(insights);
  if (!hasVisibleSessions && hasAnyTrace) {
    const detail = $("sessionDetail");
    if (detail && !detail.childElementCount) {
      detail.appendChild(emptyBlock("检测到 trace span，但当前窗口内还没有任何已完成回复的会话。只有真正走到发送回复链路的 span 才会显示。"));
    }
  }
}

export function renderEventChart(insights) {
  const counts = countBy(insights.events, (event) => event.type);
  const items = Object.entries(counts)
    .map(([type, value]) => ({
      label: eventTypeLabel(type),
      value,
      className: type === "error" ? "level-error" : (type === "slow" || type === "warn") ? "level-warn" : "module-trace",
      unit: "条",
    }))
    .sort((a, b) => b.value - a.value);
  const toolCalls = insights.toolCallCount || 0;
  setText("eventChartHint", `${items.length} 类事件 | 工具调用 ${toolCalls} 次`);
  renderBarChart("eventChart", items);
}

export function renderToolChart(insights) {
  const items = insights.toolStats
    .slice()
    .sort((a, b) => b.avgDuration - a.avgDuration || b.maxDuration - a.maxDuration || b.value - a.value)
    .slice(0, 12)
    .map((item) => {
      const avgSeconds = item.completed ? item.avgDuration / 1000 : 0;
      return {
        label: item.label,
        value: Number(avgSeconds.toFixed(1)),
        scaleValue: item.completed ? item.avgDuration : (item.running ? 1000 : 0),
        displayValue: item.completed ? `${avgSeconds.toFixed(1)}s` : "运行中",
        className: item.running ? "module-trace" : "module-plugin",
        detail: `调用 ${item.value} 次 / 完成 ${item.completed} / ${item.detail}`,
        unit: "平均耗时",
      };
    });
  setText("toolChartHint", `${insights.toolStats.length} 个工具`);
  renderBarChart("toolChart", items);
}

export function renderSourceChart(entries) {
  const rows = aggregateModuleGroups(entries);
  const visible = rows.slice(0, MODULE_CHART_LIMIT);
  const rest = rows.slice(MODULE_CHART_LIMIT);
  const items = [...visible];
  if (rest.length) {
    const value = rest.reduce((sum, item) => sum + item.value, 0);
    items.push({
      key: "module:others",
      label: "其他模块",
      value,
      className: "module-other",
      detail: rest.slice(0, 8).map((item) => item.label).join(" / "),
    });
  }
  setText(
    "sourceChartHint",
    rows.length ? `前 ${Math.min(rows.length, MODULE_CHART_LIMIT)} 个 / 共 ${rows.length} 个模块` : "0 个模块",
  );
  renderBarChart("sourceChart", items);
}
