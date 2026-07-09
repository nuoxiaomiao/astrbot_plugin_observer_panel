// ============================================================================
// 视图与数值动效辅助
// ============================================================================

export const VIEW_TRANSITION_MS = 200;

/** anim-off / prefers-reduced-motion 时跳过 JS 延迟动效 */
export function shouldAnimate() {
  if (typeof document !== "undefined" && document.body?.classList.contains("anim-off")) return false;
  if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
    return false;
  }
  return true;
}

/**
 * 在两个面板容器之间做淡出/淡入切换。
 * @param {HTMLElement|null} oldView
 * @param {HTMLElement|null} newView
 * @param {{ durationMs?: number, activate?: () => void }} options
 */
export function transitionViews(oldView, newView, options = {}) {
  const activate = options.activate || (() => {});
  const durationMs = shouldAnimate() ? (options.durationMs ?? VIEW_TRANSITION_MS) : 0;

  if (!newView) {
    activate();
    return;
  }

  if (!oldView || oldView === newView || durationMs <= 0) {
    activate();
    if (newView) newView.style.opacity = "";
    if (oldView && oldView !== newView) oldView.style.opacity = "";
    return;
  }

  oldView.style.opacity = "0";
  window.setTimeout(() => {
    activate();
    newView.style.opacity = "0";
    void newView.offsetWidth;
    requestAnimationFrame(() => {
      newView.style.opacity = "1";
      window.setTimeout(() => {
        oldView.style.opacity = "";
        newView.style.opacity = "";
      }, durationMs);
    });
  }, durationMs);
}

/**
 * 进度条宽度动画，并在更新时触发一次脉冲高亮。
 */
export function animateFillWidth(fill, percent, { fromZero = false } = {}) {
  if (!fill) return;
  const target = `${Math.max(0, Math.min(100, Number(percent || 0)))}%`;
  if (!shouldAnimate()) {
    fill.style.width = target;
    fill.classList.remove("is-pulse");
    return;
  }
  if (fromZero || !fill.style.width) {
    fill.style.width = "0%";
  }
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      fill.style.width = target;
      fill.classList.remove("is-pulse");
      void fill.offsetWidth;
      fill.classList.add("is-pulse");
      window.setTimeout(() => fill.classList.remove("is-pulse"), 520);
    });
  });
}
