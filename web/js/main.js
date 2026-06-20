// ============================================================================
// 入口文件
// ============================================================================

console.log("[ObserverPanel] main.js loaded, build 20260620-sessionlive1");

import { state } from "./state.js?v=20260620-sessionlive1";
import { fetchJson, logsApiPath } from "./api.js?v=20260620-sessionlive1";
import { applyPublicConfig, renderWorkspaceChrome, toast } from "./utils/dom.js?v=20260620-sessionlive1";
import { renderSummary } from "./views/overview.js?v=20260620-sessionlive1";
import { renderSystem } from "./views/system.js?v=20260620-sessionlive1";
import { renderAstrBot } from "./views/astrbot.js?v=20260620-sessionlive1";
import { renderLogs } from "./views/logs.js?v=20260620-sessionlive1";
import { bindUI, promptNotificationPermission, closeDetailPanel, selectTimeFilter as uiSelectTimeFilter, toggleEditMode } from "./ui.js?v=20260620-sessionlive1";
import { initEventListActions } from "./components/event-list.js?v=20260620-sessionlive1";
import { initLogListActions, syncLogLevelButtons } from "./components/log-list.js?v=20260620-sessionlive1";

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
  await refresh(false);

  const statusText = document.getElementById("sidebarStatusText");
  if (statusText) {
    statusText.textContent = "文件轮询模式";
  }

  if (state.activeTab === "logs" || state.activeTab === "overview") {
    state.logCache.signature = "";
    renderLogs();
  }

  if (window.location.search.includes("token=")) {
    const cleanUrl = `${window.location.pathname}${window.location.hash}`;
    window.history.replaceState({}, document.title, cleanUrl);
  }

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
});

syncDetailVisibility();
selectAstrBotTab(state.astrbotSubTab);

progressiveLogInit();
promptNotificationPermission();
