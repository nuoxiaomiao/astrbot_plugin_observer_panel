// ============================================================================
// 视图 - 总览
// ============================================================================

import { state } from "../state.js?v=20260709-stream4";
import { DIAGNOSTIC_LEVELS, IMPORTANT_EVENT_TYPES } from "../config.js?v=20260709-stream4";
import {
  formatPercent,
  formatBytes,
  formatCompactLogTime,
  formatTime,
  shortUptime,
  usageKind,
  diagnosticLabel,
} from "../utils/format.js?v=20260709-stream4";
import {
  $,
  setText,
  setTextAnimated,
  renderSignature,
} from "../utils/dom.js?v=20260709-stream4";
import { compactText, compactJson } from "../utils/log-text.js?v=20260709-stream4";
import { renderEventList } from "../components/event-list.js?v=20260709-stream4";
import { animateFillWidth, shouldAnimate } from "../utils/motion.js?v=20260709-stream4";

const STATUS_CLASS = {
  ok: "is-ok",
  info: "is-ok",
  warn: "is-warn",
  bad: "is-bad",
};

const KIND_LABEL = {
  ok: "正常",
  warn: "偏高",
  bad: "异常",
};

/**
 * 摘要 → 首屏模型（健康 / 资源 / 侧栏状态）
 * 渲染只消费该模型，避免 DOM 层回溯拼业务字段
 */
function buildHeroModel(data) {
  const system = data.system || {};
  const plugin = data.plugin || {};
  const logStats = data.logs || {};
  const astrbotLogs = logStats.astrbot || [];
  const logAnalysis = logStats.analysis || {};
  const logCounts = logAnalysis.counts || {};
  const diagnostics = data.diagnostics || {};
  const memory = system.memory || {};
  const cpu = system.cpu || {};
  const host = system.host || {};
  const disks = system.disks || [];
  const rootDisk = disks[0] || {};
  const issues = Array.isArray(diagnostics.issues) ? diagnostics.issues : [];
  const errorCount = logCounts.error || 0;
  const warnCount = logCounts.warn || 0;
  const readableLogs = astrbotLogs.filter((item) => item.readable).length;

  const status = diagnostics.status || "ok";
  const statusMeta = DIAGNOSTIC_LEVELS[status] || DIAGNOSTIC_LEVELS.ok;
  const primary =
    issues.find((item) => item.level === "bad") ||
    issues.find((item) => item.level === "warn") ||
    issues[0] ||
    null;

  const healthTitle = primary?.title
    || (status === "ok" ? "运行正常" : statusMeta.label || "状态未知");
  const healthDetail = primary?.detail
    || primary?.message
    || (status === "ok"
      ? `诊断 ${diagnostics.issue_count || 0} 项 · 错误日志 ${errorCount}`
      : `共 ${diagnostics.issue_count || issues.length || 0} 项诊断 · 错误 ${errorCount} / 警告 ${warnCount}`);

  const cpuKind = cpu.percent == null ? "ok" : usageKind(cpu.percent);
  const memKind = usageKind(memory.percent);
  const diskKind = usageKind(rootDisk.percent);
  const logKind = errorCount > 0 ? "bad" : warnCount > 0 ? "warn" : "ok";

  const memMeta = memory.used != null && memory.total != null
    ? `${formatBytes(memory.used)} / ${formatBytes(memory.total)}`
    : KIND_LABEL[memKind];
  const diskMeta = rootDisk.mountpoint || rootDisk.mount || rootDisk.path || rootDisk.device || KIND_LABEL[diskKind];

  return {
    stamp: data.now,
    pluginUrl: plugin.url || window.location.href,
    pluginUptime: plugin.uptime_seconds,
    hostUptime: host.uptime_seconds,
    hostName: host.hostname || "--",
    health: {
      status,
      badge: statusMeta.label || "未知",
      title: healthTitle,
      score: diagnostics.score,
      detail: healthDetail,
    },
    gauges: [
      {
        key: "cpu",
        label: "CPU",
        value: cpu.percent ?? 0,
        display: cpu.percent == null ? `${cpu.logical_count || 0} 核` : formatPercent(cpu.percent),
        meta: `${cpu.logical_count || 0} 核`,
        kind: cpuKind,
        fill: cpu.percent != null,
      },
      {
        key: "memory",
        label: "内存",
        value: memory.percent || 0,
        display: formatPercent(memory.percent),
        meta: memMeta,
        kind: memKind,
        fill: true,
      },
      {
        key: "disk",
        label: "根分区",
        value: rootDisk.percent || 0,
        display: rootDisk.percent == null ? "--" : formatPercent(rootDisk.percent),
        meta: diskMeta,
        kind: diskKind,
        fill: rootDisk.percent != null,
      },
      {
        key: "errors",
        label: "错误日志",
        value: errorCount > 0 ? Math.min(100, 20 + errorCount * 12) : 0,
        display: `${errorCount}`,
        meta: errorCount > 0 ? "需关注" : (readableLogs ? `${readableLogs} 个可读文件` : "无错误"),
        kind: logKind,
        fill: true,
      },
    ],
    sidebar: {
      system: STATUS_CLASS[status] || "is-ok",
      cpu: STATUS_CLASS[cpuKind] || "is-ok",
      memory: STATUS_CLASS[memKind] || "is-ok",
      logs: STATUS_CLASS[logKind] || "is-ok",
      systemLabel: diagnosticLabel(status),
      systemMeta: `运行 ${shortUptime(host.uptime_seconds)} | 评分 ${diagnostics.score ?? "--"}`,
      cpuState: cpu.percent == null ? `${cpu.logical_count || 0} 核` : formatPercent(cpu.percent),
      cpuMeta: cpu.model ? compactText(cpu.model, 28) : `${cpu.logical_count || 0} 核`,
      memoryState: formatPercent(memory.percent),
      memoryMeta: KIND_LABEL[memKind] || "正常",
      logsState: `${errorCount} 错误`,
      logsMeta: latestErrorMeta(readableLogs),
    },
  };
}

function latestErrorMeta(readableLogs) {
  const errorEntries = (state.logCache.entries || []).filter(
    (entry) => entry.level === "error" && entry.timestamp,
  );
  if (errorEntries.length) {
    return formatCompactLogTime({
      timestamp: Math.max(...errorEntries.map((entry) => entry.timestamp)),
    });
  }
  return readableLogs ? `${readableLogs} 个日志文件` : "无错误";
}

function setMetricTone(metricKey, toneClass) {
  const el = document.querySelector(`.metric[data-metric="${metricKey}"]`);
  if (!el) return;
  el.classList.remove("is-ok", "is-warn", "is-bad");
  if (toneClass) el.classList.add(toneClass);
}

function renderHealthStrip(health) {
  const strip = $("healthStrip");
  if (!strip) return;

  const tone = STATUS_CLASS[health.status] || "is-ok";
  strip.classList.remove("is-ok", "is-warn", "is-bad");
  strip.classList.add(tone);

  setText("healthBadge", health.badge);
  setText("healthTitle", health.title);
  setText("healthScore", health.score == null ? "评分 --" : `评分 ${health.score}/100`);
  setText("healthDetail", health.detail || "—");
}

function renderResourceGauges(gauges) {
  const host = $("resourceOverview");
  if (!host) return;

  const sig = renderSignature(
    "resourceOverview",
    ["hero-gauges", gauges.map((g) => [g.key, g.display, g.kind, g.meta, Math.round(Number(g.value || 0))])],
  );
  if (!sig) return;

  const existing = new Map();
  sig.querySelectorAll("[data-gauge-key]").forEach((el) => {
    const key = el.dataset.gaugeKey;
    if (key) existing.set(key, el);
  });

  const fragment = document.createDocumentFragment();
  gauges.forEach((g, index) => {
    const key = `gauge:${g.key || g.label}`;
    let item = existing.get(key);
    const isNew = !item;
    if (!item) {
      item = document.createElement("div");
      item.dataset.gaugeKey = key;
      item.innerHTML = `
        <div class="resource-head">
          <span></span>
          <strong class="metric-value"></strong>
        </div>
        <div class="usage-track"><div class="usage-fill"></div></div>
        <small></small>
      `;
      fragment.appendChild(item);
    } else {
      existing.delete(key);
    }

    item.className = `resource-card ${g.kind || "ok"}${isNew ? " animate-in" : ""}`;
    if (isNew && shouldAnimate("enter")) {
      item.style.animationDelay = `${index * 0.06}s`;
    } else {
      item.style.animationDelay = "";
    }

    item.querySelector(".resource-head span").textContent = g.label;
    item.querySelector(".resource-head strong").textContent = g.display ?? "--";
    item.querySelector("small").textContent = g.meta || "";

    const fill = item.querySelector(".usage-fill");
    if (fill) {
      fill.dataset.kind = g.kind || "ok";
      fill.classList.remove("ok", "warn", "bad", "debug");
      if (g.kind && g.kind !== "bad") fill.classList.add(g.kind);
      if (g.fill === false) {
        fill.style.width = "0%";
        fill.classList.remove("is-pulse");
      } else {
        animateFillWidth(fill, g.value, { fromZero: isNew });
      }
    }
  });

  existing.forEach((el) => el.remove());
  sig.appendChild(fragment);
}

function playOverviewEnter() {
  const root = $("overview");
  if (!root || root.dataset.entered === "1") return;
  root.dataset.entered = "1";
  if (!shouldAnimate("enter")) {
    root.classList.add("overview-entered");
    return;
  }
  root.classList.add("overview-entering");
  window.setTimeout(() => {
    root.classList.remove("overview-entering");
    root.classList.add("overview-entered");
  }, 700);
}

function ensureBigScreenPlaceholder() {
  const cards = $("bigScreenCards");
  if (!cards || cards.children.length) return;
  renderBigScreenCards([
    ["活动会话", "--", "等待日志 / trace", "ok"],
    ["运行工具", "--", "等待日志 / trace", "ok"],
    ["慢请求", "--", "等待日志 / trace", "ok"],
    ["错误事件", "--", "等待日志 / trace", "ok"],
    ["最近发送", "--", "等待日志 / trace", "ok"],
  ], { force: true, empty: true });
}

function renderBigScreenCards(cardItems, { force = false, empty = false } = {}) {
  const cards = force
    ? $("bigScreenCards")
    : renderSignature("bigScreenCards", ["big-screen", cardItems]);
  if (!cards) return;

  if (force) {
    try {
      cards.dataset.renderSignature = JSON.stringify(["big-screen", cardItems]);
    } catch {
      cards.dataset.renderSignature = String(cardItems);
    }
  }

  cards.innerHTML = "";
  cards.classList.toggle("is-empty", Boolean(empty));
  const fragment = document.createDocumentFragment();
  const animate = shouldAnimate("enter");
  cardItems.forEach(([title, value, meta, kind], index) => {
    const item = document.createElement("article");
    item.className = `function-card ${kind || ""}${animate ? " animate-in" : ""}`;
    if (animate) item.style.animationDelay = `${index * 0.06}s`;
    const label = document.createElement("span");
    label.textContent = title;
    const number = document.createElement("strong");
    number.className = "metric-value";
    number.textContent = value == null || value === "" ? "--" : String(value);
    const hint = document.createElement("small");
    hint.textContent = meta || "--";
    item.append(label, number, hint);
    fragment.appendChild(item);
  });
  cards.appendChild(fragment);
}

/**
 * 渲染总览页面
 */
export function renderSummary() {
  const data = state.summary;
  if (!data) return;

  state.system = data.system || state.system;
  const model = buildHeroModel(data);
  const side = model.sidebar;

  // 顶部副标题 + 侧栏四卡（任意 tab 都更新，保证首屏权重）
  setText("subtitle", `地址 ${model.pluginUrl} | 已运行 ${shortUptime(model.pluginUptime)}`);
  setText("systemState", side.systemLabel);
  setText("systemMeta", side.systemMeta);
  setTextAnimated("cpuState", side.cpuState, 500);
  setText("cpuMeta", side.cpuMeta);
  setTextAnimated("memoryState", side.memoryState, 500);
  setText("memoryMeta", side.memoryMeta);
  setTextAnimated("logsState", side.logsState, 400);
  setText("logsMeta", side.logsMeta);

  setMetricTone("system", side.system);
  setMetricTone("cpu", side.cpu);
  setMetricTone("memory", side.memory);
  setMetricTone("logs", side.logs);

  if (state.activeTab !== "overview") return;

  setText("heroStamp", formatTime(model.stamp));
  renderHealthStrip(model.health);
  renderResourceGauges(model.gauges);
  ensureBigScreenPlaceholder();
  playOverviewEnter();
}

/**
 * 格式化仪表盘地址
 * @param {object} value - 仪表盘配置对象
 * @returns {string} 格式化后的地址
 */
export function formatDashboard(value) {
  if (!value || typeof value !== "object") return "--";
  const host = value.host || "127.0.0.1";
  const port = value.port || "";
  return port ? `${host}:${port}` : host;
}

export function renderOverviewTrace(insights) {
  if (!insights) {
    ensureBigScreenPlaceholder();
    return;
  }

  setText("bigScreenStamp", formatTime(Date.now()));
  const latestOut = insights.events.find((event) => event.type === "message_out");
  const hasTrace = Boolean(
    insights.sessions?.length
    || insights.events?.length
    || insights.toolCalls?.length,
  );

  const cardItems = [
    ["活动会话", insights.runningSessions.length, `有效会话 ${insights.sessions.length} 条`, insights.runningSessions.length ? "warn" : "ok"],
    ["运行工具", insights.runningTools.length, `总调用 ${insights.toolCalls.length} 次`, insights.runningTools.length ? "warn" : "ok"],
    ["慢请求", insights.slowCount, `${state.ui.slowSessionMs / 1000} 秒会话阈值`, insights.slowCount ? "warn" : "ok"],
    ["错误事件", insights.errorCount, "trace 窗口内", insights.errorCount ? "bad" : "ok"],
    ["最近发送", insights.messageOutCount, latestOut ? formatTime(latestOut.timestamp) : "trace 窗口内", "ok"],
  ];

  if (!hasTrace) {
    renderBigScreenCards([
      ["活动会话", 0, "等待日志 / trace", "ok"],
      ["运行工具", 0, "等待日志 / trace", "ok"],
      ["慢请求", 0, "等待日志 / trace", "ok"],
      ["错误事件", 0, "等待日志 / trace", "ok"],
      ["最近发送", 0, "等待日志 / trace", "ok"],
    ], { empty: false });
  } else {
    renderBigScreenCards(cardItems);
  }

  const important = insights.events.filter((event) => IMPORTANT_EVENT_TYPES.has(event.type));
  const tools = insights.runningTools.map((tool) => ({
    type: "tool_call",
    timestamp: tool.startTs,
    spanId: tool.spanId,
    title: `运行中 ${tool.name}`,
    detail: compactJson(tool.args, 180) || tool.messageOutline || "等待工具返回",
    meta: tool.senderName || "",
    sensitive: true,
    sensitiveMeta: true,
  })).concat(insights.events.filter((event) => event.type === "tool_call" || event.type === "tool_result" || event.type === "slow"));

  setText("overviewEventStamp", `${important.length} 条`);
  setText("overviewToolStamp", `${insights.runningTools.length} 个运行中`);
  renderEventList("overviewEventList", important, 5);
  renderEventList("overviewToolList", tools, 5);
  playOverviewEnter();
}