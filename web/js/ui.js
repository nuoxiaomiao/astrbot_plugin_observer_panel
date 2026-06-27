// ============================================================================
// UI 交互
// ============================================================================

import { state } from "./state.js?v=20260627-calm1";
import {
  SIDEBAR_COLLAPSED_KEY,
  COMPACT_KEY,
  THEME_KEY,
  DRAG_LAYOUT_PREFIX,
  NOTIFY_COOLDOWN_MS,
  NOTIFY_LAST_KEY,
  SHORTCUT_KEY_LABELS,
} from "./config.js?v=20260627-calm1";
import { formatBytes, formatPercent, shortUptime, usageKind, diagnosticLabel, formatCompactLogTime } from "./utils/format.js?v=20260627-calm1";
import {
  $,
  setText,
  toast,
} from "./utils/dom.js?v=20260627-calm1";
import { compactText } from "./utils/log-text.js?v=20260627-calm1";

// ============================================================================
// 侧边栏折叠（2.1）
// ============================================================================

export function setSidebarCollapsed(collapsed) {
  const body = document.body;
  if (collapsed) {
    body.classList.add("sidebar-collapsed");
    body.dataset.sidebarCollapsed = "1";
  } else {
    body.classList.remove("sidebar-collapsed");
    delete body.dataset.sidebarCollapsed;
  }
  const expand = $("sidebarExpand");
  if (expand) expand.hidden = !collapsed;
}

export function isSidebarCollapsed() {
  return document.body.classList.contains("sidebar-collapsed");
}

export function restoreSidebarState() {
  try {
    if (localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1") {
      setSidebarCollapsed(true);
    }
  } catch (err) {
    // localStorage 不可用时静默忽略
  }
}

export function bindSidebarToggle() {
  const collapseBtn = $("sidebarCollapse");
  const expandBtn = $("sidebarExpand");
  const mobileMenuBtn = $("mobileMenuBtn");

  function closeMobileSidebar() {
    document.body.classList.remove("sidebar-open");
    document.body.classList.remove("detail-open");
  }

  if (collapseBtn) {
    collapseBtn.addEventListener("click", () => {
      const next = !isSidebarCollapsed();
      setSidebarCollapsed(next);
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      } catch (err) { /* ignore */ }
    });
  }
  if (expandBtn) {
    expandBtn.addEventListener("click", () => {
      setSidebarCollapsed(false);
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, "0");
      } catch (err) { /* ignore */ }
    });
  }

  if (mobileMenuBtn) {
    mobileMenuBtn.addEventListener("click", () => {
      document.body.classList.toggle("sidebar-open");
    });
  }

  // 点击抽屉遮罩关闭移动端侧边栏
  document.addEventListener("click", (e) => {
    if (document.body.classList.contains("sidebar-open")) {
      const sidebar = document.querySelector(".workspace-sidebar");
      if (sidebar && !sidebar.contains(e.target) && !(mobileMenuBtn && mobileMenuBtn.contains(e.target))) {
        closeMobileSidebar();
      }
    }
  });

  restoreSidebarState();
}

export function bindMetricJump(selectTab) {
  document.querySelectorAll(".metric[data-jump]").forEach((metric) => {
    metric.addEventListener("click", () => {
      const target = metric.dataset.jump;
      const scrollId = metric.dataset.scroll;
      if (!target) return;
      selectTab(target);
      if (scrollId) {
        // 切换后等待视图渲染，再滚动到目标元素
        window.setTimeout(() => {
          const el = $(scrollId);
          if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
        }, 80);
      }
    });
    metric.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        metric.click();
      }
    });
    if (!metric.hasAttribute("tabindex")) metric.setAttribute("tabindex", "0");
  });
}

// ============================================================================
// 紧凑模式（3.2）
// ============================================================================

export function setCompactMode(enabled) {
  const body = document.body;
  body.classList.toggle("compact", enabled);
  const btn = $("compactToggle");
  if (btn) {
    btn.classList.toggle("active", enabled);
    btn.setAttribute("aria-pressed", enabled ? "true" : "false");
  }
}

export function bindCompactToggle() {
  try {
    if (localStorage.getItem(COMPACT_KEY) === "1") setCompactMode(true);
  } catch (err) { /* ignore */ }
  const btn = $("compactToggle");
  if (btn) {
    btn.addEventListener("click", () => {
      const next = !document.body.classList.contains("compact");
      setCompactMode(next);
      try {
        localStorage.setItem(COMPACT_KEY, next ? "1" : "0");
      } catch (err) { /* ignore */ }
    });
  }
}

// ============================================================================
// 主题切换（3.1）
// ============================================================================

export function setTheme(theme) {
  const root = document.documentElement;
  if (theme === "light") {
    root.setAttribute("data-theme", "light");
    document.body.classList.add("theme-light");
  } else {
    root.removeAttribute("data-theme");
    document.body.classList.remove("theme-light");
  }
  const btn = $("themeToggle");
  if (btn) {
    btn.classList.toggle("active", theme === "light");
    btn.setAttribute("aria-pressed", theme === "light" ? "true" : "false");
    btn.textContent = theme === "light" ? "浅色" : "深色";
  }
}

export function currentTheme() {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

export function bindThemeToggle() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") setTheme(saved);
  } catch (err) { /* ignore */ }
  const btn = $("themeToggle");
  if (btn) {
    btn.addEventListener("click", () => {
      const next = currentTheme() === "light" ? "dark" : "light";
      setTheme(next);
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch (err) { /* ignore */ }
    });
  }
}

// ============================================================================
// 面板拖拽排序（2.4）
// ============================================================================

/**
 * 为容器内所有 .panel 启用拖拽排序，顺序持久化到 localStorage。
 * @param {string} storageKey - 持久化键名后缀
 */
export function enablePanelDragDrop(container, storageKey) {
  if (!container) return;
  const storeId = `${DRAG_LAYOUT_PREFIX}${storageKey}`;
  let dragSrc = null;

  // 启动时按存储顺序重排
  try {
    const saved = JSON.parse(localStorage.getItem(storeId) || "[]");
    if (Array.isArray(saved) && saved.length) {
      const panels = [...container.querySelectorAll(":scope > .panel")];
      const byHeading = new Map();
      panels.forEach((p) => {
        const h = p.querySelector(".panel-head h2")?.textContent?.trim();
        if (h) byHeading.set(h, p);
      });
      saved.forEach((heading) => {
        const panel = byHeading.get(heading);
        if (panel) container.appendChild(panel);
      });
    }
  } catch (err) { /* ignore */ }

  const panels = [...container.querySelectorAll(":scope > .panel")];

  function syncDraggable() {
    panels.forEach((panel) => {
      panel.draggable = Boolean(state.editMode);
    });
  }

  panels.forEach((panel) => {
    panel.addEventListener("dragstart", (e) => {
      if (!state.editMode) {
        e.preventDefault();
        return;
      }
      dragSrc = panel;
      panel.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      try {
        e.dataTransfer.setData("text/plain", "");
      } catch (err) { /* IE 忽略 */ }
    });

    panel.addEventListener("dragend", () => {
      panel.classList.remove("dragging");
      container.querySelectorAll(".panel").forEach((p) => p.classList.remove("drag-over", "drag-before", "drag-after"));
      if (state.editMode) savePanelOrder(container, storeId);
    });

    panel.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (!state.editMode || !dragSrc || dragSrc === panel) return;
      e.dataTransfer.dropEffect = "move";
      const rect = panel.getBoundingClientRect();
      const after = (e.clientY - rect.top) > rect.height / 2;
      panel.classList.add("drag-over");
      panel.classList.toggle("drag-after", after);
      panel.classList.toggle("drag-before", !after);
    });

    panel.addEventListener("dragleave", () => {
      panel.classList.remove("drag-over", "drag-before", "drag-after");
    });

    panel.addEventListener("drop", (e) => {
      e.preventDefault();
      if (!state.editMode || !dragSrc || dragSrc === panel) return;
      const rect = panel.getBoundingClientRect();
      const after = (e.clientY - rect.top) > rect.height / 2;
      const reference = after ? panel.nextSibling : panel;
      container.insertBefore(dragSrc, reference);
      savePanelOrder(container, storeId);
    });
  });

  syncDraggable();
  return syncDraggable;
}

export function savePanelOrder(container, storeId) {
  try {
    const headings = [...container.querySelectorAll(":scope > .panel .panel-head h2")]
      .map((h) => h.textContent.trim())
      .filter(Boolean);
    localStorage.setItem(storeId, JSON.stringify(headings));
  } catch (err) { /* ignore */ }
}

export function resetPanelLayout() {
  try {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith(DRAG_LAYOUT_PREFIX));
    keys.forEach((k) => localStorage.removeItem(k));
  } catch (err) { /* ignore */ }
  toast("已重置布局，刷新页面生效");
}

const panelDragSyncFns = new Set();

export function initPanelDragDrop() {
  panelDragSyncFns.clear();
  // 总览两栏布局
  document.querySelectorAll(".overview-live-layout").forEach((c, i) => {
    const sync = enablePanelDragDrop(c, `overview_${i}`);
    if (sync) panelDragSyncFns.add(sync);
  });
  // AstrBot 各 subview 的两栏布局
  document.querySelectorAll(".runtime-stats-layout, .log-insight-layout").forEach((c, i) => {
    const sync = enablePanelDragDrop(c, `astrbot_${i}`);
    if (sync) panelDragSyncFns.add(sync);
  });
  // 系统视图两栏布局
  document.querySelectorAll(".system-sections, #system > .layout.two").forEach((c, i) => {
    const sync = enablePanelDragDrop(c, `system_${i}`);
    if (sync) panelDragSyncFns.add(sync);
  });
  const resetBtn = $("resetLayout");
  if (resetBtn) resetBtn.addEventListener("click", resetPanelLayout);
}

export function syncAllPanelDraggable() {
  panelDragSyncFns.forEach((fn) => fn());
  document.body.classList.toggle("edit-mode", state.editMode);
}

export function toggleEditMode() {
  state.editMode = !state.editMode;
  syncAllPanelDraggable();
  const btn = $("editToggle");
  if (btn) {
    btn.classList.toggle("active", state.editMode);
    btn.setAttribute("aria-pressed", state.editMode ? "true" : "false");
    btn.textContent = state.editMode ? "完成" : "编辑";
  }
  toast(state.editMode ? "已进入编辑模式，可拖拽面板" : "已退出编辑模式");
}

export function bindEditToggle() {
  const btn = $("editToggle");
  if (btn) btn.addEventListener("click", toggleEditMode);
}

// ============================================================================
// 键盘快捷键
// ============================================================================

export function isTypingElement(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

export function isShortcutsOverlayOpen() {
  return document.querySelector(".shortcuts-overlay") !== null;
}

export function debounce(fn, delay) {
  let timer = null;
  return function (...args) {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn.apply(this, args), delay);
  };
}

let renderLogsRef = () => {};
const debouncedLogFilter = debounce(() => {
  state.logPage = 1;
  renderLogsRef();
}, 200);

export function queueLogFilterRender() {
  debouncedLogFilter();
}

// ============================================================================
// 时间过滤 / 日志搜索增强
// ============================================================================

export function selectTimeFilter(time, renderLogs = renderLogsRef) {
  state.logTimeFilter = time;
  state.logPage = 1;
  document.querySelectorAll(".time-filter").forEach((button) => {
    button.classList.toggle("active", button.dataset.time === time);
  });
  const customBox = $("logCustomTime");
  if (customBox) customBox.hidden = time !== "custom";
  if (time !== "custom") {
    state.logTimeFrom = null;
    state.logTimeTo = null;
    const fromInput = $("logTimeFrom");
    const toInput = $("logTimeTo");
    if (fromInput) fromInput.value = "";
    if (toInput) toInput.value = "";
  }
  renderLogs();
}

export function bindLogSearchEnhancements(renderLogs = renderLogsRef) {
  const regexToggle = $("logRegexToggle");
  if (regexToggle) {
    regexToggle.addEventListener("click", () => {
      state.logRegex = !state.logRegex;
      regexToggle.classList.toggle("active", state.logRegex);
      regexToggle.setAttribute("aria-pressed", state.logRegex ? "true" : "false");
      state.logPage = 1;
      renderLogs();
      if (state.logRegex) {
        toast("已开启正则搜索模式");
      }
    });
  }

  const fromInput = $("logTimeFrom");
  const toInput = $("logTimeTo");
  const clearBtn = $("logTimeClear");
  if (fromInput) {
    fromInput.addEventListener("change", () => {
      state.logTimeFrom = fromInput.value ? new Date(fromInput.value).getTime() : null;
      state.logPage = 1;
      renderLogs();
    });
  }
  if (toInput) {
    toInput.addEventListener("change", () => {
      // datetime-local 选到「日」时包含当天截止，补到当天 23:59:59
      if (toInput.value && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(toInput.value)) {
        state.logTimeTo = new Date(toInput.value).getTime() + 59999;
      } else {
        state.logTimeTo = toInput.value ? new Date(toInput.value).getTime() : null;
      }
      state.logPage = 1;
      renderLogs();
    });
  }
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      state.logTimeFrom = null;
      state.logTimeTo = null;
      if (fromInput) fromInput.value = "";
      if (toInput) toInput.value = "";
      state.logPage = 1;
      renderLogs();
    });
  }
}

export function bindOverviewJump(selectTab) {
  const jumpBtn = $("jumpToSystem");
  if (jumpBtn) {
    jumpBtn.addEventListener("click", () => {
      selectTab("system");
      window.setTimeout(() => {
        const el = $("systemInfo");
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 80);
    });
  }
}

// ============================================================================
// 浏览器告警通知（2.5）
// ============================================================================

export function buildDiagnosticMessage(diagnostics) {
  const issues = diagnostics.issues || diagnostics.items || [];
  const badItems = issues.filter((it) => (it.severity || it.level || "").toLowerCase() === "bad");
  if (badItems.length) {
    const first = badItems[0];
    return `[观察面板] 异常：${first.title || first.name || first.message || "存在异常诊断项"}`;
  }
  return `[观察面板] 诊断状态异常，请检查面板`;
}

export function checkDiagnosticNotifications(diagnostics) {
  if (!diagnostics || diagnostics.status !== "bad") {
    return;
  }
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;

  let lastTs = 0;
  try {
    lastTs = Number(sessionStorage.getItem(NOTIFY_LAST_KEY) || 0);
  } catch (err) { /* ignore */ }
  const now = Date.now();
  if (now - lastTs < NOTIFY_COOLDOWN_MS) return;

  try {
    sessionStorage.setItem(NOTIFY_LAST_KEY, String(now));
  } catch (err) { /* ignore */ }
  try {
    new Notification(buildDiagnosticMessage(diagnostics), {
      tag: "observer-panel-alert",
      renotify: true,
    });
  } catch (err) { /* ignore */ }
}

export function promptNotificationPermission() {
  if (!("Notification" in window)) return;
  if (Notification.permission !== "default") return;
  // 延迟提示，避免与加载动画冲突
  window.setTimeout(() => {
    toast("如需接收异常告警，请点击右上角允许浏览器通知");
    // 仅在用户后续交互时请求权限（避免自动弹窗打扰）
    const requestOnce = () => {
      Notification.requestPermission();
      document.removeEventListener("click", requestOnce);
    };
    document.addEventListener("click", requestOnce, { once: true });
  }, 2000);
}

// ============================================================================
// 诊断报告导出（3.4）
// ============================================================================

export function buildDiagnosticReport() {
  const summary = state.summary || {};
  const system = state.system || summary.system || {};
  const diagnostics = summary.diagnostics || {};
  const plugin = summary.plugin || {};
  const host = system.host || {};
  const cpu = system.cpu || {};
  const memory = system.memory || {};
  const disks = system.disks || [];
  const rootDisk = disks[0] || {};
  const logs = summary.logs || {};
  const logAnalysis = logs.analysis || {};
  const logCounts = logAnalysis.counts || {};
  const insights = state.traceInsights;

  const lines = [];
  const stamp = new Date().toLocaleString("zh-CN", { hour12: false });
  lines.push(`# AstrBot 观察面板 - 诊断报告`);
  lines.push("");
  lines.push(`> 导出时间：${stamp}`);
  lines.push("");

  // 系统摘要
  lines.push(`## 系统摘要`);
  lines.push("");
  lines.push(`- 主机：${host.hostname || "--"}（${host.platform || "--"} / ${host.machine || "--"}）`);
  lines.push(`- 系统运行：${shortUptime(host.uptime_seconds)}`);
  lines.push(`- 面板运行：${shortUptime(plugin.uptime_seconds)}`);
  lines.push(`- 访问地址：${plugin.url || window.location.href}`);
  lines.push("");

  // 阈值状态
  lines.push(`## 资源阈值状态`);
  lines.push("");
  const cpuKind = usageKind(cpu.percent);
  const memKind = usageKind(memory.percent);
  const diskKind = usageKind(rootDisk.percent);
  lines.push(`| 资源 | 使用率 | 状态 |`);
  lines.push(`|------|--------|------|`);
  lines.push(`| CPU | ${formatPercent(cpu.percent)} | ${cpuKind === "ok" ? "✅ 正常" : cpuKind === "warn" ? "⚠️ 偏高" : "🔴 异常"} |`);
  lines.push(`| 内存 | ${formatPercent(memory.percent)} | ${memKind === "ok" ? "✅ 正常" : memKind === "warn" ? "⚠️ 偏高" : "🔴 异常"} |`);
  lines.push(`| 根分区 | ${formatPercent(rootDisk.percent)} | ${diskKind === "ok" ? "✅ 正常" : diskKind === "warn" ? "⚠️ 偏高" : "🔴 异常"} |`);
  lines.push(`- CPU 型号：${cpu.model || "--"}`);
  lines.push(`- 内存：${formatBytes(memory.used)} / ${formatBytes(memory.total)}`);
  lines.push(`- 根分区：${formatBytes(rootDisk.used)} / ${formatBytes(rootDisk.total)}`);
  lines.push("");

  // 诊断评分
  lines.push(`## 诊断评分`);
  lines.push("");
  lines.push(`- 状态：${diagnosticLabel(diagnostics.status)}`);
  lines.push(`- 评分：${diagnostics.score == null ? "--" : `${diagnostics.score}/100`}`);
  lines.push(`- 诊断项数：${diagnostics.issue_count || 0}`);
  if (Array.isArray(diagnostics.issues) && diagnostics.issues.length) {
    lines.push("");
    lines.push(`### 异常诊断项`);
    lines.push("");
    diagnostics.issues.slice(0, 20).forEach((item) => {
      const sev = (item.severity || item.level || "").toUpperCase();
      lines.push(`- **[${sev}]** ${item.title || item.name || "--"}：${item.message || item.detail || ""}`);
    });
  }
  lines.push("");

  // 日志统计
  lines.push(`## 日志统计`);
  lines.push("");
  lines.push(`- 错误：${logCounts.error || 0} 条`);
  lines.push(`- 警告：${logCounts.warn || 0} 条`);
  lines.push(`- 信息：${logCounts.info || 0} 条`);
  lines.push("");

  // 最近错误日志
  const errorEntries = (state.logCache.entries || [])
    .filter((entry) => entry.level === "error")
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, 10);
  if (errorEntries.length) {
    lines.push(`### 最近错误日志（前 ${errorEntries.length} 条）`);
    lines.push("");
    lines.push("```");
    errorEntries.forEach((entry) => {
      const time = entry.timestamp ? formatCompactLogTime(entry) : "--";
      const text = compactText(entry.summary || entry.message || entry.raw, 200);
      lines.push(`[${time}] ${entry.fileName || entry.moduleName || "--"}: ${text}`);
    });
    lines.push("```");
    lines.push("");
  }

  // 运行工具与会话统计
  if (insights) {
    lines.push(`## 会话与工具统计`);
    lines.push("");
    lines.push(`- 有效会话：${insights.sessions?.length || 0}`);
    lines.push(`- 活动会话：${insights.runningSessions?.length || 0}`);
    lines.push(`- 运行中工具：${insights.runningTools?.length || 0}`);
    lines.push(`- 慢请求：${insights.slowCount || 0}`);
    lines.push(`- 错误事件：${insights.errorCount || 0}`);
    lines.push(`- 工具调用总数：${insights.toolCalls?.length || 0}`);
    lines.push("");
  }

  lines.push(`---`);
  lines.push(`*由 AstrBot 观察面板自动生成*`);
  return lines.join("\n");
}

export function exportDiagnosticReport() {
  try {
    const markdown = buildDiagnosticReport();
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
    const a = document.createElement("a");
    a.href = url;
    a.download = `observer-panel-report-${ts}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("诊断报告已导出");
  } catch (err) {
    toast(`导出失败：${err.message || err}`);
  }
}

export function bindExportReport() {
  const btn = $("exportReport");
  if (btn) btn.addEventListener("click", exportDiagnosticReport);
}

// ============================================================================
// 快捷键帮助浮层
// ============================================================================

export let keyboardShortcuts = {};
export let showShortcutsHelp = () => {};

function showShortcutsHelpOverlay() {
  const overlay = document.createElement("div");
  overlay.className = "shortcuts-overlay";
  overlay.innerHTML = `
    <div class="shortcuts-dialog">
      <div class="shortcuts-header">
        <h2>键盘快捷键</h2>
        <button class="shortcuts-close" aria-label="关闭">×</button>
      </div>
      <div class="shortcuts-body">
        <dl class="shortcuts-list">
          ${Object.entries(keyboardShortcuts)
            .map(
              ([_, shortcut]) => `
            <dt><kbd>${SHORTCUT_KEY_LABELS[shortcut.key] || shortcut.key}</kbd></dt>
            <dd>${shortcut.description}</dd>
          `,
            )
            .join("")}
        </dl>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const closeBtn = overlay.querySelector(".shortcuts-close");
  const dialog = overlay.querySelector(".shortcuts-dialog");

  const closeOverlay = () => {
    overlay.classList.add("closing");
    window.setTimeout(() => overlay.remove(), 200);
  };

  closeBtn.addEventListener("click", closeOverlay);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeOverlay();
  });

  document.addEventListener("keydown", function escHandler(e) {
    if (e.key === "Escape") {
      closeOverlay();
      document.removeEventListener("keydown", escHandler);
    }
  });

  window.setTimeout(() => overlay.classList.add("visible"), 10);
}

// ============================================================================
// Loading States
// ============================================================================

export function addLoadingState(element, type = "default") {
  if (!element) return;
  element.classList.add("loading");
  element.setAttribute("aria-busy", "true");

  if (type === "skeleton") {
    const skeleton = document.createElement("div");
    skeleton.className = "skeleton-loader";
    skeleton.innerHTML = `
      <div class="skeleton-line"></div>
      <div class="skeleton-line"></div>
      <div class="skeleton-line short"></div>
    `;
    element.dataset.originalContent = element.innerHTML;
    element.innerHTML = "";
    element.appendChild(skeleton);
  }
}

export function removeLoadingState(element) {
  if (!element) return;
  element.classList.remove("loading");
  element.removeAttribute("aria-busy");

  if (element.dataset.originalContent) {
    element.innerHTML = element.dataset.originalContent;
    delete element.dataset.originalContent;
  }
}

import { renderDetailPanel } from "./components/event-list.js?v=20260627-calm1";

// ============================================================================
// 详情面板
// ============================================================================

export function closeDetailPanel() {
  state.selectedEventId = "";
  state.selectedSessionId = "";
  renderDetailPanel();
  renderLogsRef();
  // 移动端关闭详情面板
  document.querySelector(".workspace-detail")?.classList.remove("open");
  document.body.classList.remove("detail-open");
}

// ============================================================================
// UI 绑定入口
// ============================================================================

export function bindUI(actions) {
  renderLogsRef = actions.renderLogs;

  keyboardShortcuts = {
    help: {
      key: "?",
      description: "显示快捷键帮助",
      handler: (e) => {
        e.preventDefault();
        showShortcutsHelp();
      },
    },
    refresh: {
      key: "r",
      description: "刷新数据",
      handler: (e) => {
        e.preventDefault();
        actions.refresh(true);
      },
    },
    search: {
      key: "/",
      description: "搜索日志",
      handler: (e) => {
        e.preventDefault();
        const logFilter = $("logFilter");
        if (logFilter) {
          logFilter.focus();
          logFilter.select();
        }
      },
    },
    escape: {
      key: "Escape",
      description: "关闭详情面板或清除搜索",
      handler: (e) => {
        const logFilter = $("logFilter");
        if (document.activeElement === logFilter && logFilter.value) {
          e.preventDefault();
          logFilter.value = "";
          queueLogFilterRender();
        } else if (state.selectedEventId || state.selectedSessionId) {
          e.preventDefault();
          actions.closeDetailPanel();
        }
      },
    },
    tab1: {
      key: "1",
      description: "切换到总览标签",
      handler: (e) => {
        if (e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA") {
          e.preventDefault();
          actions.selectTab("overview");
        }
      },
    },
    tab2: {
      key: "2",
      description: "切换到 AstrBot 标签",
      handler: (e) => {
        if (e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA") {
          e.preventDefault();
          actions.selectTab("astrbot");
        }
      },
    },
    tab3: {
      key: "3",
      description: "切换到日志分析标签",
      handler: (e) => {
        if (e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA") {
          e.preventDefault();
          actions.selectTab("logs");
        }
      },
    },
    tab4: {
      key: "4",
      description: "切换到系统标签",
      handler: (e) => {
        if (e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA") {
          e.preventDefault();
          actions.selectTab("system");
        }
      },
    },
  };

  showShortcutsHelp = () => showShortcutsHelpOverlay();

  function handleKeyboardShortcuts(e) {
    // 快捷键帮助浮层打开时，忽略所有全局快捷键（浮层自身处理 Escape）
    if (isShortcutsOverlayOpen()) return;

    const typing = isTypingElement(e.target);

    // Ctrl / Cmd 快捷键
    if (e.ctrlKey || e.metaKey) {
      if (e.key === "r") {
        e.preventDefault();
        actions.refresh(true);
        return;
      }
      if (e.key === "k") {
        e.preventDefault();
        $("logFilter")?.focus();
        return;
      }
      if (e.key >= "1" && e.key <= "4") {
        e.preventDefault();
        const tabs = ["overview", "astrbot", "logs", "system"];
        actions.selectTab(tabs[parseInt(e.key) - 1]);
        return;
      }
      return;
    }

    // 非组合键在输入框内不触发（Escape 除外，用于清空搜索）
    if (typing && e.key !== "Escape") return;

    switch (e.key) {
      case "?":
        e.preventDefault();
        showShortcutsHelp();
        break;
      case "r":
        e.preventDefault();
        actions.refresh(true);
        break;
      case "/":
        e.preventDefault();
        $("logFilter")?.focus();
        break;
      case "Escape": {
        const logFilter = $("logFilter");
        if (document.activeElement === logFilter && logFilter.value) {
          e.preventDefault();
          logFilter.value = "";
          queueLogFilterRender();
        } else if (state.selectedEventId || state.selectedSessionId) {
          e.preventDefault();
          actions.closeDetailPanel();
        }
        break;
      }
      case "1":
      case "2":
      case "3":
      case "4": {
        e.preventDefault();
        const tabs = ["overview", "astrbot", "logs", "system"];
        actions.selectTab(tabs[parseInt(e.key) - 1]);
        break;
      }
      case "f":
        // 全屏功能已移除
        break;
    }
  }

  document.addEventListener("keydown", handleKeyboardShortcuts);

  bindSidebarToggle();
  bindMetricJump(actions.selectTab);
  bindLogSearchEnhancements(actions.renderLogs);
  bindOverviewJump(actions.selectTab);
  bindCompactToggle();
  bindThemeToggle();
  bindEditToggle();
  $("refreshBtn").addEventListener("click", () => actions.refresh(true));
  $("autoRefresh").addEventListener("change", actions.schedule);
  $("logFilter").addEventListener("input", queueLogFilterRender);
  $("logPrevPage").addEventListener("click", () => actions.changeLogPage(-1));
  $("logNextPage").addEventListener("click", () => actions.changeLogPage(1));

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => actions.selectTab(tab.dataset.tab));
  });
  document.querySelectorAll(".subtab").forEach((tab) => {
    tab.addEventListener("click", () => actions.selectAstrBotTab(tab.dataset.astrbotTab));
  });
  document.querySelectorAll(".level-filter").forEach((button) => {
    button.addEventListener("click", () => actions.selectLogLevel(button.dataset.level));
  });
  document.querySelectorAll(".event-filter").forEach((button) => {
    button.addEventListener("click", () => actions.selectEventType(button.dataset.event));
  });
  document.querySelectorAll(".time-filter").forEach((button) => {
    button.addEventListener("click", () => actions.selectTimeFilter(button.dataset.time));
  });

  initPanelDragDrop();
  bindExportReport();
}
