# AstrBot 观察面板 · WebUI 视觉动画优化修复计划

> 编写日期：2026-07-05
> 目标文件：`astrbot_plugin_observer_panel/web/app.js`（3941行）, `astrbot_plugin_observer_panel/web/styles.css`（~3100行）
> 核心问题：CSS 动画声明已就绪，但 JS 渲染模式让动画无法生效

---

## 目录

1. [P0 - renderBarChart 增量渲染](#p0-renderbarchart-增量渲染)
2. [P0 - setText 数字渐变动画](#p0-settext-数字渐变动画)
3. [P1 - renderGauge 增量更新](#p1-rendergauge-增量更新)
4. [P1 - panels/renderSystem 重建闪烁抑制](#p1-panels-render-系统重建闪烁抑制)
5. [P2 - Tab/View 切换过渡动画](#p2-tabview-切换过渡动画)
6. [P2 - Event/Log 交错入场动画](#p2-eventlog-交错入场动画)
7. [P2 - Metric 值变化高亮脉冲](#p2-metric-值变化高亮脉冲)
8. [P2 - SSE 状态切换过渡](#p2-sse-状态切换过渡)
9. [P3 - 全局 Touch Ripple 增强](#p3-全局-touch-ripple-增强)
10. [P3 - Toast 队列与可关闭](#p3-toast-队列与可关闭)
11. [P3 - 用户可配置动画级别](#p3-用户可配置动画级别)
12. [P3 - renderSignature 缓存优化标记](#p3-rendersignature-缓存优化标记)

---

## P0 - renderBarChart 增量渲染

### 问题

`web/app.js:2645-2676` — `renderBarChart()` 每次完整重建 DOM：

```js
const el = renderSignature(id, chartSignature(items));
if (!el) return;   // 数据未变时跳过
el.innerHTML = "";  // ← 清空全部重建
// ... 创建所有 bar-row ...
fill.style.width = `${pct}%`;  // ← 新元素 → CSS transition 不触发
```

CSS `styles.css:2140` 虽有 `transition: width 0.4s cubic-bezier(...)`，但新元素从 0→目标值，不是**同一元素的属性变化**，所以过渡不触发。

### 影响范围（9 个图表全中）

| 行号 | 调用 | 所属视图 |
|:---:|:---|:---|
| 2469 | `sessionSourceChart` | AstrBot-会话来源 |
| 2473 | `personaChart` | AstrBot-规则分布 |
| 2479 | `senderChart` | AstrBot-用户活跃 |
| 2490 | `latencyChart` | AstrBot-模型耗时 |
| 2549 | `eventChart` | AstrBot-事件类型 |
| 2570 | `toolChart` | AstrBot-工具耗时 |
| 2630 | `sourceChart` | AstrBot-模块分布 |
| 2636 | `pluginChart` | AstrBot-插件分布 |
| 2642 | `toolCallChart` | AstrBot-工具调用 |

### 修复方案

将 `renderBarChart` 改为**原地增量更新**，复用已有 DOM 节点：

```js
function renderBarChart(id, items) {
  const el = renderSignature(id, chartSignature(items));
  if (!el) return;  // 数据未变，跳过（缓存生效）
  if (!items.length) {
    el.replaceChildren(emptyBlock("没有可展示的数据。"));
    return;
  }
  const max = Math.max(1, ...items.map(item => Number(item.scaleValue ?? item.value) || 0));
  const fragment = document.createDocumentFragment();

  items.forEach((item, i) => {
    let rowEl = el.children[i];
    const metricValue = Number(item.scaleValue ?? item.value) || 0;
    const pct = Math.round((metricValue / max) * 100);

    if (!rowEl) {
      rowEl = document.createElement("div");
      rowEl.className = "bar-row";
      rowEl.innerHTML = `
        <span class="bar-label">${escHtml(item.label)}</span>
        <div class="bar-track">
          <div class="bar-fill ${item.className || ''}"></div>
        </div>
        <strong>${item.displayValue ?? item.value}</strong>
      `;
      fragment.appendChild(rowEl);
    }
    // ★ 复用 fill，更新 width → CSS transition 生效！
    const fill = rowEl.querySelector('.bar-fill');
    fill.style.width = `${pct}%`;
    rowEl.lastElementChild.textContent = item.displayValue ?? item.value;
  });

  // 移除多余旧行
  while (el.children.length > items.length) el.lastChild.remove();
  // 追加新增行
  el.appendChild(fragment);
}
```

### CSS 确认/补充

在 `styles.css` 中找到 `.bar-fill` 块（约 L2140），确保包含：

```css
.bar-fill {
  transition: width 0.6s cubic-bezier(0.34, 1.56, 0.64, 1);
  contain: layout;
}
```

---

## P0 - setText 数字渐变动画

### 问题

`web/app.js:369-371` — `setText()` 直接替换 `textContent`：

```js
function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value == null || value === "" ? "--" : String(value);
}
```

`renderSummary`（L587）中连续调用 setText（L608-623），每 5s 刷新时顶栏数值瞬间跳跃。

### 影响位置

| 行号 | 内容 | 动画化 |
|:---:|:---|:---:|
| 608 | subtitle → 地址/运行时间 | ❌ 文本类不动 |
| 609 | systemState → 诊断状态 | ❌ 文本类不动 |
| 611 | **cpuState → CPU 百分比** | ✅ 数字 |
| 613 | **memoryState → 内存百分比** | ✅ 数字 |
| 618 | **logsState → 错误计数** | ✅ 数字 |

### 修复方案

新增 `setTextAnimated()`，保留 `setText` 做静默设置：

```js
/**
 * 带数字渐变效果的 setText
 * @param {string} id - 元素 ID
 * @param {string|number} rawValue - 新值
 * @param {number} duration - 动画时长 ms，默认 400
 */
function setTextAnimated(id, rawValue, duration = 400) {
  const el = $(id);
  if (!el) return;
  const strVal = rawValue == null || rawValue === "" ? "--" : String(rawValue);

  // 非数字 → 直接设
  const numMatch = strVal.match(/^(-?\d+(?:\.\d+)?)/);
  if (!numMatch) { el.textContent = strVal; return; }

  const current = parseFloat(el.textContent) || 0;
  const target = parseFloat(numMatch[1]);
  if (Math.abs(target - current) < 0.3) { el.textContent = strVal; return; }

  const suffix = strVal.slice(numMatch[1].length); // 保持 "%" 等单位
  const startTime = performance.now();

  const tick = (now) => {
    const t = Math.min((now - startTime) / duration, 1);
    const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
    const val = current + (target - current) * eased;
    el.textContent = val.toFixed(1) + suffix;
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
```

修改 `renderSummary` 中对应行：

```js
// 修改前                        → 修改后
setText("cpuState", ...)        → setTextAnimated("cpuState", ..., 500)
setText("memoryState", ...)     → setTextAnimated("memoryState", ..., 500)
setText("logsState", ...)       → setTextAnimated("logsState", ..., 400)
```

---

## P1 - renderGauge 增量更新

### 问题

`web/app.js:558-577` — `renderGauge()` 每次重建：

```js
function renderGauge(parent, label, value, meta, kind = usageKind(value)) {
  const item = document.createElement("div");  // ← 每次都新建
  // ...
  fill.style.width = `${val}%`;  // ← 新元素，transition 不触发
}
```

同样 `renderSummary`(L641-665) 资源阈值卡片也重建。

### 修复方案

给 gauge 容器附加 `data-gauge-key` 做 DOM 匹配：

```js
function renderGauge(parent, label, value, meta, kind = usageKind(value)) {
  const key = `gauge:${label}`;
  let item = parent.querySelector(`[data-gauge-key="${key}"]`);

  if (!item) {
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
    // ★ 更新现有元素
    item.className = `resource-card ${kind}`;
    item.querySelector('.resource-head strong').textContent = formatPercent(value);
    const fill = item.querySelector('.usage-fill');
    fill.style.width = `${Math.max(0, Math.min(100, Number(value || 0)))}%`;
    item.querySelector('small').textContent = meta || "--";
  }
}
```

### CSS 补充

```css
.usage-fill {
  transition: width 0.6s cubic-bezier(0.4, 0, 0.2, 1),
              box-shadow 0.3s ease;
}
```

---

## P1 - panels / render 系统重建闪烁抑制

### 问题

`app.js` 中 11 处 `innerHTML = ""` + `appendChild` 模式：

| 行号 | 所在函数 | 说明 |
|:---:|:---|:---|
| 641 | renderSummary | resourceOverview 重建 |
| 709 | renderKv | 所有 kv 列表重建 |
| 856 | renderSystem | diskList 重建 |
| 877 | renderSystem | networkList 重建 |
| 2205 | renderEventList | 事件列表重建 |
| 2282 | renderEventList | detailBody 重建 |
| 2441 | renderOverviewTrace | bigScreenCards 重建 |
| 2648 | renderBarChart | ✅ 已由 P0 修复 |
| 2691/2738 | renderLogStream | 日志流（特殊保留） |
| 4214 | loading tools | 通用 loading |

### 修复方案

**优先修复** `renderKv`（L706-718），改为 key 匹配增量更新：

```js
function renderKv(id, entries) {
  const el = $(id);
  if (!el) return;

  // 建立现有行索引
  const existing = new Map();
  el.querySelectorAll('.kv-row').forEach(row => {
    const k = row.dataset.kvKey;
    if (k) existing.set(k, row);
  });

  const fragment = document.createDocumentFragment();
  Object.entries(entries).forEach(([key, value]) => {
    let row = existing.get(key);
    if (!row) {
      row = document.createElement("div");
      row.className = "kv-row";
      row.dataset.kvKey = key;
      row.innerHTML = '<span class="kv-key"></span><span class="kv-value"></span>';
      fragment.appendChild(row);
    }
    row.querySelector('.kv-key').textContent = key;
    row.querySelector('.kv-value').textContent = value == null ? "--" : String(value);
    existing.delete(key);
  });

  // 移除多余旧行
  existing.forEach(row => row.remove());
  // 追加新行
  el.appendChild(fragment);
}
```

**其他列表**（diskList/networkList）同理，添加 `data-stack-key` 做匹配。

### CSS 补充

```css
.panel, .kv, .bar-chart, .resource-grid, .stack-list {
  contain: layout paint;
  min-height: 40px;  /* 防止清空时高度坍塌 */
}
```

---

## P2 - Tab/View 切换过渡动画

### 问题

`web/app.js:2957-2976` — `selectTab()` 直接 `classList.toggle`，瞬间显隐：

```js
view.classList.toggle("active", active);
view.hidden = !active;  // ← 无过渡
```

### 修复方案

CSS：

```css
.view {
  display: none;
  opacity: 0;
  transform: translateY(8px);
}

.view.active {
  display: block;
  animation: viewFadeIn 0.35s ease-out both;
}

@keyframes viewFadeIn {
  from { opacity: 0; transform: translateY(12px); }
  to   { opacity: 1; transform: translateY(0); }
}

.view.leaving {
  animation: viewFadeOut 0.2s ease-in both;
}

@keyframes viewFadeOut {
  from { opacity: 1; transform: translateY(0); }
  to   { opacity: 0; transform: translateY(-8px); }
}
```

JS：

```js
function selectTab(name) {
  const oldView = document.querySelector('.view.active');
  if (oldView && oldView.id !== name) {
    oldView.classList.add('leaving');
    setTimeout(() => oldView.classList.remove('leaving'), 200);
  }
  state.activeTab = name;
  // ... 其余 classList toggle ...
}
```

---

## P2 - Event/Log 交错入场动画

### 问题

`renderEventList`(L2201) 和 `renderLogStream`(L2682) 所有条目同时出现。

### 修复方案

CSS 交错：

```css
.event-item {
  animation: fadeInUp 0.3s ease-out both;
}

.event-item:nth-child(1)  { animation-delay: 0ms; }
.event-item:nth-child(2)  { animation-delay: 25ms; }
.event-item:nth-child(3)  { animation-delay: 50ms; }
.event-item:nth-child(4)  { animation-delay: 75ms; }
.event-item:nth-child(5)  { animation-delay: 100ms; }
.event-item:nth-child(6)  { animation-delay: 125ms; }
.event-item:nth-child(7)  { animation-delay: 150ms; }
.event-item:nth-child(8)  { animation-delay: 175ms; }
.event-item:nth-child(9)  { animation-delay: 200ms; }
.event-item:nth-child(10) { animation-delay: 225ms; }

.log-entry {
  animation: slideInFromLeft 0.25s ease-out both;
}

@keyframes slideInFromLeft {
  from { opacity: 0; transform: translateX(-6px); }
  to   { opacity: 1; transform: translateX(0); }
}
```

---

## P2 - Metric 值变化高亮脉冲

### 问题

Metric 卡片数值更新时无视觉反馈。

### 修复方案

CSS：

```css
@keyframes metricPulse {
  0%   { background-color: transparent; }
  25%  { background-color: rgba(76, 154, 255, 0.12); }
  100% { background-color: transparent; }
}

.metric-value.updated {
  animation: metricPulse 0.8s ease-out;
}
```

在 `setTextAnimated` 完成后触发：

```js
// 动画完成时
el.textContent = strVal;
el.classList.remove('updated');
void el.offsetWidth; // 重播动画
el.classList.add('updated');
setTimeout(() => el.classList.remove('updated'), 800);
```

---

## P2 - SSE 状态切换过渡

### 问题

`web/app.js:3714-3724` 直接设 `dot.style.background`，无过渡。

### 修复方案

**移除内联 style 设置**，全由 CSS 类控制（L3743-3744 已有 classList 切换）：

```css
.sse-dot {
  transition: background 0.4s ease,
              box-shadow 0.4s ease,
              transform 0.3s ease;
}

@keyframes statusPop {
  0%   { transform: scale(0.5); opacity: 0; }
  60%  { transform: scale(1.3); }
  100% { transform: scale(1); opacity: 1; }
}

.sse-status-connected .sse-dot,
.sse-status-disconnected .sse-dot {
  animation: statusPop 0.4s ease;
}
```

JS 修改（L3714-3724）：

```js
// 修改前
dot.style.background = "var(--accent-bright)";
dot.style.boxShadow = "0 0 0 4px rgba(...)";

// 修改后 — 删除这些行，全由 CSS 类控制
```

---

## P3 - 全局 Touch Ripple 增强

### 问题

Ripple 仅作用于按钮（`styles.css:169-207`），Metric/EventItem/Tab 等无触摸反馈。

### 修复方案

`app.js` 末尾添加：

```js
/**
 * 全局触摸缩放反馈
 */
document.addEventListener('pointerdown', (e) => {
  const target = e.target.closest(
    '.metric[data-jump], .event-item.selectable, .tab, ' +
    '.subtab, .action-btn, .event-filter, .level-filter, .time-filter'
  );
  if (!target || target.closest('button')) return;
  target.style.transition = 'transform 0.1s ease-out';
  target.style.transform = 'scale(0.97)';
}, { passive: true });

document.addEventListener('pointerup', () => {
  document.querySelectorAll(
    '.metric[data-jump], .event-item.selectable, .tab, ' +
    '.subtab, .action-btn, .event-filter, .level-filter, .time-filter'
  ).forEach(el => { el.style.transform = ''; });
}, { passive: true });

document.addEventListener('pointerleave', () => {
  document.querySelectorAll('[style*="scale(0.97)"]').forEach(el => {
    el.style.transform = '';
  });
}, { passive: true });
```

CSS：

```css
.metric[data-jump], .event-item.selectable {
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  user-select: none;
}
```

---

## P3 - Toast 队列与可关闭

### 问题

`web/app.js:376-383` — toast 覆盖前一条，无法手动关闭。

### 修复方案

```js
const toastQueue = [];
let toastTimer = null;

function toast(message, duration = 3200) {
  toastQueue.push(message);
  if (toastQueue.length > 1) return;
  showNextToast(duration);
}

function showNextToast(duration) {
  if (toastQueue.length === 0) return;
  const el = $("toast");
  el.textContent = toastQueue[0];
  el.classList.add("show");

  el.onclick = () => {
    el.classList.remove("show");
    toastQueue.shift();
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => showNextToast(duration), 200);
  };

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove("show");
    toastQueue.shift();
    setTimeout(() => showNextToast(duration), 200);
  }, duration);
}
```

---

## P3 - 用户可配置动画级别

### 问题

已有 `@media (prefers-reduced-motion)` 系统级支持，但无 UI 开关。

### 修复方案

**HTML**（`index.html` 头部 actions 区）：

```html
<button id="animToggle" type="button" class="action-btn"
        title="切换动画强度" aria-pressed="false">✨ 完整</button>
```

**CSS**：

```css
body.anim-off *,
body.anim-off *::before,
body.anim-off *::after {
  animation-duration: 0.01ms !important;
  animation-iteration-count: 1 !important;
  transition-duration: 0.01ms !important;
}

body.anim-medium .panel:hover { transform: none; }
body.anim-medium .event-item { animation: none; }
```

**JS**（`app.js` 末尾）：

```js
const ANIM_LEVELS = ['full', 'medium', 'off'];
let animLevel = 0;

function toggleAnimLevel() {
  animLevel = (animLevel + 1) % ANIM_LEVELS.length;
  const level = ANIM_LEVELS[animLevel];
  document.body.classList.remove('anim-full', 'anim-medium', 'anim-off');
  document.body.classList.add(`anim-${level}`);

  const btn = $('animToggle');
  const labels = { full: '✨ 完整', medium: '⚡ 适中', off: '🚫 关闭' };
  btn.textContent = labels[level];
  btn.setAttribute('aria-pressed', animLevel > 0);
  try { localStorage.setItem('observer_anim_level', level); } catch {}
}

function initAnimLevel() {
  try {
    const saved = localStorage.getItem('observer_anim_level');
    if (saved) {
      const idx = ANIM_LEVELS.indexOf(saved);
      if (idx >= 0) animLevel = idx;
    }
  } catch {}
  document.body.classList.add(`anim-${ANIM_LEVELS[animLevel]}`);
}
```

---

## 实施路线图

```
批号 | 优先级 | 涉及文件                   | 修改范围                 | 预估工时
─────|────────|────────────────────────────|──────────────────────────|────────
A    | 🔴 P0  | web/app.js:2645-2676       | renderBarChart 增量渲染  | 1.5h
B    | 🔴 P0  | web/app.js:369-371,587-623  | setTextAnimated 数字渐变  | 1.0h
C    | 🟠 P1  | web/app.js:558-577,641-665  | renderGauge 增量更新     | 1.0h
D    | 🟠 P1  | web/app.js:706-718,856-877  | renderKv/renderSystem    | 1.0h
E    | 🟡 P2  | web/app.js:2957-2976 + CSS  | Tab 切换过渡             | 0.5h
F    | 🟡 P2  | web/styles.css              | Event/Log 交错入场       | 0.5h
G    | 🟡 P2  | web/app.js + CSS            | Metric 高亮 + SSE 过渡   | 0.5h
H    | 🟢 P3  | web/app.js 末尾 + CSS       | Touch Ripple             | 0.5h
I    | 🟢 P3  | web/app.js + CSS + HTML     | Toast 队列 + 动画开关    | 1.0h
                                                     ─────────
                                                     总计 ~7.5h
```

---

## 实施顺序建议

```
Week 1: A → B    (P0，动画失效的根因修复)
Week 2: C → D    (P1，消除闪烁)
Week 3: E → F → G (P2，交互过渡)
Week 4: H → I    (P3，增强体验)
```

---

## 自检清单

实施后逐项验证：

- [ ] Bar Chart 数据变化时，进度条从旧值平滑过渡到新值
- [ ] 顶栏 CPU/内存数值渐变而非跳跃
- [ ] 使用率进度条宽度有过渡动画
- [ ] 面板内 Kv/列表内容刷新无白屏闪烁
- [ ] Tab 切换有淡入淡出效果
- [ ] 新增 Event/Log 条目从上到下交错入场
- [ ] Metric 值变化时短暂高亮
- [ ] SSE 连接状态切换有颜色过渡
- [ ] 触摸操作有缩放反馈
- [ ] Toast 可点击关闭，多条消息排队显示
- [ ] 动画级别切换生效，`prefers-reduced-motion` 仍正常工作
- [ ] 移动端无性能退化，FPS 稳定
- [ ] 原有 renderSignature 签名缓存未被破坏
- [ ] 所有改动未引入 XSS（转义函数 `escHtml` 确保使用）
