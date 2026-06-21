// ============================================================================
// 组件 - 仪表盘
// ============================================================================

import { formatPercent, usageKind } from "../utils/format.js?v=20260621-flow3";

/**
 * 渲染资源使用率仪表盘
 * @param {HTMLElement} parent - 父元素
 * @param {string} label - 标签
 * @param {number} value - 百分比值
 * @param {string} meta - 元数据描述
 * @param {string} kind - 状态类型
 */
export function renderGauge(parent, label, value, meta, kind = usageKind(value)) {
  const item = document.createElement("div");
  item.className = `resource-card ${kind}`;
  const head = document.createElement("div");
  head.className = "resource-head";
  const title = document.createElement("span");
  title.textContent = label;
  const number = document.createElement("strong");
  number.textContent = formatPercent(value);
  head.append(title, number);
  const track = document.createElement("div");
  track.className = "usage-track";
  const fill = document.createElement("div");
  fill.className = "usage-fill";
  fill.style.width = `${Math.max(0, Math.min(100, Number(value || 0)))}%`;
  track.appendChild(fill);
  const foot = document.createElement("small");
  foot.textContent = meta || "--";
  item.append(head, track, foot);
  parent.appendChild(item);
}
