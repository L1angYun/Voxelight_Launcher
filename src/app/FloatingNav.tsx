import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject,
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
import "./shell.css";

export type NavigationPage = "home" | "library" | "discover" | "multiplayer" | "downloads" | "accounts" | "settings";

const NAV_LAYOUT_SETTLE_FRAMES = 3;
const NAV_INDICATOR_SPRING = {
  x: { stiffness: 260, damping: 17, pressedDamping: 22 },
  y: { stiffness: 260, damping: 17 },
  press: { stiffness: 310, damping: 18 },
  stretch: { stiffness: 230, damping: 15 },
  bend: { stiffness: 190, damping: 14 },
} as const;

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

function JellyNavigationIndicator({
  activeId,
  itemRefs,
  navRef,
  staticMotion,
  pressRef,
}: {
  activeId: string;
  itemRefs: MutableRefObject<Map<string, HTMLButtonElement>>;
  navRef: RefObject<HTMLElement | null>;
  staticMotion: boolean;
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
  const angle = useRef(0);
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
    indicator.style.transform = `translate3d(${springs.x.value}px, ${springs.y.value}px, 0)`;
    indicator.style.setProperty("--jelly-matrix", matrix.css);
    indicator.style.setProperty("--jelly-bend-x", `${springs.bendX.value}px`);
    indicator.style.setProperty("--jelly-bend-y", `${springs.bendY.value}px`);
    indicator.style.setProperty("--jelly-energy", energy.toFixed(4));
    indicator.style.setProperty("--jelly-press", pressure.toFixed(4));
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
      const speed = Math.hypot(springs.x.velocity, springs.y.velocity);
      if (speed > 16) angle.current = Math.atan2(springs.y.velocity, springs.x.velocity);
      springs.stretch.target = Math.min(speed / 2400, 0.25) * 0.7;
      springs.bendX.target = clamp((springs.x.target - springs.x.value) * 0.12, -11, 11) * 0.7;
      springs.bendY.target = clamp((springs.y.target - springs.y.value) * 0.12, -11, 11) * 0.7;
      springs.x.step(dt, NAV_INDICATOR_SPRING.x.stiffness, springs.press.value > 0.1 ? NAV_INDICATOR_SPRING.x.pressedDamping : NAV_INDICATOR_SPRING.x.damping);
      springs.y.step(dt, NAV_INDICATOR_SPRING.y.stiffness, NAV_INDICATOR_SPRING.y.damping);
      springs.press.step(dt, NAV_INDICATOR_SPRING.press.stiffness, NAV_INDICATOR_SPRING.press.damping);
      springs.stretch.step(dt, NAV_INDICATOR_SPRING.stretch.stiffness, NAV_INDICATOR_SPRING.stretch.damping);
      springs.bendX.step(dt, NAV_INDICATOR_SPRING.bend.stiffness, NAV_INDICATOR_SPRING.bend.damping);
      springs.bendY.step(dt, NAV_INDICATOR_SPRING.bend.stiffness, NAV_INDICATOR_SPRING.bend.damping);
      springs.press.value = clamp(springs.press.value, 0, 1.16);
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

  const measure = useCallback((snap = false) => {
    const nav = navRef.current;
    const item = itemRefs.current.get(activeId);
    if (!nav || !item) return;
    const navBounds = nav.getBoundingClientRect();
    const bounds = item.getBoundingClientRect();
    target.current = {
      x: bounds.left - navBounds.left,
      y: bounds.top - navBounds.top,
      width: bounds.width,
      height: bounds.height,
    };
    springs.x.target = target.current.x;
    springs.y.target = target.current.y;
    if (!initialized.current || staticMotion || snap) {
      springs.x.snap(target.current.x);
      springs.y.snap(target.current.y);
      springs.press.snap(0);
      springs.stretch.snap(0);
      springs.bendX.snap(0);
      springs.bendY.snap(0);
      initialized.current = true;
    }
    if (indicatorRef.current) indicatorRef.current.style.opacity = "1";
    paint();
    if (staticMotion || snap || typeof requestAnimationFrame === "undefined") setSettled(true);
    else start();
  }, [activeId, itemRefs, navRef, paint, setSettled, springs, start, staticMotion]);

  const measureRef = useRef(measure);
  measureRef.current = measure;

  const scheduleMeasure = useCallback((snap = false) => {
    snapNextMeasure.current ||= snap;
    measureFramesRemaining.current = NAV_LAYOUT_SETTLE_FRAMES;
    setSettled(false);
    if (typeof requestAnimationFrame === "undefined") {
      measure(snapNextMeasure.current);
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
    scheduleMeasure();
    const nav = navRef.current;
    if (!nav || typeof ResizeObserver === "undefined") return;
    // Only observe the nav itself. Per-item observation fired on any page
    // reflow (e.g. settings tab switches), triggering remeasure mid-transition
    // and stretching the indicator. We additionally filter to nav-self size
    // changes only, ignoring reflows that leave the nav bounds unchanged.
    let lastWidth = nav.getBoundingClientRect().width;
    let lastHeight = nav.getBoundingClientRect().height;
    let debounceId: number | null = null;
    const observer = new ResizeObserver(() => {
      if (debounceId !== null && typeof cancelAnimationFrame !== "undefined") {
        cancelAnimationFrame(debounceId);
      }
      debounceId = requestAnimationFrame(() => {
        debounceId = null;
        const next = nav.getBoundingClientRect();
        if (Math.abs(next.width - lastWidth) < 0.5 && Math.abs(next.height - lastHeight) < 0.5) return;
        lastWidth = next.width;
        lastHeight = next.height;
        scheduleMeasure();
      });
    });
    observer.observe(nav);
    return () => {
      if (debounceId !== null && typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(debounceId);
      observer.disconnect();
    };
  }, [activeId, itemRefs, navRef, scheduleMeasure]);

  useEffect(() => {
    const remeasure = () => scheduleMeasure();
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
      key={staticMotion ? `static-${activeId}` : "spring"}
      ref={indicatorRef}
      className={cn("vx-floating-nav__indicator-slot", staticMotion && "is-static")}
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
  const { effects, reducedMotion } = useAppearance();
  const navRef = useRef<HTMLElement>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const pressRef = useRef<(pressed: boolean) => void>(() => {});
  const [hoveredPage, setHoveredPage] = useState<NavigationPage>();
  const items = navigationRegistry.enabled({}).filter((item) => implemented.has(item.id as NavigationPage));
  const group = (placement: NavigationPlacement) => items.filter((item) => item.placement === placement);
  const staticMotion = reducedMotion || effects === "lite";
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
        className={cn("vx-floating-nav__item", active && "is-active", hoveredPage === id && "is-hovered")}
        data-page={id}
        aria-current={active ? "page" : undefined}
        aria-label={`${t(item.labelKey)}${activityLabel}`}
        title={id === "accounts" && accountName ? `${t(item.labelKey)} · ${accountName}` : t(item.labelKey)}
        onClick={() => onNavigate(id)}
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
        data-motion-settled="false"
        data-hover-other={hoveredPage !== undefined && hoveredPage !== page ? "true" : "false"}
        aria-label={t("common:a11y.mainNavigation")}
        onPointerDown={(event) => {
          if ((event.target as Element).closest(".vx-floating-nav__item")) pressRef.current(true);
        }}
        onPointerUp={() => pressRef.current(false)}
        onPointerCancel={() => pressRef.current(false)}
        onPointerLeave={() => pressRef.current(false)}
      >
        <JellyNavigationIndicator
          activeId={page}
          itemRefs={itemRefs}
          navRef={navRef}
          staticMotion={staticMotion}
          pressRef={pressRef}
        />
        <div className="vx-floating-nav__group">{group("primary").map(renderItem)}</div>
        {group("utility").length ? <div className="vx-floating-nav__group vx-floating-nav__group--utility">{group("utility").map(renderItem)}</div> : null}
      </nav>
    </WindowChrome>
  );
}
