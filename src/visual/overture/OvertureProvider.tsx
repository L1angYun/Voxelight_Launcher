import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { playOvertureTone } from "./audio";
import { OVERTURE_STAGE_MS, OVERTURE_STATIC_MS } from "./motion";
import "./overture.css";

export type OvertureKind = "first-run" | "instance-installed" | "game-launched";
export interface OvertureEvent {
  id: string;
  kind: OvertureKind;
}

interface OvertureContextValue {
  current: OvertureEvent | null;
  playing: boolean;
  reducedMotion: boolean;
  soundEnabled: boolean;
  play(event: OvertureEvent): void;
  dismiss(): void;
}

const OvertureContext = createContext<OvertureContextValue | null>(null);

export function OvertureProvider({
  reducedMotion = false,
  soundEnabled = false,
  children,
}: {
  reducedMotion?: boolean;
  soundEnabled?: boolean;
  children?: ReactNode;
}) {
  const [current, setCurrent] = useState<OvertureEvent | null>(null);
  const currentRef = useRef<OvertureEvent | null>(null);
  const played = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismiss = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    currentRef.current = null;
    setCurrent(null);
  }, []);

  const arm = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    const staticMotion = reducedMotion || document.documentElement.dataset.effects === "lite";
    timer.current = setTimeout(() => {
      timer.current = null;
      currentRef.current = null;
      setCurrent(null);
    }, staticMotion ? OVERTURE_STATIC_MS : OVERTURE_STAGE_MS);
  }, [reducedMotion]);

  const play = useCallback(
    (event: OvertureEvent) => {
      if (currentRef.current || played.current.has(event.id)) return;
      played.current.add(event.id);
      currentRef.current = event;
      setCurrent(event);
      if (soundEnabled) playOvertureTone(event.kind, true);
      arm();
    },
    [arm, soundEnabled],
  );

  // A remount (StrictMode, hot reload) must not leave an event playing without its end timer.
  useEffect(() => {
    if (currentRef.current && !timer.current) arm();
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [arm]);

  return (
    <OvertureContext.Provider value={{ current, playing: current !== null, reducedMotion, soundEnabled, play, dismiss }}>
      <div className="vx-overture-root" data-overture-playing={current !== null}>
        {children}
      </div>
    </OvertureContext.Provider>
  );
}

export function useOverture() {
  const value = useContext(OvertureContext);
  if (!value) throw new Error("useOverture must be used inside OvertureProvider");
  return value;
}
