// ============================================================================
// 视图 - AstrBot
// ============================================================================

import { state } from "../state.js?v=20260620-sessionlive1";
import { MODULE_CHART_LIMIT } from "../config.js?v=20260620-sessionlive1";
import {
  formatTime,
  formatNumber,
  formatCompactLogTime,
} from "../utils/format.js?v=20260620-sessionlive1";
import {
  $,
  setText,
  emptyBlock,
  privacyText,
  renderSignature,
  badge,
} from "../utils/dom.js?v=20260620-sessionlive1";
import { compactJson, compactText } from "../utils/log-text.js?v=20260620-sessionlive1";
import { renderBarChart } from "../components/chart.js?v=20260620-sessionlive1";
import {
  countBy,
  aggregateModuleGroups,
  eventTypeLabel,
  eventTypeClass,
  sessionSourceLabel,
} from "../log/analytics.js?v=20260620-sessionlive1";

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

function buildSessionStatus(status, session) {
  const wrap = document.createElement("div");
  wrap.className = "session-status-cluster";
  wrap.appendChild(badge(status.label, status.kind));
  if (sessionIsLive(session)) {
    const indicator = document.createElement("span");
    indicator.className = `session-live-indicator ${sessionLiveClass(session)}`;
    indicator.setAttribute("aria-hidden", "true");
    wrap.appendChild(indicator);
  }
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

function sessionListSignature(sessions) {
  return [
    "astrbot-sessions",
    state.selectedSessionId,
    state.privacyMode,
    sessions.map((session) => [
      session.spanId,
      session.lastTs,
      session.displayStatus,
      session.replyKind,
      session.senderName,
      session.messageOutline,
      session.durationMs,
      session.response,
    ]),
  ];
}

function sessionDetailSignature(session) {
  if (!session) return ["astrbot-session-detail", "empty", state.privacyMode];
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
    (session.tools || []).map((tool) => [
      tool.id,
      tool.name,
      tool.status,
      tool.startTs,
      tool.endTs,
      tool.durationMs,
      JSON.stringify(tool.args || {}),
      tool.result || "",
    ]),
    (session.events || []).join(","),
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
  const list = renderSignature("sessionList", sessionListSignature(sessions));
  const selected = ensureSelectedSession(sessions);
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
  list.innerHTML = "";
  if (!sessions.length) {
    list.appendChild(emptyBlock("暂无已进入 Agent 流程的会话。只有真正被唤醒并进入回复链路的 trace 会话才会显示在这里。"));
    return null;
  }
  const fragment = document.createDocumentFragment();
  sessions.forEach((session) => {
    const item = document.createElement("article");
    item.className = "session-card";
    if (session.spanId === state.selectedSessionId) item.classList.add("selected");
    if (sessionIsLive(session)) item.classList.add("is-live", sessionLiveClass(session));
    item.tabIndex = 0;
    item.setAttribute("role", "button");
    item.setAttribute("aria-pressed", session.spanId === state.selectedSessionId ? "true" : "false");
    item.setAttribute("aria-busy", sessionIsLive(session) ? "true" : "false");
    const { label, kind } = sessionStatusMeta(session);

    const head = document.createElement("div");
    head.className = "session-card-head";
    const titleWrap = document.createElement("div");
    titleWrap.className = "session-card-title";
    const sender = document.createElement("strong");
    sender.textContent = state.privacyMode
      ? "隐私模式"
      : compactText(session.senderName || sessionSourceLabel(session) || "未记录发送者", 32);
    const time = document.createElement("small");
    time.textContent = `${formatCompactLogTime({ timestamp: session.lastTs || session.startTs || 0 })} | ${sessionSourceLabel(session)}`;
    titleWrap.append(sender, time);
    head.append(titleWrap, buildSessionStatus({ label, kind }, session));

    const message = document.createElement("p");
    message.className = "session-card-message";
    message.textContent = privacyText(
      compactText(session.messageOutline || "消息内容未记录", 120),
      "隐私模式已隐藏消息内容",
    );

    const footer = document.createElement("div");
    footer.className = "session-card-footer";
    const duration = document.createElement("span");
    duration.textContent = session.durationMs != null ? formatDurationMs(session.durationMs) : "耗时未记录";
    const model = document.createElement("span");
    model.textContent = [session.providerId, session.model].filter(Boolean).join(" / ") || "未记录模型";
    footer.append(duration, model);

    item.append(head, message, footer);
    item.addEventListener("click", () => selectSession(session.spanId));
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectSession(session.spanId);
      }
    });
    fragment.appendChild(item);
  });
  list.appendChild(fragment);
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

function renderSessionDetail(session, insights) {
  const detail = renderSignature("sessionDetail", sessionDetailSignature(session));
  if (!detail) return;
  detail.innerHTML = "";
  detail.classList.toggle("session-detail-live", sessionIsLive(session));
  if (!session) {
    detail.classList.remove("session-detail-live");
    detail.appendChild(emptyBlock("选择一条有效会话后，这里会显示消息、回复、工具调用和阶段时间线。"));
    return;
  }
  const status = sessionStatusMeta(session);
  const liveClass = sessionLiveClass(session);
  const live = sessionIsLive(session);

  const summary = document.createElement("section");
  summary.className = "session-detail-section";
  if (live) summary.classList.add("is-live", liveClass);
  const summaryHead = document.createElement("div");
  summaryHead.className = "session-detail-head";
  const titleWrap = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = state.privacyMode
    ? "已隐藏发送者"
    : (session.senderName || "未记录发送者");
  const subtitle = document.createElement("p");
  subtitle.textContent = sessionSourceLabel(session);
  titleWrap.append(title, subtitle);
  summaryHead.append(titleWrap, buildSessionStatus(status, session));
  const grid = document.createElement("div");
  grid.className = "session-kv-grid";
  grid.append(
    buildDetailKv("开始时间", session.startTs ? formatTime(session.startTs) : "--"),
    buildDetailKv("最近更新", session.lastTs ? formatTime(session.lastTs) : "--"),
    buildDetailKv("来源", session.umo || sessionSourceLabel(session)),
    buildDetailKv("规则", session.personaId || "--"),
    buildDetailKv("模型", [session.providerId, session.model].filter(Boolean).join(" / ") || "--"),
    buildDetailKv("耗时", session.durationMs != null ? formatDurationMs(session.durationMs) : "--"),
    buildDetailKv("首 Token", session.timeToFirstTokenMs != null ? formatDurationMs(session.timeToFirstTokenMs) : "--"),
    buildDetailKv("工具数", formatNumber((session.tools || []).length)),
  );
  summary.append(summaryHead, grid);

  const message = document.createElement("section");
  message.className = "session-detail-section";
  const messageTitle = document.createElement("h3");
  messageTitle.textContent = "触发消息";
  const messageBody = document.createElement("p");
  messageBody.className = "session-detail-text";
  messageBody.textContent = privacyText(
    session.messageOutline || "日志中未记录触发消息内容",
    "隐私模式已隐藏消息内容",
  );
  message.append(messageTitle, messageBody);

  const response = document.createElement("section");
  response.className = "session-detail-section";
  if (live) response.classList.add("is-live", liveClass);
  const responseTitle = document.createElement("h3");
  responseTitle.textContent = session.displayStatus === "empty" ? "最终结果" : "最终回复";
  const responseBody = document.createElement("p");
  responseBody.className = "session-detail-text";
  responseBody.textContent = privacyText(
    session.response || sessionResponsePlaceholder(session),
    session.response ? "隐私模式已隐藏回复内容" : sessionResponsePlaceholder(session),
  );
  response.append(responseTitle, responseBody);

  const token = document.createElement("section");
  token.className = "session-detail-section";
  const tokenTitle = document.createElement("h3");
  tokenTitle.textContent = "Token 统计";
  token.append(tokenTitle, buildTokenSummary(session.tokenUsage));

  const tools = document.createElement("section");
  tools.className = "session-detail-section";
  const toolsTitle = document.createElement("h3");
  toolsTitle.textContent = "工具调用";
  tools.append(toolsTitle, buildToolList(session));

  const timeline = document.createElement("section");
  timeline.className = "session-detail-section";
  const timelineTitle = document.createElement("h3");
  timelineTitle.textContent = "阶段时间线";
  timeline.append(timelineTitle, buildEventTimeline(session, insights));

  detail.append(summary, message, response, token, tools, timeline);
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
