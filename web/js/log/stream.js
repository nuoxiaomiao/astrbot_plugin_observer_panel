// ============================================================================
// 日志 SSE 客户端（File-SSE）
// 载荷形状与 /api/logs 一致：{ astrbot: [...], source: "stream" }
// 历史基线由 GET /api/logs 提供；SSE 默认不带 snapshot，只推增量。
// ============================================================================

import { state } from "../state.js?v=20260709-stream4";
import { logsStreamPath } from "../api.js?v=20260709-stream4";

const RECONNECT_BASE_MS = 800;
const RECONNECT_MAX_MS = 12000;

let reconnectTimer = null;
let reconnectAttempt = 0;
let manualClose = false;
let streamOptions = {
  snapshot: false,
};
let handlers = {
  onPayload: null,
  onStatusChange: null,
};

function setStatus(status, detail = "") {
  const prev = state.logStream?.status;
  state.logStream = {
    ...(state.logStream || {}),
    status,
    detail: detail || "",
    lastEventAt: status === "connected" || status === "streaming"
      ? Date.now()
      : (state.logStream?.lastEventAt || 0),
  };
  if (typeof handlers.onStatusChange === "function" && prev !== status) {
    handlers.onStatusChange(status, detail);
  }
}

export function isLogStreamConnected() {
  return state.logStream?.status === "connected" || state.logStream?.status === "streaming";
}

/** SSE 已发起或已连通：跳过 HTTP 拉 logs，避免 connecting 阶段双路 merge */
export function isLogStreamBusy() {
  const status = state.logStream?.status;
  return status === "connected" || status === "streaming" || status === "connecting";
}

export function isLogStreamPreferred() {
  // config 未加载时默认尝试；明确关闭则不连
  if (state.config && state.config.log_stream_enabled === false) return false;
  if (state.config?.log_stream && state.config.log_stream.enabled === false) return false;
  return true;
}

function clearReconnectTimer() {
  if (reconnectTimer != null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect() {
  clearReconnectTimer();
  if (manualClose || !isLogStreamPreferred()) return;
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt));
  reconnectAttempt = Math.min(reconnectAttempt + 1, 8);
  setStatus("reconnecting", `将在 ${Math.round(delay / 1000)}s 后重连`);
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connectLogStream();
  }, delay);
}

function parseSseData(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function handleEventPayload(payload) {
  if (!payload || typeof payload !== "object") return;
  const type = String(payload.type || "");
  state.logStream.lastEventAt = Date.now();

  if (type === "hello") {
    setStatus("connected");
    return;
  }
  if (type === "snapshot" || type === "logs") {
    const data = payload.data;
    if (data && typeof handlers.onPayload === "function") {
      handlers.onPayload(data, type);
    }
    if (state.logStream.status !== "connected" && state.logStream.status !== "streaming") {
      setStatus("connected");
    } else {
      state.logStream.status = "connected";
    }
    reconnectAttempt = 0;
  }
}

function connectLogStream() {
  if (!isLogStreamPreferred()) {
    setStatus("disabled");
    return;
  }
  if (typeof EventSource === "undefined") {
    setStatus("degraded", "浏览器不支持 EventSource");
    return;
  }

  // 关闭旧连接
  const existing = state.logStream?.es;
  if (existing) {
    try {
      existing.close();
    } catch {
      /* ignore */
    }
    state.logStream.es = null;
  }

  manualClose = false;
  setStatus("connecting");
  // 默认无 snapshot：历史已由 /api/logs 文件基线提供
  const url = logsStreamPath({ snapshot: Boolean(streamOptions.snapshot) });
  let es;
  try {
    es = new EventSource(url, { withCredentials: true });
  } catch (err) {
    setStatus("degraded", err?.message || "无法创建 SSE 连接");
    scheduleReconnect();
    return;
  }
  state.logStream.es = es;

  es.onopen = () => {
    reconnectAttempt = 0;
    setStatus("connected");
  };

  es.onmessage = (event) => {
    const payload = parseSseData(event.data);
    if (!payload) return;
    handleEventPayload(payload);
  };

  es.onerror = () => {
    try {
      es.close();
    } catch {
      /* ignore */
    }
    if (state.logStream?.es === es) {
      state.logStream.es = null;
    }
    if (manualClose) return;

    setStatus("degraded", "连接中断，回退文件轮询");
    scheduleReconnect();
  };
}

/**
 * @param {{ onPayload?: Function, onStatusChange?: Function, snapshot?: boolean }} options
 */
export function startLogStream(options = {}) {
  handlers = {
    onPayload: options.onPayload || null,
    onStatusChange: options.onStatusChange || null,
  };
  streamOptions = {
    // 首屏/重连默认不拉 snapshot，避免二次全量扫盘
    snapshot: options.snapshot === true,
  };
  clearReconnectTimer();
  reconnectAttempt = 0;
  if (!isLogStreamPreferred()) {
    setStatus("disabled");
    return;
  }
  connectLogStream();
}

export function stopLogStream() {
  manualClose = true;
  clearReconnectTimer();
  const es = state.logStream?.es;
  if (es) {
    try {
      es.close();
    } catch {
      /* ignore */
    }
  }
  if (state.logStream) {
    state.logStream.es = null;
  }
  setStatus("stopped");
}

export function logStreamStatusLabel() {
  const status = state.logStream?.status || "idle";
  const broker = state.config?.log_broker_enabled ? " · LogBroker" : "";
  switch (status) {
    case "pending":
      return state.logStream?.detail || "文件读取 · 稍后接入实时流";
    case "connecting":
      return "日志流连接中…";
    case "connected":
    case "streaming":
      return `实时日志流${broker}`;
    case "reconnecting":
      return state.logStream?.detail || "日志流重连中…";
    case "degraded":
      return "文件轮询（流已降级）";
    case "disabled":
      return "文件轮询（流已关闭）";
    case "stopped":
      return "文件轮询模式";
    default:
      return "文件轮询模式";
  }
}