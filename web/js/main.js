// ============================================================================
// 入口文件
// ============================================================================

console.log("[ObserverPanel] main.js loaded, build 20260709-stream4");

import { state } from "./state.js?v=20260709-stream4";
import { fetchJson, logsApiPath, fetchQueue } from "./api.js?v=20260709-stream4";
import { applyPublicConfig, renderWorkspaceChrome, toast, $ } from "./utils/dom.js?v=20260709-stream4";
import { renderSummary } from "./views/overview.js?v=20260709-stream4";
import { renderSystem } from "./views/system.js?v=20260709-stream4";
import { renderAstrBot } from "./views/astrbot.js?v=20260709-stream4";
import { renderLogs } from "./views/logs.js?v=20260709-stream4";
import { bindUI, closeDetailPanel, selectTimeFilter as uiSelectTimeFilter, toggleEditMode, addLoadingState, removeLoadingState } from "./ui.js?v=20260709-stream4";
import { initEventListActions } from "./components/event-list.js?v=20260709-stream4";
import { initLogListActions, syncLogLevelButtons } from "./components/log-list.js?v=20260709-stream4";
import { transitionViews, shouldAnimate } from "./utils/motion.js?v=20260709-stream4";
import {
  bindAuthHooks,
  bindAuthUi,
  bootstrapAuth,
  hideAuthGate,
  isAuthGateVisible,
} from "./auth.js?v=20260709-stream4";
import { clearAuthToken } from "./config.js?v=20260709-stream4";
import {
  startLogStream,
  stopLogStream,
  isLogStreamBusy,
  logStreamStatusLabel,
} from "./log/stream.js?v=20260709-stream4";

const FAST_LOG_REFRESH_MS = 1000;

function logTailLimit() {
  // 与后端 astrbot.tail_lines 默认对齐；过小会把 plain reasoning dump 裁掉
  return Math.max(20, Number(state.config?.astrbot?.tail_lines || 1200));
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

function mergeLogData(incoming, { replaceAll = false } = {}) {
  const current = state.logs || {};
  const incomingAstrbot = incoming?.astrbot;
  if (!Array.isArray(incomingAstrbot)) {
    state.logs = { ...current, ...incoming };
    return;
  }

  // 增量 SSE 可能只带变更文件：按 path 合并，保留未出现的现有文件
  const byPath = new Map((current.astrbot || []).map((file) => [file.path, file]));
  for (const file of incomingAstrbot) {
    if (!file?.path) continue;
    byPath.set(file.path, mergeLogFile(byPath.get(file.path), file));
  }

  let nextAstrBot;
  if (replaceAll) {
    // snapshot：以服务端列表顺序为准，仍合并内容
    const seen = new Set();
    nextAstrBot = [];
    for (const file of incomingAstrbot) {
      if (!file?.path || seen.has(file.path)) continue;
      seen.add(file.path);
      nextAstrBot.push(byPath.get(file.path) || file);
    }
  } else {
    nextAstrBot = Array.from(byPath.values());
  }

  state.logs = {
    ...current,
    ...incoming,
    astrbot: nextAstrBot,
  };
}

function updateLogModeUi() {
  const label = logStreamStatusLabel();
  const modeEl = document.getElementById("logModeStatusText");
  if (modeEl) modeEl.textContent = label;
  const modeRoot = document.querySelector(".log-mode-status");
  const streamStatus = state.logStream?.status || "idle";
  if (modeRoot) {
    modeRoot.dataset.status = streamStatus;
  }

  // 左侧原位置统一展示流/文件模式状态，避免被「在线 · 时间」冲掉
  const statusText = document.getElementById("sidebarStatusText");
  if (statusText) {
    statusText.textContent = label;
  }
  const statusRoot = document.querySelector(".sidebar-status");
  if (statusRoot) {
    statusRoot.dataset.logStreamStatus = streamStatus;
  }
}

function shouldSkipHttpLogFetch() {
  // connecting 阶段 SSE 已发起，避免与 HTTP 并发 merge
  return isLogStreamBusy();
}

function clearLogStreamConnectTimer() {
  const timer = state.logStream?.connectTimer;
  if (timer != null) {
    window.clearTimeout(timer);
    state.logStream.connectTimer = null;
  }
}

function isLogStreamDisabledByConfig() {
  if (state.config && state.config.log_stream_enabled === false) return true;
  if (state.config?.log_stream && state.config.log_stream.enabled === false) return true;
  return false;
}

/**
 * 统一入口：断流 →（可选强制）文件基线 → pending 倒计时 → 增量 SSE
 * 首屏与主 Tab 切页共用，避免两套状态机。
 */
function rearmFileBaselineThenStream({ forceFileRefresh = false } = {}) {
  clearLogStreamConnectTimer();
  // 先停 SSE，保证 shouldSkipHttpLogFetch() 为 false，后续 HTTP logs 可打通
  stopLogStream();

  if (isLogStreamDisabledByConfig()) {
    state.logStream.status = "disabled";
    state.logStream.detail = "";
    updateLogModeUi();
    if (forceFileRefresh) {
      refresh(true, { forceLogs: true });
    }
    schedule();
    return;
  }

  const delayMs = Math.max(1000, Number(state.refreshMs) || 5000);
  const delaySec = Math.round(delayMs / 1000);
  state.logStream.status = "pending";
  state.logStream.detail = forceFileRefresh
    ? `文件读取 · ${delaySec}s 后实时流`
    : `文件基线 · ${delaySec}s 后接入实时流`;
  updateLogModeUi();

  // 5s 窗口内继续 HTTP 轮询；SSE 已停，不会被 skip
  schedule();
  if (forceFileRefresh) {
    refresh(true, { forceLogs: true });
  }

  state.logStream.connectTimer = window.setTimeout(() => {
    state.logStream.connectTimer = null;
    if (isAuthGateVisible()) return;
    if (isLogStreamDisabledByConfig()) {
      state.logStream.status = "disabled";
      updateLogModeUi();
      return;
    }
    startLogStream({
      snapshot: false,
      onPayload: onLogStreamPayload,
      onStatusChange: onLogStreamStatusChange,
    });
    updateLogModeUi();
  }, delayMs);
}

/** @deprecated 使用 rearmFileBaselineThenStream */
function scheduleLogStreamConnect() {
  rearmFileBaselineThenStream({ forceFileRefresh: false });
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

async function refresh(activeOnly = false, options = {}) {
  const forceLogs = Boolean(options.forceLogs);
  if (isAuthGateVisible()) {
    state.pendingRefresh = false;
    return;
  }
  if (state.refreshing) {
    state.pendingRefresh = true;
    // 被合并进下一次时，若本次要求强制拉 logs，记到 state，finally 后补拉
    if (forceLogs) state.pendingForceLogs = true;
    return;
  }

  state.refreshing = true;
  state.lastRefreshTime = Date.now();
  state.refreshError = null;  // 清除上次错误
  const wantForceLogs = forceLogs || Boolean(state.pendingForceLogs);
  state.pendingForceLogs = false;

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

    // 获取日志数据（可选）；SSE 已连接时跳过 HTTP 日志，除非 forceLogs / pending 窗口
    const needLogs = wantForceLogs
      || !activeOnly
      || ["overview", "astrbot", "logs"].includes(state.activeTab);
    if (needLogs) {
      if (!wantForceLogs && shouldSkipHttpLogFetch()) {
        state.pendingLogRefresh = false;
      } else if (state.logRefreshing) {
        state.pendingLogRefresh = true;
      } else {
        try {
          logsRes = await retryWithBackoff(() =>
            fetchQueue.execute(() => fetchJson(logsApiPath()))
          );
          mergeLogData(logsRes.data, { replaceAll: true });
          renderLogs();
        } catch (err) {
          console.error("[ObserverPanel] logs 接口失败", err);
          if (!activeOnly) {
            toast(`日志数据加载失败: ${err.message}`);
          }
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
      const nextForceLogs = Boolean(state.pendingForceLogs);
      state.pendingRefresh = false;
      window.setTimeout(() => refresh(true, { forceLogs: nextForceLogs }), 500);
    }

    flushPendingLogRefresh();
  }
}

function autoRefreshEnabled() {
  const autoRefresh = document.getElementById("autoRefresh");
  return Boolean(autoRefresh && autoRefresh.checked);
}

function shouldFastRefreshLogs() {
  // SSE 在线时禁止 1s 日志 HTTP 快刷
  if (shouldSkipHttpLogFetch()) return false;
  return autoRefreshEnabled()
    && state.activeTab === "astrbot"
    && state.astrbotSubTab === "sessions";
}

function flushPendingLogRefresh() {
  if (!state.pendingLogRefresh) return;
  state.pendingLogRefresh = false;
  if (!shouldFastRefreshLogs()) return;
  window.setTimeout(() => refreshLogsOnly(), 100);
}

async function refreshLogsOnly() {
  if (!shouldFastRefreshLogs()) {
    state.pendingLogRefresh = false;
    return;
  }
  if (state.refreshing || state.logRefreshing) {
    state.pendingLogRefresh = true;
    return;
  }

  state.logRefreshing = true;
  state.lastRefreshTime = Date.now();

  try {
    const logsRes = await retryWithBackoff(() =>
      fetchQueue.execute(() => fetchJson(logsApiPath()))
    );
    mergeLogData(logsRes.data);
    renderLogs();
  } catch (err) {
    console.error("[ObserverPanel] fast logs 接口失败", err);
  } finally {
    state.logRefreshing = false;
    flushPendingLogRefresh();
  }
}

function syncDetailVisibility() {
  // 仅日志页需要右侧详情面板；其他页收起以腾出空间
  const isLogs = state.activeTab === "logs";
  document.body.classList.toggle("detail-hidden", !isLogs);
  // 离开日志页时清理可能残留的抽屉 class（历史/兼容）
  if (!isLogs) {
    document.querySelector(".workspace-detail")?.classList.remove("open");
    document.body.classList.remove("detail-open");
  }
}

function applyMainViewState(name) {
  document.querySelectorAll(".view").forEach((view) => {
    const active = view.id === name;
    view.classList.toggle("active", active);
    view.hidden = !active;
  });
}

function selectTab(name, options = {}) {
  const prevTab = state.activeTab;
  const tabChanged = name !== prevTab;
  state.activeTab = name;
  document.body.classList.remove("sidebar-open");

  document.querySelectorAll(".tab").forEach((tab) => {
    const active = tab.dataset.tab === name;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  });

  const oldView = document.querySelector(".view.active");
  const newView = document.getElementById(name);

  // 视图切换：CSS 单管线淡入（transitionViews 内处理 leaving 标记）
  transitionViews(oldView, newView, {
    activate: () => applyMainViewState(name),
  });

  syncDetailVisibility();
  renderWorkspaceChrome();

  // soft：仅切视图（定位原文等），不断 SSE、不强制全量刷新
  if (options.soft) {
    return;
  }

  // 仅日志相关主 Tab 才 rearm；切到 system 保持 SSE，只刷系统数据
  const LOG_VIEW_TABS = new Set(["overview", "astrbot", "logs"]);
  if (tabChanged && LOG_VIEW_TABS.has(name)) {
    rearmFileBaselineThenStream({ forceFileRefresh: true });
  } else {
    refresh(true);
    schedule();
  }
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
  schedule();
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
  window.clearInterval(state.logTimer);
  state.timer = null;
  state.logTimer = null;
  if (isAuthGateVisible()) {
    state.pendingLogRefresh = false;
    return;
  }
  if (autoRefreshEnabled()) {
    // summary/system 继续轮询；日志在 SSE 连接时由 stream 负责
    state.timer = window.setInterval(() => refresh(true), state.refreshMs);
    if (shouldFastRefreshLogs()) {
      state.logTimer = window.setInterval(() => refreshLogsOnly(), FAST_LOG_REFRESH_MS);
    }
  } else {
    state.pendingLogRefresh = false;
  }
}

function stopPolling() {
  window.clearInterval(state.timer);
  window.clearInterval(state.logTimer);
  state.timer = null;
  state.logTimer = null;
  state.pendingRefresh = false;
  state.pendingLogRefresh = false;
  state.pendingForceLogs = false;
  clearLogStreamConnectTimer();
  stopLogStream();
  updateLogModeUi();
}

function onLogStreamPayload(data, type) {
  mergeLogData(data, { replaceAll: type === "snapshot" });
  renderLogs();
  updateLogModeUi();
}

function onLogStreamStatusChange(status) {
  updateLogModeUi();
  // 降级/断开：恢复 logs 轮询；已连接：关掉 logTimer
  if (status === "connected" || status === "streaming") {
    window.clearInterval(state.logTimer);
    state.logTimer = null;
    state.pendingLogRefresh = false;
  } else if (status === "degraded" || status === "reconnecting" || status === "disabled" || status === "stopped") {
    schedule();
  }
}

async function progressiveLogInit() {
  if (isAuthGateVisible()) return;

  // 重入时清掉上一次延迟连流 / SSE，避免双连接
  clearLogStreamConnectTimer();
  stopLogStream();

  await refresh(false);

  updateLogModeUi();

  if (state.activeTab === "logs" || state.activeTab === "overview") {
    state.logCache.signature = "";
    renderLogs();
  }

  if (window.location.search.includes("token=")) {
    const cleanUrl = `${window.location.pathname}${window.location.hash}`;
    window.history.replaceState({}, document.title, cleanUrl);
    // 登录 Cookie 已由后端写入；清掉内存 token，后续只靠 Cookie
    clearAuthToken();
  }

  const logoutBtn = $("logoutBtn");
  if (logoutBtn) logoutBtn.hidden = !Boolean(state.config?.has_access_token);

  // 先文件轮询保活；约 refreshMs（默认 5s）后再切 SSE 增量（无 snapshot）
  // 基线已在上面的 refresh(false) 中完成，这里不再强制二次拉文件
  schedule();
  rearmFileBaselineThenStream({ forceFileRefresh: false });
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

bindAuthHooks({
  stopPolling,
  startApp: async () => {
    hideAuthGate();
    await progressiveLogInit();
  },
});
bindAuthUi();

syncDetailVisibility();
selectAstrBotTab(state.astrbotSubTab);

bootstrapAuth().then((result) => {
  if (result?.config) {
    applyPublicConfig(result.config);
  }
  if (result?.authed) {
    progressiveLogInit();
  }
}).catch((err) => {
  console.error("[ObserverPanel] 鉴权启动失败", err);
  progressiveLogInit();
});

// ============================================================================
// 动画级别：full / medium(默认) / off
// ============================================================================
const ANIM_LEVELS = ["medium", "full", "off"];
let animLevel = 0;

function animLevelLabel(level) {
  return { full: "动效: 全开", medium: "动效: 精简", off: "动效: 关闭" }[level] || "动效: 精简";
}

function applyAnimLevelClass() {
  const level = ANIM_LEVELS[animLevel];
  document.body.classList.remove("anim-full", "anim-medium", "anim-off");
  document.body.classList.add(`anim-${level}`);
  const btn = $("animToggle");
  if (btn) {
    btn.textContent = animLevelLabel(level);
    btn.title = "切换动画强度（精简 / 全开 / 关闭）";
    btn.setAttribute("aria-pressed", level !== "off" ? "true" : "false");
  }
}

function toggleAnimLevel() {
  animLevel = (animLevel + 1) % ANIM_LEVELS.length;
  const level = ANIM_LEVELS[animLevel];
  applyAnimLevelClass();
  try {
    localStorage.setItem("observer_anim_level", level);
  } catch {}
}

function initAnimLevel() {
  try {
    const saved = localStorage.getItem("observer_anim_level");
    if (saved) {
      const idx = ANIM_LEVELS.indexOf(saved);
      if (idx >= 0) animLevel = idx;
    } else {
      // 默认精简：运维盯盘少噪声
      animLevel = ANIM_LEVELS.indexOf("medium");
    }
  } catch {
    animLevel = ANIM_LEVELS.indexOf("medium");
  }
  applyAnimLevelClass();
}

initAnimLevel();

const animBtn = $("animToggle");
if (animBtn) animBtn.addEventListener("click", toggleAnimLevel);

// ============================================================================
// 全局触摸缩放反馈（仅 full）
// ============================================================================
document.addEventListener(
  "pointerdown",
  (e) => {
    if (!shouldAnimate("loop")) return;
    const target = e.target.closest(
      ".metric[data-jump], .event-item.selectable, .tab, " +
        ".subtab, .action-btn, .event-filter, .level-filter, .time-filter",
    );
    if (!target || target.closest("button")) return;
    target.style.transition = "transform 0.1s ease-out";
    target.style.transform = "scale(0.97)";
  },
  { passive: true },
);

document.addEventListener(
  "pointerup",
  () => {
    document
      .querySelectorAll(
        ".metric[data-jump], .event-item.selectable, .tab, " +
          ".subtab, .action-btn, .event-filter, .level-filter, .time-filter",
      )
      .forEach((el) => {
        el.style.transform = "";
      });
  },
  { passive: true },
);

document.addEventListener(
  "pointerleave",
  () => {
    document.querySelectorAll('[style*="scale(0.97)"]').forEach((el) => {
      el.style.transform = "";
    });
  },
  { passive: true },
);