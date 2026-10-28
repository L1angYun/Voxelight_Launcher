// SPDX-License-Identifier: GPL-3.0-only
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { advanceSpring, clamp, createSpring, snapSpring } from "../visual/glass/jelly";
import {
  OVERTURE_STAGE_MS,
  WORLD_CAMERA,
  WORLD_CANVAS_PIXEL_RATIO_MAX,
  WORLD_LIGHT_CYCLE_MS,
  WORLD_PARALLAX_DEPTHS,
  WORLD_PARTICLE_BUDGET,
} from "../visual/overture/motion";
import "./WorldScene.css";

export type WorldSceneState = "idle" | "preparing" | "running" | "error";

type WorldSceneProps = {
  state?: WorldSceneState;
  className?: string;
  progress?: number;
  paused?: boolean;
  onCameraFrame?: (pose: { x: number; y: number; scale: number }) => void;
};

const beaconColors: Record<WorldSceneState, string> = {
  idle: "#eed3a4", preparing: "#eeb76d", running: "#a8d5ce", error: "#d98779",
};

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return reduced;
}

type Particle = {
  x: number;
  y: number;
  size: number;
  phase: number;
  drift: number;
  firefly: boolean;
};

// Particle sizes boosted for visibility: fireflies 2.5-4px, dust 1.5-2.5px.
// Budget constants are defined in motion.ts (fireflies: 16, dust: 32, total: 48).
const particles: Particle[] = Array.from({ length: WORLD_PARTICLE_BUDGET.total }, (_, index) => ({
  x: ((index * 47 + 13) % 101) / 101,
  y: 0.28 + ((index * 31 + 7) % 67) / 100,
  // Fireflies: 2.5–4 px (were 1–2.3). Dust: 1.5–2.5 px (were 1–1.95).
  size: index < WORLD_PARTICLE_BUDGET.fireflies
    ? 2.5 + (index % 3) * 0.75
    : 1.5 + (index % 3) * 0.5,
  phase: index * 0.73,
  drift: 5 + (index % 5) * 2.2,
  firefly: index < WORLD_PARTICLE_BUDGET.fireflies,
}));

// Stepped silhouettes and separately lit faces keep the landscape voxel-native.
function VoxelPine({ x, y, scale = 1, distant = false }: { x: number; y: number; scale?: number; distant?: boolean }) {
  return <g transform={`translate(${x} ${y}) scale(${scale})`}>
    <path d="M-5-80H5V6H-5z" fill="var(--world-trunk)" />
    <path d="M-5-80H0V6H-5z" fill="#a38d65" opacity=".28" />
    <g className="world-scene__foliage">
      <path d="M-9-144H9v19h13v20h15v22h14v21H34v16H17v12h-34v-12h-17v-16h-17v-21h14v-22h15v-20h13z" fill={distant ? "var(--world-pine-distant)" : "var(--world-pine)"} />
      <path d="M0-144h9v19h13v20h15v22h14v21H34v16H17v12H0z" fill={distant ? "var(--world-pine-distant-shade)" : "var(--world-pine-shade)"} />
      <path d="M-9-144H9v8H-9zM-22-125H9v7h-31zM-37-105H9v7h-46zM-51-83H9v8h-60z" fill="var(--world-pine-light)" opacity=".6" />
      <path d="M-32-95h9v8h-9zM-16-72h11v10h-11zM13-112h7v7h-7zM22-70h11v8H22z" fill="#a3ad7e" opacity=".13" />
    </g>
  </g>;
}

export function WorldScene({
  state = "idle",
  className = "",
  progress = 0,
  paused: userPaused = false,
  onCameraFrame,
}: WorldSceneProps) {
  const sceneRef = useRef<HTMLDivElement>(null);
  const farLayerRef = useRef<SVGGElement>(null);
  const middleLayerRef = useRef<SVGGElement>(null);
  const foregroundLayerRef = useRef<SVGGElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<number | null>(null);
  const previousFrameTime = useRef(0);
  const pointerGoal = useRef({ x: 0, y: 0 });
  const camera = useRef({ x: createSpring(), y: createSpring() });
  const cameraScale = useRef(1);
  const cameraPush = useRef({ from: 1, target: 1, startedAt: 0 });
  const canvasSize = useRef({ width: 0, height: 0 });
  const particlePalette = useRef<{ firefly: string; dust: string } | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  const [pageVisible, setPageVisible] = useState(() =>
    typeof document === "undefined" ? true : !document.hidden,
  );
  const [inView, setInView] = useState(true);
  const [interacting, setInteracting] = useState(false);
  const id = useId();
  const skyId = `${id}-sky`;
  const sunId = `${id}-sun`;
  const earthId = `${id}-earth`;
  const waterId = `${id}-water`;
  const clipId = `${id}-clip`;
  const beamId = `${id}-beam`;
  const normalizedProgress = Math.min(100, Math.max(0, progress));
  const beaconProgress =
    state === "running" ? 100 : state === "idle" ? 0 : normalizedProgress;

  const paused = userPaused || !pageVisible || !inView;
  const motionEnabled = !reducedMotion && !paused && !interacting;

  const resetPointer = useCallback(() => {
    pointerGoal.current = { x: 0, y: 0 };
  }, []);

  const paintCamera = useCallback((scale: number, includePointer: boolean) => {
    const x = includePointer ? clamp(camera.current.x.position, -1, 1) : 0;
    const y = includePointer ? clamp(camera.current.y.position, -1, 1) : 0;
    const layers = [
      [farLayerRef.current, WORLD_PARALLAX_DEPTHS.far],
      [middleLayerRef.current, WORLD_PARALLAX_DEPTHS.middle],
      [foregroundLayerRef.current, WORLD_PARALLAX_DEPTHS.foreground],
    ] as const;
    for (const [layer, depth] of layers) {
      if (!layer) continue;
      const offsetX = x * WORLD_CAMERA.maxOffsetPx * depth;
      const offsetY = y * WORLD_CAMERA.maxOffsetPx * depth * 0.62;
      layer.style.transform = `translate3d(${offsetX.toFixed(2)}px, ${offsetY.toFixed(2)}px, 0)`;
    }
    cameraScale.current = scale;
    sceneRef.current?.style.setProperty("--world-camera-scale", scale.toFixed(4));
    onCameraFrame?.({ x, y, scale });
  }, [onCameraFrame]);

  const drawParticles = useCallback((now: number) => {
    const canvas = canvasRef.current;
    const { width, height } = canvasSize.current;
    if (!canvas || width < 1 || height < 1) return;
    let context: CanvasRenderingContext2D | null = null;
    try {
      context = canvas.getContext("2d");
    } catch {
      return;
    }
    if (!context) return;
    if (!particlePalette.current) {
      const style = getComputedStyle(canvas);
      particlePalette.current = {
        firefly: style.getPropertyValue("--world-firefly").trim() || "#f0d0a0",
        dust: style.getPropertyValue("--world-dust").trim() || "#c7d7cf",
      };
    }
    const { firefly, dust } = particlePalette.current;
    context.clearRect(0, 0, width, height);
    const seconds = now / 1000;
    for (const particle of particles) {
      const phase = seconds * (particle.firefly ? 0.16 : 0.07) + particle.phase;
      const x = particle.x * width + Math.sin(phase) * particle.drift;
      const y = particle.y * height + Math.cos(phase * 0.83) * particle.drift * 0.72;
      // Boosted alpha: fireflies 0.52–0.80, dust 0.22–0.34 (was 0.34–0.62 / 0.12–0.24)
      context.globalAlpha = particle.firefly
        ? 0.52 + (Math.sin(phase * 1.7) + 1) * 0.14
        : 0.22 + (Math.cos(phase) + 1) * 0.06;
      context.fillStyle = particle.firefly ? firefly : dust;
      const size = particle.size * (particle.firefly ? 1.25 : 1);
      context.fillRect(Math.round(x), Math.round(y), size, size);
    }
    context.globalAlpha = 1;
  }, []);

  useEffect(() => {
    const update = () => setPageVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    const element = sceneRef.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry) setInView(entry.isIntersecting);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!motionEnabled) resetPointer();
  }, [motionEnabled, resetPointer]);

  useEffect(() => {
    const press = (event: MouseEvent) => {
      if (event.button === 0) setInteracting(true);
    };
    const release = () => setInteracting(false);
    window.addEventListener("pointerdown", press, true);
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
    window.addEventListener("blur", release);
    document.addEventListener("dragstart", press, true);
    document.addEventListener("dragend", release, true);
    return () => {
      window.removeEventListener("pointerdown", press, true);
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", release, true);
      window.removeEventListener("blur", release);
      document.removeEventListener("dragstart", press, true);
      document.removeEventListener("dragend", release, true);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const scene = sceneRef.current;
    if (!canvas || !scene) return;
    const resize = () => {
      const bounds = scene.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, WORLD_CANVAS_PIXEL_RATIO_MAX);
      canvasSize.current = { width: bounds.width, height: bounds.height };
      canvas.width = Math.max(1, Math.round(bounds.width * ratio));
      canvas.height = Math.max(1, Math.round(bounds.height * ratio));
      try {
        canvas.getContext("2d")?.setTransform(ratio, 0, 0, ratio, 0, 0);
      } catch {
        canvasSize.current = { width: 0, height: 0 };
      }
    };
    resize();
    const themeObserver = new MutationObserver(() => {
      particlePalette.current = null;
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(scene);
    return () => {
      observer?.disconnect();
      themeObserver.disconnect();
    };
  }, []);

  useEffect(() => {
    const target = !reducedMotion && (state === "preparing" || state === "running")
      ? WORLD_CAMERA.pushScale
      : 1;
    if (cameraPush.current.target === target) return;
    cameraPush.current = {
      from: cameraScale.current,
      target,
      startedAt: performance.now(),
    };
  }, [reducedMotion, state]);

  useEffect(() => {
    if (frameRef.current !== null && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    previousFrameTime.current = 0;
    if (reducedMotion || paused) {
      snapSpring(camera.current.x, 0);
      snapSpring(camera.current.y, 0);
      paintCamera(reducedMotion ? 1 : cameraScale.current, false);
      return;
    }
    if (!motionEnabled) {
      snapSpring(camera.current.x, 0);
      snapSpring(camera.current.y, 0);
    }
    const tick = (now: number) => {
      const seconds = previousFrameTime.current
        ? (now - previousFrameTime.current) / 1000
        : 1 / 60;
      previousFrameTime.current = now;
      const push = cameraPush.current;
      const pushProgress = clamp((now - push.startedAt) / OVERTURE_STAGE_MS, 0, 1);
      const easedPush = 1 - Math.pow(1 - pushProgress, 3);
      const scale = push.from + (push.target - push.from) * easedPush;
      const pushAnimating = pushProgress < 1 && push.target !== push.from;
      const ambientFrame = motionEnabled && !pushAnimating;
      if (ambientFrame) {
        camera.current.x.goal = pointerGoal.current.x;
        camera.current.y.goal = pointerGoal.current.y;
        advanceSpring(camera.current.x, seconds, WORLD_CAMERA.spring);
        advanceSpring(camera.current.y, seconds, WORLD_CAMERA.spring);
      }
      sceneRef.current?.setAttribute("data-ambient", String(ambientFrame));
      paintCamera(scale, ambientFrame);
      if (ambientFrame) drawParticles(now);
      if (motionEnabled || pushProgress < 1) {
        frameRef.current = requestAnimationFrame(tick);
      } else {
        frameRef.current = null;
        previousFrameTime.current = 0;
      }
    };
    if (typeof requestAnimationFrame !== "undefined") {
      frameRef.current = requestAnimationFrame(tick);
    }
    return () => {
      if (frameRef.current !== null && typeof cancelAnimationFrame !== "undefined") {
        cancelAnimationFrame(frameRef.current);
      }
      frameRef.current = null;
      previousFrameTime.current = 0;
    };
  }, [drawParticles, motionEnabled, paintCamera, paused, reducedMotion, state]);

  const movePointer = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!motionEnabled || event.pointerType === "touch") return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const x = ((event.clientX - bounds.left) / bounds.width - 0.5) * 2;
      const y = ((event.clientY - bounds.top) / bounds.height - 0.5) * 2;
      pointerGoal.current = { x: clamp(x, -1, 1), y: clamp(y, -1, 1) };
    },
    [motionEnabled],
  );

  return (
    <div ref={sceneRef} className={`world-scene${className ? ` ${className}` : ""}`}
      aria-hidden="true" data-motion={reducedMotion ? "reduced" : "full"}
      data-paused={paused ? "true" : "false"} data-scene-state={state}
      data-scene-progress={normalizedProgress} data-ambient={motionEnabled ? "true" : "false"}
      data-interacting={interacting ? "true" : "false"} data-parallax-layers="4"
      style={{ "--world-light-cycle": `${WORLD_LIGHT_CYCLE_MS}ms` } as CSSProperties}
      onPointerMove={movePointer} onPointerLeave={resetPointer} onPointerCancel={resetPointer}>
      <div className="world-scene__camera">
      <svg className="world-scene__canvas" width="100%" height="100%" viewBox="0 0 1280 720"
        preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id={skyId} x2="0" y2="1">
            <stop stopColor="var(--world-sky-top)" /><stop offset=".43" stopColor="var(--world-sky-mid)" />
            <stop offset=".72" stopColor="var(--world-sky-horizon)" /><stop offset="1" stopColor="var(--world-sky-bottom)" />
          </linearGradient>
          <radialGradient id={sunId}>
            <stop stopColor="var(--world-sun-core)" stopOpacity=".68" /><stop offset=".35" stopColor="var(--world-sun-mid)" stopOpacity=".22" /><stop offset="1" stopColor="var(--world-sun-edge)" stopOpacity="0" />
          </radialGradient>
          <linearGradient id={earthId} x2=".4" y2="1"><stop stopColor="var(--world-earth-top)" /><stop offset="1" stopColor="var(--world-earth-bottom)" /></linearGradient>
          <linearGradient id={waterId} x2=".6" y2="1"><stop stopColor="var(--world-water-top)" /><stop offset=".4" stopColor="var(--world-water-mid)" /><stop offset="1" stopColor="var(--world-water-bottom)" /></linearGradient>
          <linearGradient id={beamId} x2="0" y2="1"><stop stopColor="var(--world-sun-core)" stopOpacity=".2" /><stop offset="1" stopColor="var(--world-sun-core)" stopOpacity="0" /></linearGradient>
          <clipPath id={clipId}><rect width="1280" height="720" /></clipPath>
        </defs>
        <g clipPath={`url(#${clipId})`}>
          <rect width="1280" height="720" fill={`url(#${skyId})`} />
          <g className="world-scene__atmosphere">
            <ellipse className="world-scene__dawn-glow" cx="960" cy="245" rx="430" ry="330" fill={`url(#${sunId})`} />
            <rect x="928" y="182" width="56" height="56" fill="#f5ddaf" opacity=".96" />
            <g className="world-scene__clouds" fill="#f5e4ce">
              <path d="M555 158h118v-8h86v8h42v12H555z" opacity=".19" />
              <path d="M1004 116h97v-9h108v9h83v14h-288z" opacity=".22" />
              <path d="M314 92h111v-7h56v7h90v10H314z" opacity=".12" />
            </g>
          </g>
          <g ref={farLayerRef} data-parallax="far" data-parallax-layer="far">
            <path d="M0 355V260h75v-32h38v-25h45v-37h40v31h35v-17h35v-30h35v-29h41v-26h31v29h28v32h37v42h50v36h48v34h52v-20h43v-35h37v-23h31v-32h35v-27h34v-25h30v-23h28v25h28v44h27v39h35v37h50v26h54v-32h31v-41h28v-47h28v-35h28v-45h25v-28h24v-37h28v-29h27v36h24v31h28v38h27v34h26v42h36v36h42v110z" fill="var(--world-mountain-far)" />
            <path d="M1008 178h28v-28h24v-37h28V84h27v36h24v31h28v38h-31v-16h-27v-22h-25v29h-30v25h-46zM268 156h35v-29h41v-26h31v29h28v32h-39v-14h-25v18h-39v19h-32z" fill="var(--world-mountain-snow)" opacity=".78" />
            <path d="M1101 151h14v26h24v49h28v44h36v48h43v46h34v63h-204V290h-28v-46h29v-42h24z" fill="#6b7680" opacity=".7" />
            <path d="M0 374V332h80v-40h47v-31h55v24h46v45h43v-21h40v-38h40v-29h49v-29h42v33h31v35h48v35h48v28h43v-33h42v-34h33v-26h34v-36h40v25h33v35h40v37h43v36h48v-23h43v-36h38v-33h34v-27h36v29h37v34h42v43h64v103z" fill="var(--world-mountain-ridge)" />
            <path d="M0 427V368h105v-28h68v32h63v-27h53v-34h44v31h45v35h80v-24h47v-40h47v30h44v30h64v-24h45v-30h43v22h50v35h63v-25h52v-32h52v29h44v26h70v-41h47v-27h42v41h59v88z" fill="var(--world-mountain-mid)" />
            <g opacity=".5">{[510, 549, 605, 650, 702, 775, 813, 862, 937, 979].map((x, i) => <VoxelPine key={x} x={x} y={385 + i % 3 * 8} scale={.22 + i % 3 * .06} distant />)}</g>
          </g>
          <g className="world-scene__light-beams" fill={`url(#${beamId})`}>
            <path d="M928 198h56L734 720H380z" opacity=".6" /><path d="M971 198h13l-1 522H866z" opacity=".3" />
          </g>
          <g ref={middleLayerRef} data-parallax="middle" data-parallax-layer="middle">
          <path d="M0 424 393 393 642 413 756 387 860 407 1000 397 1280 438V720H0z" fill="var(--world-ground)" />
          <path d="m754 393 30 2-13 38 72 29-55 49 144 57-72 59 267 93H494l255-117-58-70 87-59-51-41z" fill={`url(#${waterId})`} />
          <g className="world-scene__water" fill="none" stroke="#e5d7b6" strokeWidth="2" opacity=".4">
            <path d="M742 434h33m14 34h39m-74 47h39m39 53h59m-165 37h73m88 32h115" />
            <path d="M770 447h19m-28 44h28m35 53h35m-83 34h29m72 37h34" opacity=".6" />
          </g>
          </g>
          <g ref={foregroundLayerRef} data-parallax="near" data-parallax-layer="foreground">
            <g className="world-scene__landmass">
              <path d="M0 368h161v28h140v29h119v31h117v34h93v43h65v58l-99 129H0z" fill={`url(#${earthId})`} />
              <path d="M0 360h161v28h140v29h119v31h117v34h93v25h-74v-16H442v-27H330v-30H200v-28H0z" fill="#68785d" />
              <path d="M0 480h242v23h118v30h106v25h77v32h72v31h-70v-20h-87v-31H341v-26H220v-29H0z" fill="#4a5147" />
              <path d="M0 584h165v21h129v32h113v32h73v51H0z" fill="#303e3d" />
              <path d="M1280 298h-78v38h-63v37h-57v37h-69v32h-54v35h-53v32h-43v54l131 157h386z" fill={`url(#${earthId})`} />
              <path d="M1280 290h-78v38h-63v37h-57v37h-69v32h-54v35h-53v32h-43v25h45v-18h52v-29h56v-33h63v-34h62v-38h61v-36h78z" fill="var(--world-grass)" />
              <path d="M1280 400h-84v39h-76v34h-69v35h-65v33h-72v30h97v-26h68v-27h65v-34h67v-34h69z" fill="#555a4b" />
              <path d="M1280 507h-100v29h-82v28h-71v31h-62v42l122 83h193z" fill="#344343" />
              <g className="world-scene__terrain" fill="#b1a38a" opacity=".18">
                {Array.from({ length: 32 }, (_, i) => <rect key={i} x={i < 16 ? i % 5 * 105 + 32 : 950 + i % 4 * 86} y={448 + i % 7 * 29} width={17 + i % 3 * 9} height={10 + i % 2 * 8} />)}
              </g>
              <g opacity=".8"><VoxelPine x={544} y={472} scale={.52} /><VoxelPine x={482} y={445} scale={.65} /><VoxelPine x={1084} y={412} scale={.65} /><VoxelPine x={1157} y={374} scale={.82} /></g>
              <VoxelPine x={1170} y={555} scale={1.7} /><VoxelPine x={1280} y={500} scale={2.15} />
              <VoxelPine x={250} y={498} scale={1.1} />
              <path d="M940 612h101v-26h94v-26h145v160H840v-55h100z" fill="#334c43" />
              <path d="M940 605h101v-26h94v-26h145v16h-138v27h-94v26H947v41H840v-12h100z" fill="#849072" />
              <path d="M947 622h101v-26h94v-27h138v50h-130v24h-109v26H947z" fill="#5d6650" />
              <g className="world-scene__pixels" fill="#a5ad7d" opacity=".5"><path d="M1017 598v-11m-5 13v-8m9 6v-5M1108 575v-14m-5 17v-10m11 8v-6M1211 550v-15m-6 17v-9m12 8v-11" stroke="#a5ad7d" strokeWidth="3" /></g>
            </g>
          </g>
          <g className="world-scene__world-aura" transform="translate(861 419)">
            <ellipse className="world-scene__beacon-halo" rx="36" ry="23" fill={`url(#${sunId})`} opacity=".3" />
            <g className="world-scene__beacon">
              <path d="M-3 0v-26h6V0z" fill="#504b40" /><path d="M-6-30H6v10H-6z" fill="#655c48" />
              <path data-scene-beacon="" d="M-4-28H4v6H-4z" fill={beaconColors[state]} />
              <path className="world-scene__beacon-progress" data-beacon-progress={beaconProgress} d="M-5-17H5" pathLength="100" stroke={beaconColors[state]} strokeWidth="2" strokeDasharray="100" strokeDashoffset={100 - beaconProgress} />
            </g>
          </g>
          <path className="world-scene__energy-trail" d="M928 236h56" fill="none" stroke="#f5ddaf" strokeWidth="1" opacity=".1" />
        </g>
      </svg>
      <canvas ref={canvasRef} className="world-scene__particle-canvas world-scene__particles world-scene__pixel--a" aria-hidden="true" />
      </div>
    </div>
  );
}
