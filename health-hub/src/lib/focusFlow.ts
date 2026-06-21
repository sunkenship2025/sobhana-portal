import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

// Ordered keyboard focus-flow for data-entry forms.
//
// Every participating control is tagged with `data-focus-step="<n>"`. The
// "next step" is resolved LIVE from the DOM on every call, so conditionally
// rendered or disabled steps are automatically included or excluded — there is
// no static field list to keep in sync. Advancement retries on the next few
// animation frames so a step that is still being committed by React (e.g. a
// conditionally-rendered field) is reached without guessing a setTimeout delay.

const STEP_SELECTOR = '[data-focus-step]';

interface Step {
  el: HTMLElement;
  step: number;
}

function isFocusable(el: HTMLElement): boolean {
  if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return false;
  if (el.hasAttribute('readonly') || el.hidden) return false;
  // offsetParent === null catches display:none and unmounted-in-collapsed-parent.
  if (el.offsetParent === null) return false;
  return true;
}

function orderedSteps(scope: ParentNode = document): Step[] {
  return Array.from(scope.querySelectorAll<HTMLElement>(STEP_SELECTOR))
    .map((el) => ({ el, step: Number(el.dataset.focusStep) }))
    .filter((c) => Number.isFinite(c.step))
    .sort((a, b) => a.step - b.step);
}

// Scroll the target into view only when it is not comfortably inside the
// viewport, so big jumps (e.g. test search -> billing further down) bring the
// next field into view, while small intra-card moves don't jar the page.
function ensureVisible(el: HTMLElement) {
  const rect = el.getBoundingClientRect();
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const margin = 120; // keep clear of sticky headers / page edges
  if (rect.top < margin || rect.bottom > vh - margin) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function focusEl(el: HTMLElement) {
  // preventScroll so we control scrolling via ensureVisible (focus()'s default
  // 'nearest' scroll leaves far-away targets pinned to the viewport edge).
  el.focus({ preventScroll: true });
  ensureVisible(el);
  if (el instanceof HTMLInputElement && el.type !== 'date') el.select?.();
}

/**
 * Focus the step whose number is exactly `target`. If it is not yet focusable
 * (its conditional render is still committing) retry on the next animation
 * frame up to `maxFrames` times, then give up silently (safe no-op).
 */
export function goToStep(target: number, maxFrames = 5): void {
  const attempt = (framesLeft: number) => {
    const match = orderedSteps().find((c) => c.step === target && isFocusable(c.el));
    if (match) {
      focusEl(match.el);
      return;
    }
    if (framesLeft > 0) requestAnimationFrame(() => attempt(framesLeft - 1));
  };
  attempt(maxFrames);
}

/**
 * Focus the first focusable step whose number is strictly greater than
 * `fromStep`. Retries across animation frames like `goToStep`.
 */
export function goToNext(fromStep: number, maxFrames = 5): void {
  const advance = (framesLeft: number) => {
    const next = orderedSteps().find((c) => c.step > fromStep && isFocusable(c.el));
    if (next) {
      focusEl(next.el);
      return;
    }
    if (framesLeft > 0) requestAnimationFrame(() => advance(framesLeft - 1));
  };
  advance(maxFrames);
}

/** Focus the last focusable step strictly before `fromStep` (Escape = step back). */
export function goToPrev(fromStep: number): void {
  const prev = [...orderedSteps()].reverse().find((c) => c.step < fromStep && isFocusable(c.el));
  if (prev) focusEl(prev.el);
}

/**
 * Uniform Enter handler for simple fields. Enter (and Shift+Enter, the
 * documented "skip" alias) advances to the next step; Escape steps back.
 * Reads the step number off the element's own `data-focus-step`.
 */
export function handleFlowKey(e: ReactKeyboardEvent<HTMLElement>): void {
  // Ignore key auto-repeat (holding Enter) — otherwise it advances several
  // steps at once and queues cascading scroll animations.
  if (e.repeat) return;
  const step = Number((e.currentTarget as HTMLElement).dataset.focusStep);
  if (!Number.isFinite(step)) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    goToNext(step);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    goToPrev(step);
  }
}
