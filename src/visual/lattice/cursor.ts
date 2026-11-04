// SPDX-License-Identifier: GPL-3.0-only
// One foreground point pool: pointer orbit, rounded control outline, then back.
import { DOT_SUBSTEP_SECONDS, DotField, seededRandom } from "./dots";
import { MOTION } from "../../design/motion";

export const CURSOR_HALO_POINT_COUNT = 30;
export const CURSOR_HALO_RADIUS_PX = MOTION.cursor.radiusPx;
export const CURSOR_HALO_OUTSET_PX = 6;
const TWO_PI = Math.PI * 2;
const CONTROLS = [
  "a[href]",
  "button:not([disabled])",
  "[role='tab']",
  "[role='switch']",
  "[role='option']",
  "[role='combobox']",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[data-halo]",
].join(",");
const BLOCKED = "[data-no-halo],[inert]";

type SavedStyle = {
  element: HTMLElement;
  property: string;
  value: string;
  priority: string;
};

function saveStyle(element: HTMLElement, property: string): SavedStyle {
  return {
    element,
    property,
    value: element.style.getPropertyValue(property),
    priority: element.style.getPropertyPriority(property),
  };
}

function restoreStyle(saved: SavedStyle | null) {
  if (!saved) return;
  if (saved.value)
    saved.element.style.setProperty(
      saved.property,
      saved.value,
      saved.priority,
    );
  else saved.element.style.removeProperty(saved.property);
}

function frameOf(element: Element): HTMLElement | null {
  for (const child of element.children) {
    if (
      child instanceof HTMLElement &&
      child.classList.contains("vx-lattice-frame")
    )
      return child;
  }
  return null;
}

function nativeLayer(source: EventTarget | null): boolean {
  // A document canvas cannot paint above native top-layer surfaces. Keep their
  // own focus/frame intact rather than claim a contour the user cannot see.
  return (
    source instanceof Element &&
    Boolean(source.closest("dialog[open],[popover]"))
  );
}

function usable(element: Element): boolean {
  if (
    element.closest(`${BLOCKED},[aria-hidden='true'],[aria-disabled='true']`) ||
    element.matches(":disabled")
  )
    return false;
  const style = getComputedStyle(element);
  const bounds = element.getBoundingClientRect();
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    bounds.width > 0 &&
    bounds.height > 0
  );
}

function resolveTarget(source: EventTarget | null): HTMLElement | null {
  const element = source instanceof Element ? source : null;
  if (
    !element ||
    nativeLayer(element) ||
    element.closest(BLOCKED) ||
    element.closest("iframe")
  )
    return null;
  // A card is the interaction surface even when its inner icon/button is hit.
  for (
    let parent: Element | null = element;
    parent;
    parent = parent.parentElement
  ) {
    if (
      parent instanceof HTMLElement &&
      parent.dataset.visualOwner === "lattice" &&
      frameOf(parent) &&
      usable(parent)
    )
      return parent;
  }
  // Standalone Lens surfaces keep their glass response as the main effect.
  if (element.closest("[data-visual-owner='lens'],.vx-glass-surface"))
    return null;
  const control = element.closest(CONTROLS);
  return control instanceof HTMLElement && usable(control) ? control : null;
}

/** Equal arc-length samples, including all four rounded corners. */
function contourPoint(
  width: number,
  height: number,
  radius: number,
  phase: number,
): [number, number] {
  const r = Math.max(0.01, Math.min(radius, width / 2, height / 2));
  const horizontal = Math.max(0, width - r * 2);
  const vertical = Math.max(0, height - r * 2);
  const quarter = (Math.PI * r) / 2;
  let distance =
    (((phase % 1) + 1) % 1) * (horizontal * 2 + vertical * 2 + quarter * 4);
  const lengths = [
    horizontal,
    quarter,
    vertical,
    quarter,
    horizontal,
    quarter,
    vertical,
    quarter,
  ];
  for (let segment = 0; segment < lengths.length; segment += 1) {
    if (distance > lengths[segment]) {
      distance -= lengths[segment];
      continue;
    }
    if (segment === 0) return [r + distance, 0];
    if (segment === 2) return [width, r + distance];
    if (segment === 4) return [width - r - distance, height];
    if (segment === 6) return [0, height - r - distance];
    const corner = (segment - 1) / 2;
    const angle = -Math.PI / 2 + (corner * Math.PI) / 2 + distance / r;
    const cx = corner === 0 || corner === 1 ? width - r : r;
    const cy = corner === 0 || corner === 3 ? r : height - r;
    return [cx + Math.cos(angle) * r, cy + Math.sin(angle) * r];
  }
  return [r, 0];
}

export interface CursorHalo {
  dispose(): void;
  setEnabled(enabled: boolean): void;
}

export function mountCursorHalo(container: HTMLElement): CursorHalo | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function")
    return null;
  const fine = window.matchMedia("(any-pointer: fine)");
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const contrast = window.matchMedia("(prefers-contrast: more)");
  const forced = window.matchMedia("(forced-colors: active)");
  if (!fine.matches || reduced.matches || contrast.matches || forced.matches)
    return null;

  const canvas = document.createElement("canvas");
  canvas.className = "vx-cursor-halo";
  canvas.setAttribute("aria-hidden", "true");
  canvas.dataset.haloPoints = String(CURSOR_HALO_POINT_COUNT);
  canvas.dataset.haloState = "inactive";
  canvas.style.cssText =
    "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9999";
  let context: CanvasRenderingContext2D | null;
  try {
    context = canvas.getContext("2d");
  } catch {
    return null;
  }
  if (!context) return null;
  const g = context;
  container.append(canvas);
  const dots = new DotField(CURSOR_HALO_POINT_COUNT, seededRandom(42));
  dots.stiffness = MOTION.cursor.stiffness;
  dots.damping = MOTION.cursor.damping;

  let enabled = true;
  let disposed = false;
  let initialized = false;
  let inside = false;
  let px = 0;
  let py = 0;
  let previousTime: number | null = null;
  let frame: number | null = null;
  let target: HTMLElement | null = null;
  let pointerElement: Element | null = null;
  let keyboardElement: HTMLElement | null = null;
  let keyboardNavigation = false;
  let opacity = 1;
  let opacityFrom = 1;
  let opacityGoal = 1;
  let fadeStartedAt = 0;
  let ownedCard: HTMLElement | null = null;
  let savedFrame: SavedStyle | null = null;
  let savedOutline: SavedStyle | null = null;
  let savedOwnership: string | null = null;
  let targetObserver: MutationObserver | null = null;
  const targetResize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => schedule());

  const pointerOverLens = () => Boolean(pointerElement?.closest("[data-visual-owner='lens']"));

  function updateOpacity(now: number) {
    const progress = Math.max(0, Math.min(1, (now - fadeStartedAt) / MOTION.cursor.lensFadeMs));
    opacity = opacityFrom + (opacityGoal - opacityFrom) * progress;
  }

  function syncOpacity() {
    const now = performance.now();
    updateOpacity(now);
    // Keyboard contours and their native fallback are independent of the
    // pointer's Lens suppression, including when the pointer has stopped.
    if (keyboardElement) {
      opacity = opacityFrom = opacityGoal = 1;
      return;
    }
    const next = pointerOverLens() ? 0 : 1;
    if (opacityGoal === next) return;
    opacityFrom = opacity;
    opacityGoal = next;
    fadeStartedAt = now;
  }

  const allowed = () => {
    const root = document.documentElement;
    return (
      enabled &&
      !disposed &&
      !document.hidden &&
      fine.matches &&
      !reduced.matches &&
      !contrast.matches &&
      !forced.matches &&
      root.dataset.effects !== "lite" &&
      root.dataset.reducedMotion !== "true" &&
      root.dataset.highContrast !== "true" &&
      !document.querySelector(".vx-overture-root[data-overture-playing='true']")
    );
  };

  function releaseOwnership() {
    restoreStyle(savedFrame);
    restoreStyle(savedOutline);
    if (ownedCard) {
      if (savedOwnership === null) delete ownedCard.dataset.haloOwned;
      else ownedCard.dataset.haloOwned = savedOwnership;
    }
    savedFrame = null;
    savedOutline = null;
    ownedCard = null;
    savedOwnership = null;
  }

  function syncOwnedFrameVisibility() {
    if (!savedFrame) return;
    const focused = document.activeElement;
    const keyboardFocused = keyboardElement || focused instanceof HTMLElement &&
      target?.contains(focused) && focused.matches(":focus-visible");
    const value = keyboardFocused ? savedFrame.value : "hidden";
    const priority = keyboardFocused ? savedFrame.priority : "";
    if (savedFrame.element.style.getPropertyValue("visibility") === value &&
      savedFrame.element.style.getPropertyPriority("visibility") === priority) return;
    if (keyboardFocused) restoreStyle(savedFrame);
    else savedFrame.element.style.setProperty("visibility", "hidden");
  }

  function setTarget(next: HTMLElement | null) {
    if (target === next) { syncOwnedFrameVisibility(); return; }
    if (target) targetResize?.unobserve(target);
    releaseOwnership();
    target = next;
    observeTargetAncestry();
    if (!next) return;
    targetResize?.observe(next);
    const outline = frameOf(next);
    if (outline) {
      ownedCard = next;
      savedOwnership = next.getAttribute("data-halo-owned");
      next.dataset.haloOwned = "true";
      savedFrame = saveStyle(outline, "visibility");
      syncOwnedFrameVisibility();
    }
    dots.stagger(MOTION.cursor.staggerSeconds, (index) =>
      Math.hypot(dots.x[index] - px, dots.y[index] - py),
    );
  }

  function clear() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    previousTime = null;
    inside = false;
    initialized = false;
    pointerElement = null;
    keyboardElement = null;
    opacity = opacityFrom = opacityGoal = 1;
    setTarget(null);
    releaseOwnership();
    g.clearRect(0, 0, window.innerWidth, window.innerHeight);
    canvas.dataset.haloState = "inactive";
  }

  function initialize(x: number, y: number) {
    if (initialized) return;
    initialized = true;
    for (let index = 0; index < dots.count; index += 1) {
      const angle = (index / dots.count) * TWO_PI;
      dots.place(
        index,
        x + Math.cos(angle) * CURSOR_HALO_RADIUS_PX,
        y + Math.sin(angle) * CURSOR_HALO_RADIUS_PX,
      );
      dots.alpha[index] = 0.9;
      dots.delay[index] = 0;
    }
  }

  function schedule(resetClock = true) {
    if (frame === null && allowed() && (inside || target) && (opacity > 0 || opacityGoal > 0)) {
      if (resetClock) previousTime = performance.now();
      frame = requestAnimationFrame(tick);
    }
  }

  function tick(now: number) {
    frame = null;
    if (!allowed()) {
      clear();
      return;
    }
    if (target && nativeLayer(target)) {
      clear();
      return;
    }
    if (target && (!target.isConnected || !usable(target))) setTarget(null);
    if (!inside && !target) {
      clear();
      return;
    }
    updateOpacity(now);
    if (opacity === 0 && opacityGoal === 0) {
      g.clearRect(0, 0, window.innerWidth, window.innerHeight);
      canvas.dataset.haloState = "lens";
      return;
    }
    const elapsed =
      previousTime === null
        ? 1 / 60
        : Math.max(0, Math.min(MOTION.cursor.maxElapsedSeconds, (now - previousTime) / 1000));
    previousTime = now;
    const bounds = target?.getBoundingClientRect();
    const targetStyle = target ? getComputedStyle(target) : null;
    const pad = CURSOR_HALO_OUTSET_PX;
    const radius =
      (parseFloat(targetStyle?.borderTopLeftRadius ?? "") ||
        parseFloat(targetStyle?.borderRadius ?? "") ||
        0) + pad;
    const updateHomes = () => {
      if (bounds) {
        for (let index = 0; index < dots.count; index += 1) {
          const [x, y] = contourPoint(
            bounds.width + pad * 2,
            bounds.height + pad * 2,
            radius,
            index / dots.count,
          );
          dots.setHome(index, bounds.left - pad + x, bounds.top - pad + y, 0.95);
        }
      } else {
        for (let index = 0; index < dots.count; index += 1) {
          const angle = (index / dots.count) * TWO_PI;
          dots.setHome(
            index,
            px + Math.cos(angle) * CURSOR_HALO_RADIUS_PX,
            py + Math.sin(angle) * CURSOR_HALO_RADIUS_PX,
            0.9,
          );
        }
      }
    };
    // Advance low-FPS input by elapsed time without changing the shared field's stall cap.
    let remaining = elapsed;
    if (remaining === 0) updateHomes();
    while (remaining > 1e-9) {
      const seconds = Math.min(remaining, DOT_SUBSTEP_SECONDS);
      updateHomes();
      dots.step(seconds);
      remaining -= seconds;
    }
    const style = getComputedStyle(document.documentElement);
    const accent = style.getPropertyValue("--accent").trim() || "#b4f17a";
    const ink = style.getPropertyValue("--text-primary").trim() || "#ece7da";
    g.clearRect(0, 0, window.innerWidth, window.innerHeight);
    g.fillStyle = target ? ink : accent;
    for (let index = 0; index < dots.count; index += 1) {
      g.globalAlpha = dots.alpha[index] * opacity;
      g.beginPath();
      g.arc(
        dots.x[index],
        dots.y[index],
        (target ? 1.25 : .8) + dots.heat[index] * 0.8,
        0,
        TWO_PI,
      );
      g.fill();
    }
    if (inside && !target) {
      g.globalAlpha = 0.9 * opacity;
      g.beginPath();
      g.arc(px, py, 2.2, 0, TWO_PI);
      g.fill();
    }
    g.globalAlpha = 1;
    if (
      keyboardElement &&
      target &&
      !savedOutline &&
      dots.x.every(
        (x, index) =>
          Math.hypot(x - dots.homeX[index], dots.y[index] - dots.homeY[index]) <
          6,
      )
    ) {
      savedOutline = saveStyle(keyboardElement, "outline");
      keyboardElement.style.setProperty("outline", "none");
    }
    canvas.dataset.haloState = target
      ? keyboardElement
        ? "focus"
        : "target"
      : "pointer";
    if (opacity !== opacityGoal || dots.moving() || dots.heat.some(value => value > MOTION.cursor.settleHeat)) schedule(false);
  }

  function move(event: PointerEvent) {
    if (event.pointerType === "touch" || !allowed()) return;
    if (
      nativeLayer(event.target) ||
      (event.target instanceof Element && event.target.closest("iframe"))
    ) {
      clear();
      return;
    }
    px = event.clientX;
    py = event.clientY;
    inside = true;
    pointerElement = event.target instanceof Element ? event.target : null;
    keyboardNavigation = false;
    keyboardElement = null;
    restoreStyle(savedOutline);
    savedOutline = null;
    initialize(px, py);
    syncOpacity();
    setTarget(pointerOverLens() ? null : resolveTarget(pointerElement));
    schedule();
  }

  function press(event: PointerEvent) {
    if (nativeLayer(event.target)) {
      clear();
      return;
    }
    if (event.pointerType === "touch" || !allowed() || (!inside && !target) || (!keyboardElement && pointerOverLens()))
      return;
    const bounds = target?.getBoundingClientRect();
    dots.burst(
      bounds ? bounds.left + bounds.width / 2 : px,
      bounds ? bounds.top + bounds.height / 2 : py,
      180,
    );
    schedule();
  }

  function focusIn(event: FocusEvent) {
    const element = event.target;
    if (nativeLayer(element)) {
      clear();
      return;
    }
    if (!(element instanceof HTMLElement) || !allowed()) return;
    if (!keyboardNavigation && !element.matches(":focus-visible")) return;
    const next = resolveTarget(element);
    if (!next) return;
    restoreStyle(savedOutline);
    savedOutline = null;
    keyboardElement = element;
    syncOpacity();
    const bounds = next.getBoundingClientRect();
    initialize(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
    setTarget(next);
    schedule();
  }

  function focusOut(event: FocusEvent) {
    if (event.target !== keyboardElement) return;
    keyboardElement = null;
    restoreStyle(savedOutline);
    savedOutline = null;
    const next = event.relatedTarget;
    if (next instanceof HTMLElement && allowed()) {
      const nextTarget = resolveTarget(next);
      if (
        nextTarget &&
        (keyboardNavigation || next.matches(":focus-visible"))
      ) {
        keyboardElement = next;
        syncOpacity();
        setTarget(nextTarget);
        schedule();
        return;
      }
    }
    syncOpacity();
    setTarget(inside && !pointerOverLens() ? resolveTarget(pointerElement) : null);
    if (inside) schedule();
    else clear();
  }

  function keyDown(event: KeyboardEvent) {
    if (event.key === "Tab" || event.key.startsWith("Arrow"))
      keyboardNavigation = true;
  }
  function pointerOver(event: PointerEvent) {
    if (
      nativeLayer(event.target) ||
      (event.target instanceof Element && event.target.closest("iframe"))
    )
      clear();
  }
  function pointerOut(event: PointerEvent) {
    if (event.relatedTarget === null) clear();
  }
  function policyChanged() {
    if (!allowed() || target && nativeLayer(target)) { clear(); return; }
    if (target && (!target.isConnected || !usable(target))) {
      if (!inside) { clear(); return; }
      keyboardElement = null;
      if (pointerElement && !pointerElement.isConnected) pointerElement = null;
      syncOpacity(); setTarget(null); schedule();
    }
  }
  function observeTargetAncestry() {
    targetObserver?.disconnect();
    if (!target) return;
    for (let element: Element | null = target; element; element = element.parentElement) {
      targetObserver?.observe(element, {
        // Child-list observation detects removal/reparenting without scanning
        // descendant style/class writes from every animation in the app.
        childList: true, attributes: true,
        attributeFilter: ["hidden", "disabled", "inert", "aria-hidden", "aria-disabled", "open"],
      });
    }
  }
  function fit() {
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(window.innerWidth * ratio));
    canvas.height = Math.max(1, Math.round(window.innerHeight * ratio));
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    schedule();
  }
  const scrolled = () => schedule();

  const listeners: Array<[string, EventListener]> = [
    ["pointermove", move as EventListener],
    ["pointerdown", press as EventListener],
    ["pointerover", pointerOver as EventListener],
    ["pointerout", pointerOut as EventListener],
    ["pointerleave", clear],
    ["focusin", focusIn as EventListener],
    ["focusout", focusOut as EventListener],
    ["keydown", keyDown as EventListener],
    ["visibilitychange", policyChanged],
  ];
  for (const [event, callback] of listeners)
    document.addEventListener(event, callback);
  window.addEventListener("blur", clear);
  window.addEventListener("resize", fit);
  document.addEventListener("scroll", scrolled, true);
  const queries = [fine, reduced, contrast, forced];
  queries.forEach((query) => query.addEventListener?.("change", policyChanged));
  const observer = new MutationObserver(() => { policyChanged(); schedule(); });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [
      "data-effects",
      "data-reduced-motion",
      "data-high-contrast",
      "data-theme", "style",
    ],
  });
  targetObserver = new MutationObserver(() => { policyChanged(); observeTargetAncestry(); schedule(); });
  const overture = document.querySelector(".vx-overture-root");
  const overtureObserver = new MutationObserver(policyChanged);
  if (overture) overtureObserver.observe(overture, { attributes: true, attributeFilter: ["data-overture-playing"] });
  fit();

  return {
    setEnabled(next) {
      enabled = next;
      if (!next) clear();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clear();
      observer.disconnect();
      targetObserver?.disconnect();
      overtureObserver.disconnect();
      targetResize?.disconnect();
      for (const [event, callback] of listeners)
        document.removeEventListener(event, callback);
      queries.forEach((query) =>
        query.removeEventListener?.("change", policyChanged),
      );
      window.removeEventListener("blur", clear);
      window.removeEventListener("resize", fit);
      document.removeEventListener("scroll", scrolled, true);
      canvas.remove();
    },
  };
}
