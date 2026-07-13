// ============================================================================
// 视图与数值动效辅助
// ============================================================================

export const VIEW_TRANSITION_MS = 180;

/**
 * 动效档位：
 * - enter: 入场 stagger / 视图淡入 → 仅 full
 * - feedback: 数值脉冲、条宽、highlight → full + medium
 * - loop: 无限循环装饰 → 仅 full
 * - any: 非 off 即可
 */
export function getAnimLevel() {
  if (typeof document === "undefined") return "full";
  const body = document.body;
  if (!body) return "full";
  if (body.classList.contains("anim-off")) return "off";
  if (body.classList.contains("anim-medium")) return "medium";
  return "full";
}

/** @param {"enter"|"feedback"|"loop"|"any"} [tier="any"] */
export function shouldAnimate(tier = "any") {
  if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
    return false;
  }
  const level = getAnimLevel();
  if (level === "off") return false;
  if (tier === "any" || tier === "feedback") return level === "full" || level === "medium";
  if (tier === "enter" || tier === "loop") return level === "full";
  return level === "full" || level === "medium";
}

/**
 * 视图切换：仅切换 active/hidden（由 CSS .view.active 负责淡入）。
 * 不再用 JS 改 opacity，避免与 CSS 双轨叠化。
 * @param {HTMLElement|null} oldView
 * @param {HTMLElement|null} newView
 * @param {{ durationMs?: number, activate?: () => void }} options
 */
export function transitionViews(oldView, newView, options = {}) {
  const activate = options.activate || (() => {});

  if (oldView && oldView !== newView && shouldAnimate("enter")) {
    oldView.classList.add("leaving");
    window.setTimeout(() => oldView.classList.remove("leaving"), VIEW_TRANSITION_MS);
  }

  activate();

  if (oldView && oldView !== newView) {
    oldView.style.opacity = "";
  }
  if (newView) {
    newView.style.opacity = "";
  }
}

/**
 * 进度条宽度动画，并在更新时触发一次脉冲高亮。
 */
export function animateFillWidth(fill, percent, { fromZero = false } = {}) {
  if (!fill) return;
  const target = `${Math.max(0, Math.min(100, Number(percent || 0)))}%`;
  if (!shouldAnimate("feedback")) {
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