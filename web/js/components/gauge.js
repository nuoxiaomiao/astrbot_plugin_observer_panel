// ============================================================================
// 组件 - 仪表盘（增量更新版）
// ============================================================================

import { formatPercent, usageKind } from "../utils/format.js?v=20260708-telemetry1";

/**
 * 渲染/更新资源使用率仪表盘（增量 DOM 复用）
 * @param {HTMLElement} parent - 父元素
 * @param {string} label - 标签
 * @param {number} value - 百分比值
 * @param {string} meta - 元数据描述
 * @param {string} kind - 状态类型
 */
export function renderGauge(parent, label, value, meta, kind = usageKind(value)) {
  const key = `gauge:${label}`;
  let item = parent.querySelector(`[data-gauge-key="${key}"]`);

  if (!item) {
    // ★ 新元素 — 创建
    item = document.createElement("div");
    item.dataset.gaugeKey = key;
    item.className = `resource-card ${kind}`;
    item.innerHTML = `
      <div class="resource-head">
        <span>${escHtml(label)}</span>
        <strong>${formatPercent(value)}</strong>
      </div>
      <div class="usage-track"><div class="usage-fill"></div></div>
      <small>${escHtml(meta || "--")}</small>
    `;
    parent.appendChild(item);
  } else {
    // ★ 更新现有元素 — width 由 CSS transition 驱动
    item.className = `resource-card ${kind}`;
    item.querySelector(".resource-head strong").textContent = formatPercent(value);
    const fill = item.querySelector(".usage-fill");
    fill.style.width = `${Math.max(0, Math.min(100, Number(value || 0)))}%`;
    item.querySelector("small").textContent = meta || "--";
  }
}

function escHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str ?? "");
  return div.innerHTML;
}