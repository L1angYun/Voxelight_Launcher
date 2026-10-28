import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  advanceSpring,
  createSpring,
  isMoving,
  type SpringState,
} from "../glass/jelly";
import { cn } from "../../lib/utils";
import {
  LATTICE_DISPERSE_DURATION_MS,
  LATTICE_FOCUS_FLOW_PX_PER_SECOND,
  LATTICE_HOVER_SETTLE_MS,
  LATTICE_HOVER_SPRING,
  LATTICE_HOVER_STAGGER_MS,
  LATTICE_LOCK_FLASH_MS,
  LATTICE_POINT_BUDGET,
  latticePointSetForBox,
  latticeSelection,
  type LatticeContourPoint,
  type LatticeShape,
} from "./model";
import { useLatticeStaticMotion } from "./staticMotion";
import "./lattice.css";

interface PointSpring {
  x: SpringState;
  y: SpringState;
}

interface FrameSize {
  width: number;
  height: number;
}

function placeDot(
  element: HTMLElement,
  point: LatticeContourPoint,
  x: number,
  y: number,
  shape: LatticeShape,
): void {
  const anchor = shape === "selected" && point.anchor;
  const diameter = point.radius * 2 * (anchor ? 1.65 : 1);
  element.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
  element.style.width = `${diameter.toFixed(2)}px`;
  element.style.height = `${diameter.toFixed(2)}px`;
  element.style.setProperty("--lattice-weight", point.weight.toFixed(3));
  element.dataset.anchor = String(anchor);
}

export function LatticeFrame({
  hovered = false,
  focused = false,
  selected = false,
  signature = "lattice",
  className,
}: {
  hovered?: boolean;
  focused?: boolean;
  selected?: boolean;
  signature?: string;
  className?: string;
}) {
  const frame = useRef<HTMLSpanElement>(null);
  const dots = useRef<Array<HTMLElement | null>>([]);
  const springs = useRef<PointSpring[]>([]);
  const previousShape = useRef<LatticeShape>("none");
  const initialized = useRef(false);
  const transitionStartedAt = useRef(0);
  const frameRequest = useRef<number | null>(null);
  const previousFrameTime = useRef(0);
  const restartMotion = useRef<() => void>(() => {});
  const [size, setSize] = useState<FrameSize>({ width: 100, height: 100 });
  const [measured, setMeasured] = useState(false);
  const [dispersing, setDispersing] = useState(false);
  const [glinting, setGlinting] = useState(false);
  const staticMotion = useLatticeStaticMotion();
  const selection = latticeSelection({ hovered, focused, selected });
  const shape = selection.shape;
  const pointCount = staticMotion
    ? LATTICE_POINT_BUDGET.lite
    : LATTICE_POINT_BUDGET.full;
  const glintIndex = Math.max(0, Math.floor(pointCount / 8));

  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    const measure = () => {
      const bounds = element.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      setSize((current) =>
        current.width === bounds.width && current.height === bounds.height
          ? current
          : { width: bounds.width, height: bounds.height },
      );
      setMeasured(true);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!dispersing) return;
    const settleDuration = Math.max(
      LATTICE_DISPERSE_DURATION_MS,
      LATTICE_HOVER_SETTLE_MS + LATTICE_HOVER_STAGGER_MS,
    );
    const timer = window.setTimeout(
      () => setDispersing(false),
      settleDuration,
    );
    return () => window.clearTimeout(timer);
  }, [dispersing]);

  useEffect(() => {
    if (!selected || staticMotion) {
      setGlinting(false);
      return;
    }
    setGlinting(true);
    const timer = window.setTimeout(
      () => setGlinting(false),
      LATTICE_LOCK_FLASH_MS,
    );
    return () => window.clearTimeout(timer);
  }, [selected, staticMotion]);

  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    const count = pointCount;
    const width = size.width || 100;
    const height = size.height || 100;
    const now = performance.now();
    const shapeChanged = previousShape.current !== shape;
    const initializing = !initialized.current;
    const reshape = (phasePx = 0) =>
      latticePointSetForBox({
        shape,
        identity: signature,
        width,
        height,
        pointCount: count,
        phasePx,
      });
    const free = latticePointSetForBox({
      shape: "none",
      identity: signature,
      width,
      height,
      pointCount: count,
    });

    if (springs.current.length !== count) {
      springs.current = free.map((point) => ({
        x: createSpring((point.x / 100) * width),
        y: createSpring((point.y / 100) * height),
      }));
    }
    initialized.current = true;

    if (shapeChanged) {
      transitionStartedAt.current = now;
      for (const spring of springs.current) {
        spring.x.goal = spring.x.position;
        spring.y.goal = spring.y.position;
      }
      previousShape.current = shape;
    }

    if (shape === "none" && shapeChanged && !staticMotion) {
      setDispersing(true);
    } else if (shape !== "none") {
      setDispersing(false);
    }

    const paint = (targets: LatticeContourPoint[], positions?: PointSpring[]) => {
      for (let index = 0; index < count; index += 1) {
        const dot = dots.current[index];
        if (!dot) continue;
        const point = targets[index];
        const spring = positions?.[index];
        const x = spring?.x.position ?? (point.x / 100) * width;
        const y = spring?.y.position ?? (point.y / 100) * height;
        placeDot(dot, point, x, y, shape);
      }
    };

    if (staticMotion) {
      const targets = shape === "none" ? free : reshape();
      paint(targets);
      if (
        frameRequest.current !== null &&
        typeof cancelAnimationFrame === "function"
      ) {
        cancelAnimationFrame(frameRequest.current);
        frameRequest.current = null;
      }
      return;
    }

    const firstTargets = shape === "none" ? free : reshape();
    if (shape !== "none" && initializing) {
      springs.current.forEach((spring, index) => {
        spring.x = {
          ...createSpring((firstTargets[index].x / 100) * width),
        };
        spring.y = {
          ...createSpring((firstTargets[index].y / 100) * height),
        };
      });
      transitionStartedAt.current = now - LATTICE_HOVER_SETTLE_MS;
      paint(firstTargets, springs.current);
      if (shape === "selected") return;
    }

    const tick = (time: number) => {
      frameRequest.current = null;
      if (document.hidden) return;
      const seconds = previousFrameTime.current
        ? Math.min(0.08, Math.max(0, (time - previousFrameTime.current) / 1000))
        : 1 / 60;
      previousFrameTime.current = time;
      const elapsed = Math.max(0, time - transitionStartedAt.current);
      const phase =
        shape === "focus"
          ? (elapsed / 1000) * LATTICE_FOCUS_FLOW_PX_PER_SECOND
          : 0;
      const targets = shape === "none" ? free : reshape(phase);
      let moving = shape === "focus";

      for (let index = 0; index < count; index += 1) {
        const spring = springs.current[index];
        const staggering = shape === "hover" || shape === "none";
        const delay = staggering
          ? (index / Math.max(1, count - 1)) * LATTICE_HOVER_STAGGER_MS
          : 0;
        if (elapsed >= delay) {
          spring.x.goal = (targets[index].x / 100) * width;
          spring.y.goal = (targets[index].y / 100) * height;
        }
        advanceSpring(spring.x, seconds, LATTICE_HOVER_SPRING);
        advanceSpring(spring.y, seconds, LATTICE_HOVER_SPRING);
        moving ||= isMoving(spring.x) || isMoving(spring.y);
      }

      paint(targets, springs.current);
      if (
        moving &&
        !document.hidden &&
        typeof requestAnimationFrame === "function"
      ) {
        frameRequest.current = requestAnimationFrame(tick);
      } else {
        previousFrameTime.current = 0;
      }
    };

    const start = () => {
      if (
        document.hidden ||
        frameRequest.current !== null ||
        typeof requestAnimationFrame !== "function"
      ) {
        return;
      }
      previousFrameTime.current = 0;
      frameRequest.current = requestAnimationFrame(tick);
    };
    restartMotion.current = start;
    paint(firstTargets, springs.current);
    start();

    return () => {
      restartMotion.current = () => {};
      if (
        frameRequest.current !== null &&
        typeof cancelAnimationFrame === "function"
      ) {
        cancelAnimationFrame(frameRequest.current);
        frameRequest.current = null;
      }
      previousFrameTime.current = 0;
    };
  }, [measured, pointCount, shape, signature, size.height, size.width, staticMotion]);

  useEffect(() => {
    const onVisibility = () => {
      if (!document.hidden) restartMotion.current();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () =>
      document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  return (
    <span
      ref={frame}
      className={cn(
        "vx-lattice-frame",
        `vx-lattice-frame--${shape}`,
        dispersing && "is-dispersing",
        className,
      )}
      data-state={shape}
      data-hovered={hovered}
      data-focused={focused}
      data-selected={selected}
      data-signature={signature}
      data-point-count={pointCount}
      data-static={staticMotion}
      data-priority={shape}
      data-visual-owner="lattice"
      aria-hidden="true"
    >
      {Array.from({ length: pointCount }, (_, index) => (
        <i
          key={index}
          ref={(node) => {
            dots.current[index] = node;
          }}
          className="vx-lattice-frame__dot"
          data-index={index}
          data-anchor="false"
          data-glint={glinting && index === glintIndex ? "true" : undefined}
          style={
            {
              "--lattice-order": index,
            } as CSSProperties
          }
        />
      ))}
    </span>
  );
}
