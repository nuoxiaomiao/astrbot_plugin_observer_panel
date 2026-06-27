// ============================================================================
// 工具函数 - 网络请求
// ============================================================================

import { state } from "./state.js?v=20260625-live3";
import { token } from "./config.js?v=20260625-live3";

// 请求超时设置
const REQUEST_TIMEOUT_MS = 8000;  // 8 秒超时
const MAX_CONCURRENT = 2;  // 最多 2 个并发请求

// 错误消息映射表
const ERROR_MESSAGES = {
  400: "请求参数有误，请检查筛选条件",
  401: "未授权，请重新登录",
  403: "无权访问此资源",
  404: "请求的资源不存在，请刷新页面",
  500: "服务器内部错误，请稍后重试",
  502: "网关错误，后端服务可能暂时不可用",
  503: "服务暂时不可用，请稍后重试",
  504: "请求超时，请检查网络连接",
  "AbortError": "请求超时（8秒），请检查网络或稍后重试",
  "NetworkError": "网络连接失败，请检查网络设置",
};

// 并发请求队列控制
class FetchQueue {
  constructor(maxConcurrent = MAX_CONCURRENT) {
    this.maxConcurrent = maxConcurrent;
    this.activeCount = 0;
    this.queue = [];
  }

  async execute(fn) {
    while (this.activeCount >= this.maxConcurrent) {
      await new Promise(resolve => this.queue.push(resolve));
    }
    this.activeCount++;
    try {
      return await fn();
    } finally {
      this.activeCount--;
      const resolve = this.queue.shift();
      if (resolve) resolve();
    }
  }
}

export const fetchQueue = new FetchQueue();

export function withToken(path) {
  const url = new URL(path, window.location.origin);
  if (token) {
    url.searchParams.set("token", token);
  }
  return url.pathname + url.search;
}

// 带超时控制的 fetch
export async function fetchJsonWithTimeout(path, timeout = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(withToken(path), {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    });
    const text = await res.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (err) {
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 180)}`);
    }
    if (!res.ok || payload.ok === false) {
      const status = res.status;
      const errorMsg = ERROR_MESSAGES[status] || payload.error || `HTTP ${status}`;
      throw new Error(errorMsg);
    }
    return payload;
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(ERROR_MESSAGES["AbortError"]);
    }
    if (err.message.includes("Failed to fetch") || err.message.includes("NetworkError")) {
      throw new Error(ERROR_MESSAGES["NetworkError"]);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

// 兼容旧代码的 fetchJson（使用新的超时版本）
export async function fetchJson(path) {
  return fetchJsonWithTimeout(path);
}

export function logCursorPayload() {
  const files = state.logs?.astrbot || [];
  return files
    .filter((file) => file.path)
    .map((file) => ({
      path: file.path,
      size: file.size || 0,
      mtime: file.mtime || 0,
      line_count: file.line_count || (Number(file.base_line || 0) + (file.lines || []).length),
      base_line: file.base_line || 0,
      ends_with_newline: file.ends_with_newline !== false,
    }));
}

export function logsApiPath() {
  const params = new URLSearchParams({ source: "astrbot" });
  const cursor = logCursorPayload();

  if (cursor.length) {
    const cursorJson = JSON.stringify(cursor);
    // 限制游标大小，防止超过 50KB（后端限制）
    if (cursorJson.length > 40000) {  // 预留 10KB 安全间距
      console.warn("[ObserverPanel] 日志游标过大，重置为完整读取");
      // 不发送游标，强制完整读取
      return `/api/logs?${params.toString()}`;
    }
    params.set("cursor", cursorJson);
  }
  return `/api/logs?${params.toString()}`;
}
