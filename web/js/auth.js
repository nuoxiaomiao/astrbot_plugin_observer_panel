// ============================================================================
// 面板登录门禁：界面密码 → Cookie；401 回登录
// ============================================================================

import { state } from "./state.js?v=20260709-stream4";
import { $, toast } from "./utils/dom.js?v=20260709-stream4";
import { clearAuthToken, getAuthToken } from "./config.js?v=20260709-stream4";

/** @type {{ stopPolling?: () => void, startApp?: () => Promise<void> } | null} */
let hooks = null;
let unauthorizedNotified = false;

export function bindAuthHooks(nextHooks) {
  hooks = nextHooks || null;
}

export function isAuthGateVisible() {
  const gate = $("authGate");
  return Boolean(gate && !gate.hidden);
}

export function showAuthGate(message = "") {
  const gate = $("authGate");
  const shell = document.querySelector("main.shell");
  if (shell) shell.setAttribute("aria-hidden", "true");
  if (gate) {
    gate.hidden = false;
    gate.setAttribute("aria-hidden", "false");
  }
  document.body.classList.add("auth-locked");
  setAuthError(message);
  const input = $("authPassword");
  if (input) {
    input.value = "";
    window.setTimeout(() => input.focus(), 30);
  }
  const logoutBtn = $("logoutBtn");
  if (logoutBtn) logoutBtn.hidden = true;
}

export function hideAuthGate() {
  const gate = $("authGate");
  const shell = document.querySelector("main.shell");
  if (shell) shell.removeAttribute("aria-hidden");
  if (gate) {
    gate.hidden = true;
    gate.setAttribute("aria-hidden", "true");
  }
  document.body.classList.remove("auth-locked");
  setAuthError("");
  unauthorizedNotified = false;
  const logoutBtn = $("logoutBtn");
  if (logoutBtn) logoutBtn.hidden = !Boolean(state.config?.has_access_token);
}

export function setAuthError(message) {
  const el = $("authError");
  if (!el) return;
  el.textContent = message || "";
  el.hidden = !message;
}

export function handleUnauthorized(message = "请输入访问密码") {
  clearAuthToken();
  if (hooks?.stopPolling) hooks.stopPolling();
  showAuthGate(message);
  if (!unauthorizedNotified) {
    unauthorizedNotified = true;
    toast(message);
  }
}

async function postJson(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(text.slice(0, 180) || `HTTP ${res.status}`);
  }
  if (!res.ok || payload.ok === false) {
    throw new Error(payload.error || `HTTP ${res.status}`);
  }
  return payload;
}

export async function loginWithPassword(password) {
  const value = String(password || "").trim();
  if (!value) {
    setAuthError("请输入访问密码");
    return false;
  }
  setAuthError("");
  const submit = $("authSubmit");
  if (submit) submit.disabled = true;
  try {
    await postJson("/api/login", { password: value });
    hideAuthGate();
    if (hooks?.startApp) await hooks.startApp();
    return true;
  } catch (err) {
    setAuthError(err?.message || "登录失败");
    return false;
  } finally {
    if (submit) submit.disabled = false;
  }
}

export async function logout() {
  try {
    await postJson("/api/logout", {});
  } catch {
    // 清本地态即可
  }
  clearAuthToken();
  if (hooks?.stopPolling) hooks.stopPolling();
  showAuthGate("已退出登录");
}

/**
 * 启动门禁：
 * - 有 URL token：拼到 config 探测请求（兼容旧书签），成功后清 query
 * - 有 Cookie：/api/config 成功则进面板
 * - 否则显示登录层
 */
export async function bootstrapAuth() {
  try {
    const probePath = withTokenPath("/api/config");
    const headers = {};
    const token = getAuthToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(probePath, {
      credentials: "same-origin",
      headers,
    });
    if (res.status === 401) {
      showAuthGate("请输入访问密码");
      return { authed: false };
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text.slice(0, 120) || `HTTP ${res.status}`);
    }
    const payload = await res.json();
    if (payload?.ok === false) {
      showAuthGate(payload.error || "请输入访问密码");
      return { authed: false };
    }
    state.config = payload.data;
    hideAuthGate();
    return { authed: true, config: payload.data };
  } catch (err) {
    const msg = err?.message || String(err);
    if (/未授权|密码|401/i.test(msg)) {
      showAuthGate("请输入访问密码");
      return { authed: false };
    }
    // 网络/5xx：不假定已登录，避免空壳面板
    showAuthGate(`无法验证登录状态：${msg}`);
    return { authed: false, error: msg };
  }
}

function withTokenPath(path) {
  const url = new URL(path, window.location.origin);
  const token = getAuthToken();
  if (token) url.searchParams.set("token", token);
  return url.pathname + url.search;
}

export function bindAuthUi() {
  const form = $("authForm");
  if (form) {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const input = $("authPassword");
      loginWithPassword(input?.value || "");
    });
  }
  const logoutBtn = $("logoutBtn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", () => {
      logout();
    });
    logoutBtn.hidden = true;
  }
}