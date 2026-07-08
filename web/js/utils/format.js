// ============================================================================
// 工具函数 - 格式化
// ============================================================================

import { DIAGNOSTIC_LEVELS } from "../config.js?v=20260708-telemetry1";

/**
 * 格式化字节大小
 * @param {number} size - 字节数
 * @returns {string} 格式化后的字符串
 */
export function formatBytes(size) {
  const number = Number(size || 0);
  if (!Number.isFinite(number)) return "--";
  const units = ["B", "KB", "MB", "GB"];
  let value = number;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

/**
 * 格式化百分比
 * @param {number} value - 百分比值
 * @returns {string} 格式化后的字符串
 */
export function formatPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return `${number.toFixed(number >= 10 ? 1 : 2)}%`;
}

/**
 * 格式化数字
 * @param {number} value - 数字
 * @returns {string} 格式化后的字符串
 */
export function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return new Intl.NumberFormat("zh-CN").format(number);
}

/**
 * 格式化时间戳
 * @param {number} msOrSeconds - 毫秒或秒时间戳
 * @returns {string} 格式化后的时间字符串
 */
export function formatTime(msOrSeconds) {
  if (!msOrSeconds) return "--";
  const value = Number(msOrSeconds);
  const ms = value > 10_000_000_000 ? value : value * 1000;
  return new Date(ms).toLocaleString("zh-CN");
}

export function formatLogTime(entry) {
  if (entry.timestamp) {
    return new Date(entry.timestamp).toLocaleString("zh-CN", { hour12: false });
  }
  if (entry.fileMtime) {
    return `文件 ${formatTime(entry.fileMtime)}`;
  }
  return "--";
}

export function formatCompactLogTime(entry) {
  if (!entry.timestamp) return entry.fileMtime ? `文件 ${formatTime(entry.fileMtime)}` : "--";
  const date = new Date(entry.timestamp);
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  if (sameDay) {
    return date.toLocaleTimeString("zh-CN", { hour12: false });
  }
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${date.toLocaleTimeString("zh-CN", { hour12: false })}`;
}

/**
 * 格式化运行时长
 * @param {number} seconds - 秒数
 * @returns {string} 格式化后的时长字符串
 */
export function shortUptime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds || 0)));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d) return `${d}天 ${h}小时`;
  if (h) return `${h}小时 ${m}分钟`;
  if (m) return `${m}分钟 ${s}秒`;
  return `${s}秒`;
}

/**
 * 根据使用率判断状态类型
 * @param {number} percent - 百分比
 * @returns {string} 状态类型
 */
export function usageKind(percent) {
  const value = Number(percent || 0);
  if (value >= 90) return "bad";
  if (value >= 75) return "warn";
  return "ok";
}

export function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function boolValue(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (["1", "true", "yes", "on", "开", "是"].includes(text)) return true;
    if (["0", "false", "no", "off", "关", "否"].includes(text)) return false;
  }
  if (value == null) return fallback;
  return Boolean(value);
}

export function average(values) {
  const valid = values.map(Number).filter((value) => Number.isFinite(value));
  if (!valid.length) return 0;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

export function diagnosticLabel(status) {
  return DIAGNOSTIC_LEVELS[status]?.label || "未知";
}
