// ============================================================================
// 入口文件
// ============================================================================

console.log("[ObserverPanel] main.js loaded, build 20260620-renderfix1");

import { state } from "./state.js?v=20260620-renderfix1";
import { fetchJson, logsApiPath } from "./api.js?v=20260620-renderfix1";
import { applyPublicConfig, renderWorkspaceChrome, toast } from "./utils/dom.js?v=20260620-renderfix1";
import { renderSummary } from "./views/overview.js?v=20260620-renderfix1";
import { renderSystem } from "./views/system.js?v=20260620-renderfix1";
import { renderAstrBot } from "./views/astrbot.js?v=20260620-renderfix1";
import { renderLogs } from "./views/logs.js?v=20260620-renderfix1";
import { bindUI, promptNotificationPermission, closeDetailPanel, selectTimeFilter as uiSelectTimeFilter, toggleEditMode } from "./ui.js?v=20260620-renderfix1";
import { connectSSE, resetSSEBackoff, updateSSEStatus } from "./sse.js?v=20260620-renderfix1";
import { initEventListActions } from "./components/event-list.js?v=20260620-renderfix1";
import { initLogListActions, syncLogLevelButtons } from "./components/log-list.js?v=20260620-renderfix1";

function logTailLimit() {
  return Math.max(20, Number(state.config?.astrbot?.tail_lines || 300));
}

function mergeLogFile(existing, incoming) {
  const current = existing || {};
  const incomingLines = Array.isArray(incoming.lines) ? incoming.lines : [];
  if (!current.path || incoming.reset || !Array.isArray(current.lines) || !current.readable || !incoming.readable) {
    return {
      ...current,
      ...incoming,
      lines: incomingLines.slice(-logTailLimit()),
      base_line: Number(incoming.base_line || 0),
      line_count: Number(incoming.line_count || incomingLines.length || 0),
    };
  }

  const mergedLines = current.lines.concat(incomingLines);
  const lineCount = Number(incoming.line_count || current.line_count || 0);
  const overflow = Math.max(0, mergedLines.length - logTailLimit());
  const lines = mergedLines.slice(overflow);
  const baseLine = Math.max(Number(current.base_line || 0) + overflow, lineCount - lines.length, 0);
  return {
    ...current,
    ...incoming,
    lines,
    base_line: baseLine,
    line_count: lineCount || (baseLine + lines.length),
  };
}

function mergeLogData(incoming) {
  const current = state.logs || {};
  const incomingAstrbot = incoming?.astrbot;
  // 安全兜底：如果后端未返回 astrbot 文件数组，不要清空已有日志（SSE 模式可能只返回 live）
  if (!Array.isArray(incomingAstrbot)) {
    state.logs = { ...current, ...incoming };
    return;
  }
  const byPath = new Map((current.astrbot || []).map((file) => [file.path, file]));
  const nextAstrBot = incomingAstrbot.map((file) => mergeLogFile(byPath.get(file.path), file));
  state.logs = {
    ...current,
    ...incoming,
    astrbot: nextAstrBot,
  };
}

let refreshRetryCount = 0;
const MAX_REFRESH_RETRIES = 3;

async function refresh(activeOnly = false) {
  if (state.refreshing) {
    state.pendingRefresh = true;
    return;
  }
  state.refreshing = true;
  state.lastRefreshTime = Date.now();
  try {
    if (!state.config) {
      const cfg = await fetchJson("/api/config");
      state.config = cfg.data;
      applyPublicConfig(state.config);
      refreshRetryCount = 0;
    }

    const summary = await fetchJson("/api/summary");
    state.summary = summary.data;
    renderSummary();

    if (!activeOnly || state.activeTab === "system") {
      const system = await fetchJson("/api/system?compact=1");
      state.system = system.data;
      renderSystem();
    }

    if (!activeOnly || ["overview", "astrbot", "logs"].includes(state.activeTab)) {
      const logs = await fetchJson(logsApiPath());
      mergeLogData(logs.data);
      renderLogs();
    }
    refreshRetryCount = 0;
  } catch (err) {
    refreshRetryCount++;
    const msg = err.message || String(err);
    if (refreshRetryCount <= MAX_REFRESH_RETRIES) {
      console.warn(`[ObserverPanel] 刷新失败 (${refreshRetryCount}/${MAX_REFRESH_RETRIES}): ${msg}`);
    } else {
      toast(`数据刷新失败: ${msg}`);
    }
  } finally {
    state.refreshing = false;
    if (state.pendingRefresh) {
      state.pendingRefresh = false;
      window.setTimeout(() => refresh(true), 0);
    }
  }
}

function syncDetailVisibility() {
  // 仅日志页需要右侧详情面板；其他页收起以腾出空间（问题2）
  document.body.classList.toggle("detail-hidden", state.activeTab !== "logs");
}

function selectTab(name) {
  state.activeTab = name;
  document.body.classList.remove("sidebar-open");
  document.querySelectorAll(".tab").forEach((tab) => {
    const active = tab.dataset.tab === name;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  });
  document.querySelectorAll(".view").forEach((view) => {
    const active = view.id === name;
    view.classList.toggle("active", active);
    view.hidden = !active;
  });
  syncDetailVisibility();
  renderWorkspaceChrome();
  refresh(true);
}

function selectAstrBotTab(name) {
  state.astrbotSubTab = name || "sessions";
  const viewIds = {
    sessions: "astrbotSessions",
    model: "astrbotModel",
    logs: "astrbotLogs",
  };
  document.querySelectorAll(".subtab").forEach((tab) => {
    const active = tab.dataset.astrbotTab === state.astrbotSubTab;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  });
  Object.entries(viewIds).forEach(([key, id]) => {
    const view = document.getElementById(id);
    if (!view) return;
    const active = key === state.astrbotSubTab;
    view.classList.toggle("active", active);
    view.hidden = !active;
  });
  renderAstrBot();
}

function selectLogLevel(level) {
  state.logLevel = level;
  state.logPage = 1;
  syncLogLevelButtons();
  renderLogs();
}

function selectEventType(type) {
  state.eventType = type;
  document.querySelectorAll(".event-filter").forEach((button) => {
    button.classList.toggle("active", button.dataset.event === type);
  });
  renderLogs();
}

function selectTimeFilter(time) {
  uiSelectTimeFilter(time, renderLogs);
}

function changeLogPage(delta) {
  state.logPage = Math.max(1, state.logPage + delta);
  renderLogs();
}

function schedule() {
  window.clearInterval(state.timer);
  const autoRefresh = document.getElementById("autoRefresh");
  if (autoRefresh && autoRefresh.checked) {
    state.timer = window.setInterval(() => refresh(true), state.refreshMs);
  }
}

async function progressiveLogInit() {
  // 第一步：快速加载配置和基础信息（包含一次文件日志刷新）
  await refresh(false);

  // 第二步：确保 state.logs.astrbot 有文件日志数据。
  // 当 SSE 启用时，refresh(false) 返回的是 data.live，没有 astrbot 文件数组；
  // 此时需要额外请求 force_file=1 的文件日志，并通过 mergeLogData 合并，避免覆盖已有内容。
  try {
    updateSSEStatus?.(state.config?.log_stream_enabled ? "connecting" : "unavailable");
    const statusText = document.getElementById("sidebarStatusText");
    if (statusText) {
      statusText.textContent = "正在加载历史日志...";
    }

    const hasFileLogs = (state.logs?.astrbot || []).some((file) => Array.isArray(file.lines) && file.lines.length);
    if (!hasFileLogs) {
      const logsResponse = await fetchJson(logsApiPath(true));
      if (logsResponse.ok && logsResponse.data) {
        mergeLogData(logsResponse.data);
      }
    }

    // sseEntries 只承载真正的实时 SSE 消息（handleSSELogEntry 追加）。
    // 历史上下文由文件条目本身（state.logs.astrbot）提供，这里不再把文件行
    // 二次拷贝进 sseEntries，否则 buildLogEntries 会同时拼接两者导致每行显示两遍。
    state.logCache.sseEntries = [];

    if (statusText) {
      statusText.textContent = "历史日志已就绪";
    }
  } catch (err) {
    console.warn("[ObserverPanel] 加载历史日志失败:", err);
  }

  // 立即渲染历史日志（如果当前在日志/总览页）
  if (state.activeTab === "logs" || state.activeTab === "overview") {
    state.logCache.signature = "";
    renderLogs();
  }

  // 第三步：如果启用了日志流，连接 SSE 实时流
  if (state.config?.log_stream_enabled) {
    await new Promise((resolve) => window.setTimeout(resolve, 300));
    connectSSE();

    // 第四步：再次刷新以获取最新的日志分析数据
    window.setTimeout(() => {
      refresh(false);
    }, 1000);
  }

  // 启动定时刷新
  schedule();
}

// 初始化跨组件动作引用，避免循环依赖
initEventListActions({ renderLogs });
initLogListActions({
  selectTab,
  syncDetailVisibility,
  renderWorkspaceChrome,
  renderLogs,
});

bindUI({
  selectTab,
  selectAstrBotTab,
  selectLogLevel,
  selectEventType,
  selectTimeFilter,
  changeLogPage,
  refresh,
  schedule,
  renderLogs,
  closeDetailPanel,
  toggleEditMode,
  resetSSEBackoff,
  connectSSE,
});

syncDetailVisibility();
selectAstrBotTab(state.astrbotSubTab);

progressiveLogInit();
promptNotificationPermission();

// 切回可见时：如果 SSE 应该启用但实际未连接，则尝试重连。
// 切到后台时不再主动断开连接，避免「一切换标签就断流」的体验问题。
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.config?.log_stream_enabled && !state.sseEventSource) {
    resetSSEBackoff();
    connectSSE();
  }
});
