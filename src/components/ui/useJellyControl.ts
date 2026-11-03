import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { clamp, jellyMatrix, Spring } from "../../visual/glass/jelly";
import { MOTION } from "../../design/motion";

export function useJellyControl<T extends HTMLElement>(staticMotion: boolean) {
  const ref = useRef<T>(null);
  const frame = useRef<number | null>(null);
  const previousTime = useRef(0);
  const previousPointer = useRef({ x: 0, y: 0, time: 0 });
  const angle = useRef(0);
  const springs = useMemo(() => ({
    press: new Spring(),
    stretch: new Spring(),
    bendX: new Spring(),
    bendY: new Spring(),
  }), []);

  const paint = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    const amount = staticMotion ? 0 : 0.7;
    const pressure = clamp(springs.press.value, 0, 1.16);
    const lift = 1 + pressure * amount * 0.035;
    const matrix = jellyMatrix(staticMotion ? 0 : springs.stretch.value, angle.current, lift);
    const energy = Math.abs(springs.stretch.value) + Math.hypot(springs.bendX.value, springs.bendY.value) * 0.015;
    element.style.setProperty("--jelly-matrix", matrix.css);
    element.style.setProperty("--jelly-bend-x", `${springs.bendX.value}px`);
    element.style.setProperty("--jelly-bend-y", `${springs.bendY.value}px`);
    element.style.setProperty("--jelly-energy", energy.toFixed(4));
    element.style.setProperty("--jelly-press", pressure.toFixed(4));
    element.style.setProperty("--jelly-stretch", (staticMotion ? 0 : springs.stretch.value).toFixed(4));
    element.style.setProperty("--jelly-heading", angle.current.toFixed(4));
  }, [springs, staticMotion]);

  const start = useCallback(() => {
    if (staticMotion || frame.current !== null || typeof requestAnimationFrame === "undefined") return;
    previousTime.current = 0;
    const tick = (now: number) => {
      const dt = previousTime.current ? (now - previousTime.current) / 1000 : 1 / 60;
      previousTime.current = now;
      springs.press.step(dt, MOTION.lens.press.stiffness, MOTION.lens.press.damping);
      springs.stretch.step(dt, MOTION.lens.stretch.stiffness, MOTION.lens.stretch.damping);
      springs.bendX.step(dt, MOTION.lens.bend.stiffness, MOTION.lens.bend.damping);
      springs.bendY.step(dt, MOTION.lens.bend.stiffness, MOTION.lens.bend.damping);
      springs.press.value = clamp(springs.press.value, 0, 1.16);
      paint();
      if (Object.values(springs).some((spring) => spring.moving)) frame.current = requestAnimationFrame(tick);
      else {
        frame.current = null;
        previousTime.current = 0;
      }
    };
    frame.current = requestAnimationFrame(tick);
  }, [paint, springs, staticMotion]);

  const release = useCallback(() => {
    springs.press.target = 0;
    springs.stretch.target = 0;
    springs.bendX.target = 0;
    springs.bendY.target = 0;
    if (staticMotion) {
      for (const spring of Object.values(springs)) spring.snap(0);
      paint();
    } else start();
  }, [paint, springs, start, staticMotion]);

  const onPointerDown = useCallback((event: ReactPointerEvent<T>) => {
    if (event.button !== 0) return;
    springs.press.target = 1;
    previousPointer.current = { x: event.clientX, y: event.clientY, time: event.timeStamp };
    if (!staticMotion) start();
  }, [springs, start, staticMotion]);

  const onPointerMove = useCallback((event: ReactPointerEvent<T>) => {
    if (staticMotion || springs.press.target !== 1) return;
    const previous = previousPointer.current;
    const elapsed = Math.max(1, event.timeStamp - previous.time) / 1000;
    const dx = event.clientX - previous.x;
    const dy = event.clientY - previous.y;
    const speed = Math.hypot(dx, dy) / elapsed;
    if (speed > 16) {
      angle.current = Math.atan2(dy, dx);
      springs.stretch.target = Math.min(speed / 2400, 0.25) * 0.7;
      springs.bendX.target = clamp(dx * 0.12, -11, 11) * 0.7;
      springs.bendY.target = clamp(dy * 0.12, -11, 11) * 0.7;
    }
    previousPointer.current = { x: event.clientX, y: event.clientY, time: event.timeStamp };
    start();
  }, [springs, start, staticMotion]);

  useEffect(() => {
    if (!staticMotion) return;
    if (frame.current !== null && typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(frame.current);
    frame.current = null;
    for (const spring of Object.values(springs)) spring.snap(0);
    paint();
  }, [paint, springs, staticMotion]);

  useEffect(() => () => {
    if (frame.current !== null && typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(frame.current);
  }, []);

  return {
    ref,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: release,
      onPointerCancel: release,
      onPointerLeave: release,
      onBlur: release,
      onKeyDown: (event: ReactKeyboardEvent<T>) => {
        if (event.key === "Enter" || event.key === " ") {
          springs.press.target = 1;
          if (!staticMotion) start();
        }
      },
      onKeyUp: release,
    },
  };
}
