// ============================================================================
// 视图 - 总览
// ============================================================================

import { state } from "../state.js?v=20260708-telemetry1";
import { DIAGNOSTIC_LEVELS, IMPORTANT_EVENT_TYPES } from "../config.js?v=20260708-telemetry1";
import { formatPercent, formatCompactLogTime, formatTime, shortUptime, usageKind } from "../utils/format.js?v=20260708-telemetry1";
import {
  $,
  setText,
  setTextAnimated,
  renderSignature,
  renderKv,
} from "../utils/dom.js?v=20260708-telemetry1";
import { compactText, compactJson } from "../utils/log-text.js?v=20260708-telemetry1";
import { renderBarChart } from "../components/chart.js?v=20260708-telemetry1";
import { renderEventList } from "../components/event-list.js?v=20260708-telemetry1";
import { checkDiagnosticNotifications } from "../ui.js?v=20260708-telemetry1";

function diagnosticLabel(status) {
  return DIAGNOSTIC_LEVELS[status]?.label || "未知";
}

/**
 * 渲染总览页面
 */
export function renderSummary() {
  const data = state.summary;
  if (!data) return;

  const astrbot = data.astrbot || {};
  const system = data.system || {};
  const plugin = data.plugin || {};
  const logStats = data.logs || {};
  const astrbotLogs = logStats.astrbot || [];
  const logAnalysis = logStats.analysis || {};
  const logCounts = logAnalysis.counts || {};
  const diagnostics = data.diagnostics || {};
  const readableLogs = astrbotLogs.filter((item) => item.readable).length;
  const memory = system.memory || {};
  const cpu = system.cpu || {};
  const host = system.host || {};
  const disks = system.disks || [];
  const rootDisk = disks[0] || {};
  state.system = system;

  // 更新顶部状态卡片
  setText("subtitle", `地址 ${plugin.url || window.location.href} | 已运行 ${shortUptime(plugin.uptime_seconds)}`);
  setText("systemState", diagnosticLabel(diagnostics.status));
  setText("systemMeta", `运行 ${shortUptime(host.uptime_seconds)} | 评分 ${diagnostics.score ?? "--"}`);
  setTextAnimated("cpuState", cpu.percent == null ? `${cpu.logical_count || 0} 核` : formatPercent(cpu.percent), 500);
  setText("cpuMeta", cpu.model ? compactText(cpu.model, 28) : `${cpu.logical_count || 0} 核`);
  setTextAnimated("memoryState", formatPercent(memory.percent), 500);
  setText("memoryMeta", usageKind(memory.percent) === "ok" ? "正常" : usageKind(memory.percent) === "warn" ? "偏高" : "紧张");

  // 日志：仅显示错误数量和最近错误时间
  const errorCount = logCounts.error || 0;
  setTextAnimated("logsState", `${errorCount} 错误`, 400);
  const errorEntries = (state.logCache.entries || []).filter((entry) => entry.level === "error" && entry.timestamp);
  const latestError = errorEntries.length
    ? `${formatCompactLogTime({ timestamp: Math.max(...errorEntries.map((e) => e.timestamp)) })}`
    : (readableLogs ? `${readableLogs} 个日志文件` : "无错误");
  setText("logsMeta", latestError);

  if (state.activeTab !== "overview") {
    return;
  }

  setText("runtimeStamp", formatTime(data.now));
  setText("hostStamp", host.hostname || "--");

  // 渲染资源阈值诊断卡片（精简：只看 OK/WARN/BAD 状态，不展示原始数值）
  const resource = $("resourceOverview");
  const gauges = [
    { label: "CPU", value: cpu.percent ?? 0, meta: `${cpu.logical_count || 0} 核` },
    { label: "内存", value: memory.percent || 0, meta: "" },
    { label: "根分区", value: rootDisk.percent || 0, meta: "" },
  ];
  const resSig = renderSignature("resourceOverview", ["threshold", gauges.map((g) => [g.label, g.value])]);
  if (resSig) {
    // ★ 增量更新：复用已有元素，而非 resSig.innerHTML = ""
    const existing = new Map();
    resSig.querySelectorAll('[data-gauge-key]').forEach((el) => {
      const k = el.dataset.gaugeKey;
      if (k) existing.set(k, el);
    });
    const fragment = document.createDocumentFragment();
    gauges.forEach((g) => {
      const key = `gauge:${g.label}`;
      let item = existing.get(key);
      const kind = usageKind(g.value);
      if (!item) {
        item = document.createElement("div");
        item.dataset.gaugeKey = key;
        item.className = `resource-card ${kind}`;
        item.innerHTML = `
          <div class="resource-head">
            <span></span>
            <strong></strong>
          </div>
          <div class="usage-track"><div class="usage-fill"></div></div>
          <small></small>
        `;
        fragment.appendChild(item);
      } else {
        existing.delete(key);
        item.className = `resource-card ${kind}`;
      }
      // 更新内容
      item.querySelector('.resource-head span').textContent = g.label;
      item.querySelector('.resource-head strong').textContent = kind === "ok" ? "正常" : kind === "warn" ? "偏高" : "异常";
      item.querySelector('.usage-fill').style.width = `${Math.max(0, Math.min(100, Number(g.value || 0)))}%`;
      item.querySelector('small').textContent = g.meta || "";
    });
    // 移除多余旧节点
    existing.forEach((el) => el.remove());
    // 追加新节点
    resSig.appendChild(fragment);
  }

  // 渲染运行状态列表（精简：移除观察面板/访问地址/日志文件等冗余项）
  renderKv("runtimeList", {
    系统运行时间: shortUptime(host.uptime_seconds),
    平台数量: astrbot.platforms_total || 0,
    健康评分: diagnostics.score == null ? "--" : `${diagnostics.score}/100`,
    诊断项: diagnostics.issue_count || 0,
    日志可读: `${readableLogs} 个文件`,
  });

  // 异常诊断触发浏览器通知（2.5）
  checkDiagnosticNotifications(diagnostics);
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
  if (!insights) return;
  setText("bigScreenStamp", formatTime(Date.now()));
  const latestOut = insights.events.find((event) => event.type === "message_out");
  const cardItems = [
    ["活动会话", insights.runningSessions.length, `有效会话 ${insights.sessions.length} 条`, insights.runningSessions.length ? "warn" : "ok"],
    ["运行工具", insights.runningTools.length, `总调用 ${insights.toolCalls.length} 次`, insights.runningTools.length ? "warn" : "ok"],
    ["慢请求", insights.slowCount, `${state.ui.slowSessionMs / 1000} 秒会话阈值`, insights.slowCount ? "warn" : "ok"],
    ["错误事件", insights.errorCount, "trace 窗口内", insights.errorCount ? "bad" : "ok"],
    ["最近发送", insights.messageOutCount, latestOut ? formatTime(latestOut.timestamp) : "trace 窗口内", "ok"],
  ];
  const cards = renderSignature("bigScreenCards", ["big-screen", cardItems]);
  if (cards) {
    cards.innerHTML = "";
    const fragment = document.createDocumentFragment();
    cardItems.forEach(([title, value, meta, kind], index) => {
      // functionCard 在 astrbot view 中定义，这里内联实现以简化依赖
      const item = document.createElement("article");
      item.className = `function-card ${kind || ""} animate-in`;
      item.style.animationDelay = `${index * 0.06}s`;
      const label = document.createElement("span");
      label.textContent = title;
      const number = document.createElement("strong");
      number.textContent = value == null || value === "" ? "--" : String(value);
      const hint = document.createElement("small");
      hint.textContent = meta || "--";
      item.append(label, number, hint);
      fragment.appendChild(item);
    });
    cards.appendChild(fragment);
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
}
