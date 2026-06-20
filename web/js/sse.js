// ============================================================================
// SSE 实时日志流
// ============================================================================

import { state } from "./state.js?v=20260620-renderfix1";
import {
  token,
  SSE_MIN_BACKOFF,
  SSE_MAX_BACKOFF,
  SSE_BACKOFF_MULTIPLIER,
  SSE_HEALTH_CHECK_TIMEOUT,
} from "./config.js?v=20260620-renderfix1";
import { formatCompactLogTime } from "./utils/format.js?v=20260620-renderfix1";
import { toast } from "./utils/dom.js?v=20260620-renderfix1";
import { renderLogs } from "./views/logs.js?v=20260620-renderfix1";

export function updateSSEStatus(status) {
  const previousStatus = state.sseStatus;
  // 支持旧布尔调用（true→connected, false→disconnected/reconnecting）及新字符串调用
  if (status === true) status = "connected";
  else if (status === false) {
    // false 语义：如果之前已连接则标记为断开，否则标记为重连中；unavailable 保持 unavailable
    if (previousStatus === "unavailable") status = "unavailable";
    else status = previousStatus === "connected" ? "disconnected" : "reconnecting";
  } else if (!["connected", "reconnecting", "disconnected", "connecting", "unavailable"].includes(status)) {
    status = "disconnected";
  }
  state.sseConnected = status === "connected";
  state.sseStatus = status;

  // 侧边栏状态点
  const dot = document.querySelector(".status-dot");
  const text = document.getElementById("sidebarStatusText");
  if (dot) {
    if (status === "connected") {
      dot.style.background = "var(--accent-bright)";
      dot.style.boxShadow = "0 0 0 4px rgba(48, 164, 108, 0.14)";
    } else if (status === "reconnecting" || status === "connecting") {
      dot.style.background = "var(--warn-bright)";
      dot.style.boxShadow = "0 0 0 4px rgba(210, 153, 34, 0.14)";
    } else if (status === "unavailable") {
      dot.style.background = "var(--accent-bright)";
      dot.style.boxShadow = "0 0 0 4px rgba(48, 164, 108, 0.14)";
    } else {
      dot.style.background = "var(--danger-bright)";
      dot.style.boxShadow = "0 0 0 4px rgba(248, 81, 73, 0.14)";
    }
  }
  if (text) {
    const now = formatCompactLogTime({ timestamp: Date.now() });
    if (status === "connected") {
      text.textContent = `实时日志 · ${now}`;
    } else if (status === "reconnecting" || status === "connecting") {
      text.textContent = `重连中 · ${now}`;
    } else if (status === "unavailable") {
      text.textContent = `文件模式 · ${now}`;
    } else {
      text.textContent = `已断开 · ${now}`;
    }
  }

  // 日志页独立状态条
  const statusEl = document.getElementById("sseStatus");
  if (statusEl) {
    statusEl.classList.remove("sse-status-connected", "sse-status-connecting", "sse-status-reconnecting", "sse-status-disconnected", "sse-status-unavailable");
    statusEl.classList.add(`sse-status-${status}`);
    const textEl = statusEl.querySelector(".sse-text");
    if (textEl) {
      const labels = {
        connected: "已连接实时日志流",
        reconnecting: "重连中...",
        connecting: "连接中...",
        unavailable: "文件模式（非实时），实时流未启用",
        disconnected: "已断开，等待重连",
      };
      textEl.textContent = labels[status] || "未知状态";
    }
  }

  // 状态变化时 toast 提示（去重：仅与上次通知状态不同时提示；unavailable 不打扰）
  const notifyMessages = {
    connected: "实时日志流已连接",
    reconnecting: "实时日志流正在重连",
    disconnected: "实时日志流已断开",
  };
  if (status !== state.sseLastNotifiedStatus && notifyMessages[status]) {
    toast(notifyMessages[status]);
    state.sseLastNotifiedStatus = status;
  }

  // 手动重连按钮：仅在非连接、非连接中、且启用实时流时显示
  const reconnectBtn = document.getElementById("sseReconnectBtn");
  if (reconnectBtn) {
    const show = state.config?.log_stream_enabled && status !== "connected" && status !== "connecting";
    reconnectBtn.hidden = !show;
    reconnectBtn.disabled = status === "reconnecting";
  }
}

export function handleSSELogEntry(data) {
  try {
    const entry = typeof data === "string" ? JSON.parse(data) : data;
    if (!entry || !entry.message) return;
    const sseMax = 200;

    // 实时日志流：追加新条目
    state.logCache.sseEntries.push(entry);
    if (state.logCache.sseEntries.length > sseMax) {
      state.logCache.sseEntries = state.logCache.sseEntries.slice(-sseMax);
    }

    if (state.activeTab === "logs" || state.activeTab === "overview") {
      state.logCache.signature = "";
      renderLogs();
    }
  } catch (err) {
    // ignore parse errors
  }
}

export function disconnectSSE() {
  window.clearTimeout(state.sseReconnectTimer);
  if (state.sseEventSource) {
    state.sseEventSource.close();
    state.sseEventSource = null;
  }
  // 实时流根本未启用时保持 unavailable 状态，不误报「已断开」
  if (state.sseStatus !== "unavailable") {
    updateSSEStatus("disconnected");
  }
}

export function getSSEBackoff() {
  const attempts = state.sseReconnectAttempts || 0;
  return Math.min(SSE_MAX_BACKOFF, SSE_MIN_BACKOFF * Math.pow(SSE_BACKOFF_MULTIPLIER, attempts));
}

export function resetSSEBackoff() {
  state.sseReconnectAttempts = 0;
  state.sseBackoffMs = SSE_MIN_BACKOFF;
}

export function incrementSSEBackoff() {
  state.sseReconnectAttempts = (state.sseReconnectAttempts || 0) + 1;
  state.sseBackoffMs = getSSEBackoff();
}

/**
 * 连接前/重连前健康检查：避免在服务端已关闭实时流或鉴权失败时无限重试。
 * 返回 { ok, enabled }：ok 表示 HTTP 可达且状态正常；enabled 表示实时流仍启用。
 */
export async function checkSSEHealth() {
  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), SSE_HEALTH_CHECK_TIMEOUT);
    const response = await fetch(`/api/health${token ? `?token=${encodeURIComponent(token)}` : ""}`, {
      signal: controller.signal,
      cache: "no-store",
    });
    window.clearTimeout(timer);
    if (!response.ok) {
      return { ok: false, enabled: false, status: response.status };
    }
    const data = await response.json();
    return { ok: true, enabled: Boolean(data?.log_stream_enabled), status: response.status };
  } catch (err) {
    return { ok: false, enabled: false, error: err.message || String(err) };
  }
}

// SSE 连接：带健康检查和指数退避自动重连
export function connectSSE() {
  if (state.sseEventSource) {
    state.sseEventSource.close();
    state.sseEventSource = null;
  }

  if (!state.config?.log_stream_enabled) {
    resetSSEBackoff();
    updateSSEStatus("unavailable");
    return;
  }

  // 注意：EventSource 不支持自定义请求头，token 通过 query 传递。
  // 这会暴露在浏览器历史/代理日志中，生产环境建议配合 cookie/session 使用。
  const url = `/api/logs/stream?history=20${token ? `&token=${encodeURIComponent(token)}` : ""}`;
  let source;

  try {
    source = new EventSource(url);
  } catch (err) {
    console.warn("[ObserverPanel] SSE connection failed:", err);
    scheduleSSEReconnect();
    return;
  }

  state.sseEventSource = source;

  source.onopen = () => {
    resetSSEBackoff();
    updateSSEStatus("connected");
    console.log("[ObserverPanel] SSE connected");
  };

  source.onmessage = (event) => {
    if (event.data && event.data !== ": heartbeat") {
      handleSSELogEntry(event.data);
    }
  };

  source.onerror = (err) => {
    console.warn("[ObserverPanel] SSE error, will reconnect...", err);
    updateSSEStatus("reconnecting");
    source.close();
    state.sseEventSource = null;
    scheduleSSEReconnect();
  };
}

export async function scheduleSSEReconnect() {
  window.clearTimeout(state.sseReconnectTimer);

  if (!state.config?.log_stream_enabled) {
    updateSSEStatus("unavailable");
    return;
  }

  const backoff = getSSEBackoff();
  incrementSSEBackoff();

  console.log(`[ObserverPanel] SSE reconnecting in ${backoff}ms (attempt ${state.sseReconnectAttempts})`);

  state.sseReconnectTimer = window.setTimeout(async () => {
    if (document.visibilityState === "hidden") {
      // 后台标签页推迟到重新可见时再连，避免资源浪费
      return;
    }
    if (!state.config?.log_stream_enabled) {
      updateSSEStatus("unavailable");
      return;
    }

    const health = await checkSSEHealth();
    if (!health.ok) {
      console.warn("[ObserverPanel] SSE 健康检查失败，继续退避重试", health);
      updateSSEStatus("reconnecting");
      scheduleSSEReconnect();
      return;
    }
    if (!health.enabled) {
      console.warn("[ObserverPanel] 服务端实时流已关闭，停止重连");
      updateSSEStatus("unavailable");
      return;
    }

    connectSSE();
  }, backoff);
}
