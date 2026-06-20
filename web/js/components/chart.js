// ============================================================================
// 组件 - 条形图
// ============================================================================

import { renderSignature, emptyBlock } from "../utils/dom.js?v=20260620-renderfix1";

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

export function renderBarChart(id, items) {
  const el = renderSignature(id, chartSignature(items));
  if (!el) return;
  el.innerHTML = "";
  if (!items.length) {
    el.appendChild(emptyBlock("没有可展示的数据。"));
    return;
  }
  const max = Math.max(1, ...items.map((item) => Number(item.scaleValue ?? item.value) || 0));
  const fragment = document.createDocumentFragment();
  items.forEach((item) => {
    const rowEl = document.createElement("div");
    rowEl.className = "bar-row";
    const metricValue = Number(item.scaleValue ?? item.value) || 0;
    const displayValue = item.displayValue == null ? item.value : item.displayValue;
    const unit = item.unit || "行";
    const detailLabel = item.detail_label || "来源";
    const title = item.detail ? `${item.label}: ${displayValue} ${unit}\n${detailLabel}: ${item.detail}` : `${item.label}: ${displayValue} ${unit}`;
    rowEl.title = title;
    const label = document.createElement("span");
    label.className = "bar-label";
    label.textContent = item.label;
    label.title = title;
    const track = document.createElement("div");
    track.className = "bar-track";
    const fill = document.createElement("div");
    fill.className = `bar-fill ${item.className || ""}`;
    fill.style.width = `${Math.round((metricValue / max) * 100)}%`;
    track.appendChild(fill);
    const value = document.createElement("strong");
    value.textContent = displayValue;
    rowEl.append(label, track, value);
    fragment.appendChild(rowEl);
  });
  el.appendChild(fragment);
}
