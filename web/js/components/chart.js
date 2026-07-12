// ============================================================================
// 组件 - 条形图
// ============================================================================

import { renderSignature, emptyBlock } from "../utils/dom.js?v=20260709-stream4";
import { animateFillWidth } from "../utils/motion.js?v=20260709-stream4";

function chartSignature(items) {
  return [
    "chart",
    items.map((item) => [
      item.label,
      item.value,
      item.scaleValue,
      item.displayValue,
      item.className,
      item.detail,
      item.unit,
    ]),
  ];
}

// ============================================================================
//  renderBarChart – 增量 DOM 复用版
//   数据变化时只更新现有行的 width/文本，不再清空重建。
//   CSS transition 在 width 变化时自动生效（同一 .bar-fill 元素）。
// ============================================================================

export function renderBarChart(id, items) {
  const el = renderSignature(id, chartSignature(items));
  if (!el) return; // 缓存命中，数据未变
  if (!items.length) {
    el.replaceChildren(emptyBlock("没有可展示的数据。"));
    return;
  }
  if (el.firstElementChild?.classList.contains("empty")) {
    el.replaceChildren();
  }
  const max = Math.max(1, ...items.map((item) => Number(item.scaleValue ?? item.value) || 0));
  const fragment = document.createDocumentFragment();

  items.forEach((item, i) => {
    let rowEl = el.children[i];
    const metricValue = Number(item.scaleValue ?? item.value) || 0;
    const pct = Math.round((metricValue / max) * 100);
    const displayValue = item.displayValue == null ? item.value : item.displayValue;
    const unit = item.unit || "行";
    const detailLabel = item.detail_label || "来源";
    const title = item.detail
      ? `${item.label}: ${displayValue} ${unit}\n${detailLabel}: ${item.detail}`
      : `${item.label}: ${displayValue} ${unit}`;

    if (!rowEl || !rowEl.classList.contains("bar-row")) {
      // ★ 新行 — 创建
      rowEl = document.createElement("div");
      rowEl.className = "bar-row";
      const label = document.createElement("span");
      label.className = "bar-label";
      const track = document.createElement("div");
      track.className = "bar-track";
      const fill = document.createElement("div");
      fill.className = `bar-fill ${item.className || ""}`;
      fill.classList.add("is-entering");
      track.appendChild(fill);
      const valueEl = document.createElement("strong");
      valueEl.textContent = displayValue;
      rowEl.append(label, track, valueEl);
      fill.style.width = "0%";
      fragment.appendChild(rowEl);
      // 新行：从零开始 JS 动画
      rowEl.style.animationDelay = `${i * 0.04}s`;
      requestAnimationFrame(() => {
        animateFillWidth(fill, pct, { fromZero: true });
        window.setTimeout(() => fill.classList.remove("is-entering"), 450);
      });
    } else {
      // ★ 已有行 — 增量更新 width（CSS transition 自动过渡）
      const fill = rowEl.querySelector(".bar-fill");
      if (fill) {
        // 只保留 data 中的 className，移除旧的 level-* / source-* 类
        fill.className = `bar-fill ${item.className || ""}`;
        fill.style.width = `${pct}%`;
      }
      rowEl.lastElementChild.textContent = displayValue;
    }
    // 公共：label / title
    rowEl.firstElementChild.textContent = item.label;
    rowEl.title = title;
    rowEl.firstElementChild.title = title;
  });

  // 移除多余旧行
  while (el.children.length > items.length) {
    el.lastChild.remove();
  }
  // 追加新行
  el.appendChild(fragment);
}
