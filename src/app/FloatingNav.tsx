import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { Download, Globe, Play, Library, Settings, UserRound, Users } from "lucide-react";
import { navigationRegistry, type NavigationPlacement, type RegistryItem } from "./registry";
import { cn } from "../lib/utils";
import { PlayerAvatar } from "../components/PlayerAvatar";
import { WindowChrome } from "./WindowChrome";
import { useAppearance } from "./AppearanceProvider";
import { GlassSurface } from "../visual/glass/GlassSystem";
import { clamp, jellyMatrix, Spring } from "../visual/glass/jelly";
import { MOTION } from "../design/motion";
import "./shell.css";

export type NavigationPage = "home" | "library" | "discover" | "multiplayer" | "downloads" | "accounts" | "settings";

const NAV_INDICATOR_SPRING = MOTION.lens;

const icons: Record<string, typeof Play> = {
  home: Play,
  library: Library,
  discover: Globe,
  multiplayer: Users,
  downloads: Download,
  accounts: UserRound,
  settings: Settings,
};

type IndicatorRect = { x: number; y: number; width: number; height: number };

function sameIndicatorRect(left: IndicatorRect | null, right: IndicatorRect): boolean {
  return left !== null && Math.abs(left.x - right.x) < 0.5 && Math.abs(left.y - right.y) < 0.5
    && Math.abs(left.width - right.width) < 0.5 && Math.abs(left.height - right.height) < 0.5;
}

function JellyNavigationIndicator({
  activeId,
  itemRefs,
  navRef,
  staticMotion,
  dragging,
  pressRef,
}: {
  activeId: string;
  itemRefs: MutableRefObject<Map<string, HTMLButtonElement>>;
  navRef: RefObject<HTMLElement | null>;
  staticMotion: boolean;
  dragging: boolean;
  pressRef: MutableRefObject<(pressed: boolean) => void>;
}) {
  const indicatorRef = useRef<HTMLDivElement>(null);
  const target = useRef<IndicatorRect | null>(null);
  const frame = useRef<number | null>(null);
  const measureFrame = useRef<number | null>(null);
  const measureFramesRemaining = useRef(0);
  const snapNextMeasure = useRef(false);
  const previousTime = useRef(0);
  const initialized = useRef(false);
  const measuredActiveId = useRef<string | null>(null);
  const angle = useRef(0);
  const navigationSize = useRef({ width: 0, height: 0 });
  const springs = useMemo(() => ({
    x: new Spring(),
    y: new Spring(),
    press: new Spring(),
    stretch: new Spring(),
    bendX: new Spring(),
    bendY: new Spring(),
  }), []);

  const paint = useCallback(() => {
    const indicator = indicatorRef.current;
    const rect = target.current;
    if (!indicator || !rect) return;
    const amount = staticMotion ? 0 : 0.7;
    const pressure = clamp(springs.press.value, 0, 1.16);
    const lift = 1 + pressure * amount * 0.035;
    const matrix = jellyMatrix(staticMotion ? 0 : springs.stretch.value, angle.current, lift);
    const energy = Math.abs(springs.stretch.value) + Math.hypot(springs.bendX.value, springs.bendY.value) * 0.015;
    indicator.style.width = `${rect.width}px`;
    indicator.style.height = `${rect.height}px`;
    const overspill = Math.max(0, (Math.abs(matrix.m11) * rect.width + Math.abs(matrix.m12) * rect.height - rect.width) / 2);
    const x = clamp(springs.x.value, overspill, Math.max(overspill, navigationSize.current.width - rect.width - overspill));
    const y = clamp(springs.y.value, 0, Math.max(0, navigationSize.current.height - rect.height));
    indicator.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    indicator.style.setProperty("--jelly-matrix", matrix.css);
    indicator.style.setProperty("--jelly-bend-x", `${springs.bendX.value}px`);
    indicator.style.setProperty("--jelly-bend-y", `${springs.bendY.value}px`);
    indicator.style.setProperty("--jelly-energy", energy.toFixed(4));
    indicator.style.setProperty("--jelly-press", pressure.toFixed(4));
    indicator.style.setProperty("--jelly-stretch", (staticMotion ? 0 : springs.stretch.value).toFixed(4));
    indicator.style.setProperty("--jelly-heading", angle.current.toFixed(4));
    indicator.style.setProperty("--jelly-radius", `${22 + pressure * 6}px`);
  }, [springs, staticMotion]);

  const setSettled = useCallback((settled: boolean) => {
    navRef.current?.setAttribute("data-motion-settled", String(settled));
  }, [navRef]);

  const start = useCallback(() => {
    if (staticMotion || frame.current !== null || typeof requestAnimationFrame === "undefined") return;
    setSettled(false);
    previousTime.current = 0;
    const tick = (now: number) => {
      const dt = previousTime.current ? (now - previousTime.current) / 1000 : 1 / 60;
      previousTime.current = now;
      // Keep the shared spring's long-stall cap, but do not lose elapsed time
      // on every low-FPS navigation frame. Measure/paint only once per RAF.
      let remaining = Math.max(0, Math.min(dt, MOTION.lens.maxElapsedSeconds));
      while (remaining > 1e-9) {
        const seconds = Math.min(remaining, MOTION.lens.substepSeconds);
        const speed = Math.hypot(springs.x.velocity, springs.y.velocity);
        if (speed > 16) angle.current = Math.atan2(springs.y.velocity, springs.x.velocity);
        springs.stretch.target = Math.min(speed / 2400, 0.25) * 0.7;
        springs.bendX.target = clamp((springs.x.target - springs.x.value) * 0.12, -11, 11) * 0.7;
        springs.bendY.target = clamp((springs.y.target - springs.y.value) * 0.12, -11, 11) * 0.7;
        springs.x.step(seconds, NAV_INDICATOR_SPRING.x.stiffness, springs.press.value > 0.1 ? NAV_INDICATOR_SPRING.x.pressedDamping : NAV_INDICATOR_SPRING.x.damping);
        springs.y.step(seconds, NAV_INDICATOR_SPRING.y.stiffness, NAV_INDICATOR_SPRING.y.damping);
        springs.press.step(seconds, NAV_INDICATOR_SPRING.press.stiffness, NAV_INDICATOR_SPRING.press.damping);
        springs.stretch.step(seconds, NAV_INDICATOR_SPRING.stretch.stiffness, NAV_INDICATOR_SPRING.stretch.damping);
        springs.bendX.step(seconds, NAV_INDICATOR_SPRING.bend.stiffness, NAV_INDICATOR_SPRING.bend.damping);
        springs.bendY.step(seconds, NAV_INDICATOR_SPRING.bend.stiffness, NAV_INDICATOR_SPRING.bend.damping);
        springs.press.value = clamp(springs.press.value, 0, 1.16);
        remaining -= seconds;
      }
      paint();
      const moving = Object.values(springs).some((spring) => spring.moving);
      if (moving) frame.current = requestAnimationFrame(tick);
      else {
        frame.current = null;
        previousTime.current = 0;
        setSettled(true);
      }
    };
    frame.current = requestAnimationFrame(tick);
  }, [paint, setSettled, springs, staticMotion]);

  useEffect(() => {
    pressRef.current = (pressed: boolean) => {
      springs.press.target = pressed ? 1 : 0;
      if (staticMotion) {
        springs.press.snap(0);
        paint();
      } else start();
    };
    return () => {
      pressRef.current = () => {};
    };
  }, [paint, pressRef, springs, start, staticMotion]);

  const readRect = useCallback((): IndicatorRect | null => {
    const nav = navRef.current;
    const item = itemRefs.current.get(activeId);
    if (!nav || !item) return null;
    const navBounds = nav.getBoundingClientRect();
    navigationSize.current = { width: navBounds.width, height: navBounds.height };
    const bounds = item.getBoundingClientRect();
    return {
      x: bounds.left - navBounds.left,
      y: bounds.top - navBounds.top,
      width: bounds.width,
      height: bounds.height,
    };
  }, [activeId, itemRefs, navRef]);

  const measure = useCallback((snap = false) => {
    const rect = readRect();
    if (!rect) return;
    // Only a different selected item earns travel/stretch. Layout and preference
    // updates must also clear velocity left over from an earlier navigation.
    const navigating = measuredActiveId.current !== null && measuredActiveId.current !== activeId;
    const snapToLayout = !initialized.current || staticMotion || snap || !navigating;
    measuredActiveId.current = activeId;
    target.current = rect;
    springs.x.target = target.current.x;
    springs.y.target = target.current.y;
    if (snapToLayout) {
      if (frame.current !== null && typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(frame.current);
      frame.current = null;
      previousTime.current = 0;
      springs.x.snap(target.current.x);
      springs.y.snap(target.current.y);
      // Drag entry and release can both measure the same selected item. Layout
      // snapping must preserve its independent press/release spring; only an
      // accessibility preference removes that deformation immediately.
      if (staticMotion) springs.press.snap(0);
      springs.stretch.snap(0);
      springs.bendX.snap(0);
      springs.bendY.snap(0);
      initialized.current = true;
    }
    paint();
    if ((snapToLayout && !springs.press.moving) || typeof requestAnimationFrame === "undefined") setSettled(true);
    else start();
  }, [activeId, paint, readRect, setSettled, springs, start, staticMotion]);

  const measureRef = useRef(measure);
  measureRef.current = measure;

  const scheduleMeasure = useCallback((snap = false, frames: number = MOTION.lens.settleFrames) => {
    snapNextMeasure.current ||= snap;
    measureFramesRemaining.current = frames;
    setSettled(false);
    if (typeof requestAnimationFrame === "undefined") {
      measureRef.current(snapNextMeasure.current);
      snapNextMeasure.current = false;
      return;
    }
    if (measureFrame.current !== null) return;
    const settleLayout = () => {
      measureFramesRemaining.current -= 1;
      if (measureFramesRemaining.current > 0) {
        measureFrame.current = requestAnimationFrame(settleLayout);
        return;
      }
      measureFrame.current = null;
      measureRef.current(snapNextMeasure.current);
      snapNextMeasure.current = false;
    };
    measureFrame.current = requestAnimationFrame(settleLayout);
  }, [setSettled]);

  useLayoutEffect(() => {
    if (!dragging) scheduleMeasure(false, measuredActiveId.current !== null && measuredActiveId.current !== activeId
      ? MOTION.lens.navigationFrames : MOTION.lens.settleFrames);
  }, [activeId, dragging, scheduleMeasure, staticMotion]);

  useEffect(() => {
    // Button callback refs are reattached after child layout effects, so drag
    // targets must be measured from the passive phase.
    if (dragging) measureRef.current();
  }, [activeId, dragging, staticMotion]);

  useEffect(() => {
    // Without RAF, the first layout effect can precede sibling button refs.
    if (typeof requestAnimationFrame === "undefined") scheduleMeasure(true);
  }, [activeId, scheduleMeasure, staticMotion]);

  useEffect(() => {
    const nav = navRef.current;
    if (!nav || typeof ResizeObserver === "undefined") return;
    // Item labels/counts can move the selected button without resizing the nav.
    // Filter by its relative rect, so unrelated content reflows do no work.
    let lastRect = readRect();
    const observer = new ResizeObserver(() => {
      const next = readRect();
      if (!next || sameIndicatorRect(lastRect, next)) return;
      lastRect = next;
      scheduleMeasure(true);
    });
    observer.observe(nav);
    for (const item of itemRefs.current.values()) observer.observe(item);
    return () => {
      observer.disconnect();
    };
  }, [itemRefs, navRef, readRect, scheduleMeasure]);

  useEffect(() => {
    // Window resizes move items with the layout; snap rather than spring.
    const remeasure = () => scheduleMeasure(true);
    window.addEventListener("resize", remeasure);
    let active = true;
    const snapToLoadedFont = () => {
      if (active) scheduleMeasure(true);
    };
    void document.fonts?.ready.then(snapToLoadedFont);
    document.fonts?.addEventListener?.("loadingdone", snapToLoadedFont);
    return () => {
      active = false;
      window.removeEventListener("resize", remeasure);
      document.fonts?.removeEventListener?.("loadingdone", snapToLoadedFont);
    };
  }, [scheduleMeasure]);

  useEffect(() => {
    if (!staticMotion || frame.current === null || typeof cancelAnimationFrame === "undefined") return;
    cancelAnimationFrame(frame.current);
    frame.current = null;
    previousTime.current = 0;
    setSettled(true);
  }, [setSettled, staticMotion]);

  useEffect(() => () => {
    if (frame.current !== null && typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(frame.current);
    if (measureFrame.current !== null && typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(measureFrame.current);
    frame.current = null;
    measureFrame.current = null;
    previousTime.current = 0;
  }, []);

  return (
    <div
      ref={indicatorRef}
      className={cn("vx-floating-nav__indicator-slot", staticMotion && "is-static")}
      data-active-id={activeId}
      data-dragging={dragging ? "true" : "false"}
      style={{ "--jelly-matrix": "matrix(1, 0, 0, 1, 0, 0)" } as CSSProperties}
      aria-hidden="true"
    >
      <GlassSurface variant="control" className="vx-floating-nav__indicator" />
    </div>
  );
}

export function FloatingNav({
  page,
  onNavigate,
  implemented,
  activeTaskCount = 0,
  accountName,
  accountSkinUrl,
}: {
  page: NavigationPage;
  onNavigate: (page: NavigationPage) => void;
  implemented: ReadonlySet<NavigationPage>;
  activeTaskCount?: number;
  accountName?: string;
  accountSkinUrl?: string;
}) {
  const { t } = useTranslation();
  const { effects, reducedMotion, reducedTransparency, highContrast } = useAppearance();
  const navRef = useRef<HTMLElement>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const pressRef = useRef<(pressed: boolean) => void>(() => {});
  const [hoveredPage, setHoveredPage] = useState<NavigationPage>();
  const [dragPage, setDragPage] = useState<NavigationPage>();
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    target: NavigationPage;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const suppressClickTimer = useRef<number | null>(null);
  const items = navigationRegistry.enabled({}).filter((item) => implemented.has(item.id as NavigationPage));
  const group = (placement: NavigationPlacement) => items.filter((item) => item.placement === placement);
  const staticMotion = reducedMotion || reducedTransparency || highContrast || effects === "lite";

  useEffect(() => () => {
    if (suppressClickTimer.current !== null) window.clearTimeout(suppressClickTimer.current);
  }, []);

  function pageAtPointer(clientX: number, clientY: number): NavigationPage | undefined {
    const nav = navRef.current;
    if (!nav) return undefined;
    const navBounds = nav.getBoundingClientRect();
    if (clientY < navBounds.top - 18 || clientY > navBounds.bottom + 18) return undefined;
    let closest: NavigationPage | undefined;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const [id, item] of itemRefs.current) {
      const bounds = item.getBoundingClientRect();
      const distance = Math.abs(clientX - (bounds.left + bounds.width / 2));
      if (distance < closestDistance) {
        closest = id as NavigationPage;
        closestDistance = distance;
      }
    }
    return closest;
  }

  function clearSuppressedClick() {
    if (suppressClickTimer.current !== null) {
      window.clearTimeout(suppressClickTimer.current);
      suppressClickTimer.current = null;
    }
    suppressClickRef.current = false;
  }

  function suppressNextClick() {
    suppressClickRef.current = true;
    if (suppressClickTimer.current !== null) window.clearTimeout(suppressClickTimer.current);
    suppressClickTimer.current = window.setTimeout(() => {
      suppressClickRef.current = false;
      suppressClickTimer.current = null;
    }, 0);
  }

  function startPress(event: ReactPointerEvent<HTMLElement>) {
    const target = event.target as Element;
    const item = target.closest<HTMLButtonElement>(".vx-floating-nav__item[data-page]");
    if (!item || !event.currentTarget.contains(item)) return;
    clearSuppressedClick();
    pressRef.current(true);
    if (event.button !== 0 || !item.classList.contains("is-active") || dragRef.current) return;
    const targetPage = item.dataset.page as NavigationPage;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      target: targetPage,
      moved: false,
    };
    event.currentTarget.dataset.dragging = "true";
    setDragPage(targetPage);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is an enhancement; the normal click path still works without it.
    }
  }

  function movePress(event: ReactPointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.moved) {
      if (Math.abs(event.clientX - drag.startX) < 4) return;
      drag.moved = true;
      event.preventDefault();
    }
    const next = pageAtPointer(event.clientX, event.clientY);
    if (!next || next === drag.target) return;
    drag.target = next;
    setDragPage(next);
  }

  function finishPress(event: ReactPointerEvent<HTMLElement>, commit: boolean) {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) {
      pressRef.current(false);
      return;
    }
    dragRef.current = null;
    event.currentTarget.dataset.dragging = "false";
    setDragPage(undefined);
    pressRef.current(false);
    try {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // The capture can already be gone when the pointer is cancelled by the OS.
    }
    if (!commit) return;
    suppressNextClick();
    if (!drag.moved) {
      // Native pointer capture can retarget click to the nav instead of its
      // button. Commit this tap here, and suppress any duplicate button click.
      const bounds = itemRefs.current.get(drag.target)?.getBoundingClientRect();
      if (bounds && event.clientX >= bounds.left && event.clientX <= bounds.right &&
        event.clientY >= bounds.top && event.clientY <= bounds.bottom) onNavigate(drag.target);
      return;
    }
    if (drag.target !== page) onNavigate(drag.target);
  }

  const renderItem = (item: RegistryItem) => {
    const id = item.id as NavigationPage;
    const Icon = icons[item.id] ?? Play;
    const active = id === page;
    const activityLabel = id === "downloads" && activeTaskCount > 0
      ? ` ${t("downloads:activeCount", { count: activeTaskCount })}`
      : "";
    return (
      <button
        key={item.id}
        ref={(node) => {
          if (node) itemRefs.current.set(item.id, node);
          else itemRefs.current.delete(item.id);
        }}
        type="button"
        className={cn(
          "vx-floating-nav__item",
          active && "is-active",
          hoveredPage === id && "is-hovered",
          dragPage === id && !active && "is-drag-target",
        )}
        data-page={id}
        aria-current={active ? "page" : undefined}
        aria-label={`${t(item.labelKey)}${activityLabel}`}
        title={id === "accounts" && accountName ? `${t(item.labelKey)} · ${accountName}` : t(item.labelKey)}
        onClick={(event) => {
          if (suppressClickRef.current) {
            event.preventDefault();
            event.stopPropagation();
            clearSuppressedClick();
            return;
          }
          onNavigate(id);
        }}
        onPointerEnter={(event) => {
          if (event.pointerType !== "touch") setHoveredPage(id);
        }}
        onPointerLeave={() => setHoveredPage((current) => current === id ? undefined : current)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") pressRef.current(true);
        }}
        onKeyUp={() => pressRef.current(false)}
        onBlur={() => pressRef.current(false)}
      >
        {id === "accounts" ? (
          <span className="vx-floating-nav__avatar" aria-hidden="true"><PlayerAvatar skinUrl={accountSkinUrl} username={accountName} size={19} /></span>
        ) : <Icon size={16} aria-hidden="true" />}
        <span className="vx-floating-nav__label">{t(item.labelKey)}</span>
        {id === "downloads" && activeTaskCount > 0 ? <span className="vx-floating-nav__count" aria-hidden="true">{activeTaskCount}</span> : null}
      </button>
    );
  };
  return (
    <WindowChrome>
      <nav
        ref={navRef}
        className="vx-floating-nav"
        data-visual-owner="lens"
        data-motion-settled="false"
        data-hover-other={dragPage === undefined && hoveredPage !== undefined && hoveredPage !== page ? "true" : "false"}
        data-dragging="false"
        aria-label={t("common:a11y.mainNavigation")}
        onPointerDown={startPress}
        onPointerMove={movePress}
        onPointerUp={(event) => finishPress(event, true)}
        onPointerCancel={(event) => finishPress(event, false)}
        onLostPointerCapture={(event) => {
          if (dragRef.current?.pointerId === event.pointerId) finishPress(event, false);
        }}
        onPointerLeave={(event) => {
          if (!dragRef.current) {
            pressRef.current(false);
            return;
          }
          if (typeof event.currentTarget.hasPointerCapture === "function"
            && !event.currentTarget.hasPointerCapture(event.pointerId)) {
            finishPress(event, false);
          }
        }}
      >
        <JellyNavigationIndicator
          activeId={dragPage ?? page}
          itemRefs={itemRefs}
          navRef={navRef}
          staticMotion={staticMotion}
          dragging={dragPage !== undefined}
          pressRef={pressRef}
        />
        <div className="vx-floating-nav__group">{group("primary").map(renderItem)}</div>
        {group("utility").length ? <div className="vx-floating-nav__group vx-floating-nav__group--utility">{group("utility").map(renderItem)}</div> : null}
      </nav>
    </WindowChrome>
  );
}
