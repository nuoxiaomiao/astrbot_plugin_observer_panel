// ============================================================================
// 工具函数 - 网络请求
// ============================================================================

import { state } from "./state.js?v=20260620-sessionlive1";
import { token } from "./config.js?v=20260620-sessionlive1";

export function withToken(path) {
  const url = new URL(path, window.location.origin);
  if (token) {
    url.searchParams.set("token", token);
  }
  return url.pathname + url.search;
}

export async function fetchJson(path) {
  const res = await fetch(withToken(path), {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (err) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 180)}`);
  }
  if (!res.ok || payload.ok === false) {
    throw new Error(payload.error || `HTTP ${res.status}`);
  }
  return payload;
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
    params.set("cursor", JSON.stringify(cursor));
  }
  return `/api/logs?${params.toString()}`;
}
