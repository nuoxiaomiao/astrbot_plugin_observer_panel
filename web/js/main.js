// ============================================================================
// 入口文件
// ============================================================================

console.log("[ObserverPanel] main.js loaded, build 20260627-calm1");

import { state } from "./state.js?v=20260627-calm1";
import { fetchJson, logsApiPath, fetchQueue } from "./api.js?v=20260627-calm1";
import { applyPublicConfig, renderWorkspaceChrome, toast } from "./utils/dom.js?v=20260627-calm1";
import { renderSummary } from "./views/overview.js?v=20260627-calm1";
import { renderSystem } from "./views/system.js?v=20260627-calm1";
import { renderAstrBot } from "./views/astrbot.js?v=20260627-calm1";
import { renderLogs } from "./views/logs.js?v=20260627-calm1";
import { bindUI, promptNotificationPermission, closeDetailPanel, selectTimeFilter as uiSelectTimeFilter, toggleEditMode, addLoadingState, removeLoadingState } from "./ui.js?v=20260627-calm1";
import { initEventListActions } from "./components/event-list.js?v=20260627-calm1";
import { initLogListActions, syncLogLevelButtons } from "./components/log-list.js?v=20260627-calm1";
import { transitionViews } from "./utils/motion.js?v=20260627-calm1";

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

// 指数退避重试函数
async function retryWithBackoff(fn, maxRetries = 3) {
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i < maxRetries - 1) {
        // 指数退避：第1次500ms，第2次1s，第3次2s
        const delayMs = 500 * Math.pow(2, i);
        console.warn(`[ObserverPanel] 第 ${i + 1} 次重试失败，${delayMs}ms 后重试: ${err.message}`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

async function refresh(activeOnly = false) {
  if (state.refreshing) {
    state.pendingRefresh = true;
    return;
  }

  state.refreshing = true;
  state.lastRefreshTime = Date.now();
  state.refreshError = null;  // 清除上次错误

  // 为关键区域添加骨架屏
  if (!activeOnly) {
    const bigScreenCards = document.getElementById("bigScreenCards");
    const systemInfo = document.getElementById("systemInfo");
    const processInfo = document.getElementById("processInfo");
    const logList = document.getElementById("logList");

    if (bigScreenCards) addLoadingState(bigScreenCards, "skeleton");
    if (systemInfo) addLoadingState(systemInfo, "skeleton");
    if (processInfo) addLoadingState(processInfo, "skeleton");
    if (logList) addLoadingState(logList, "skeleton");
  }

  try {
    if (!state.config) {
      const cfg = await retryWithBackoff(() =>
        fetchQueue.execute(() => fetchJson("/api/config"))
      );
      state.config = cfg.data;
      applyPublicConfig(state.config);
    }

    // 使用受控队列 + 串行 + 容错：单个接口失败不影响其他
    let summaryRes, systemRes, logsRes;

    // 获取摘要数据（必需）
    try {
      summaryRes = await retryWithBackoff(() =>
        fetchQueue.execute(() => fetchJson("/api/summary"))
      );
      state.summary = summaryRes.data;
      renderSummary();
    } catch (err) {
      console.error("[ObserverPanel] summary 接口失败", err);
      state.refreshError = `摘要数据加载失败: ${err.message}`;
      toast(`摘要数据加载失败: ${err.message}`);
    }

    // 获取系统数据（可选）
    if (!activeOnly || state.activeTab === "system") {
      try {
        systemRes = await retryWithBackoff(() =>
          fetchQueue.execute(() => fetchJson("/api/system?compact=1"))
        );
        state.system = systemRes.data;
        renderSystem();
      } catch (err) {
        console.error("[ObserverPanel] system 接口失败", err);
        if (!activeOnly) {
          toast(`系统数据加载失败: ${err.message}`);
        }
      }
    }

    // 获取日志数据（可选）
    if (!activeOnly || ["overview", "astrbot", "logs"].includes(state.activeTab)) {
      try {
        logsRes = await retryWithBackoff(() =>
          fetchQueue.execute(() => fetchJson(logsApiPath()))
        );
        mergeLogData(logsRes.data);
        renderLogs();
      } catch (err) {
        console.error("[ObserverPanel] logs 接口失败", err);
        if (!activeOnly) {
          toast(`日志数据加载失败: ${err.message}`);
        }
      }
    }
  } catch (err) {
    const msg = err.message || String(err);
    state.refreshError = msg;
    console.error(`[ObserverPanel] 刷新严重失败: ${msg}`);
    toast(`数据刷新失败: ${msg}`);
  } finally {
    state.refreshing = false;

    // 移除骨架屏
    if (!activeOnly) {
      const bigScreenCards = document.getElementById("bigScreenCards");
      const systemInfo = document.getElementById("systemInfo");
      const processInfo = document.getElementById("processInfo");
      const logList = document.getElementById("logList");

      if (bigScreenCards) removeLoadingState(bigScreenCards);
      if (systemInfo) removeLoadingState(systemInfo);
      if (processInfo) removeLoadingState(processInfo);
      if (logList) removeLoadingState(logList);
    }

    if (state.pendingRefresh) {
      state.pendingRefresh = false;
      window.setTimeout(() => refresh(true), 500);  // 延迟 500ms 避免立即重复
    }
  }
}

function syncDetailVisibility() {
  // 仅日志页需要右侧详情面板；其他页收起以腾出空间（问题2）
  document.body.classList.toggle("detail-hidden", state.activeTab !== "logs");
}

function applyMainViewState(name) {
  document.querySelectorAll(".view").forEach((view) => {
    const active = view.id === name;
    view.classList.toggle("active", active);
    view.hidden = !active;
  });
}

function selectTab(name) {
  state.activeTab = name;
  document.body.classList.remove("sidebar-open");

  document.querySelectorAll(".tab").forEach((tab) => {
    const active = tab.dataset.tab === name;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  });

  const oldView = document.querySelector(".view.active");
  const newView = document.getElementById(name);

  transitionViews(oldView, newView, {
    activate: () => applyMainViewState(name),
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

  const oldView = document.querySelector(".astrbot-subview.active");
  const newView = document.getElementById(viewIds[state.astrbotSubTab]);

  transitionViews(oldView, newView, {
    activate: () => {
      Object.entries(viewIds).forEach(([key, id]) => {
        const view = document.getElementById(id);
        if (!view) return;
        const active = key === state.astrbotSubTab;
        view.classList.toggle("active", active);
        view.hidden = !active;
      });
    },
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
