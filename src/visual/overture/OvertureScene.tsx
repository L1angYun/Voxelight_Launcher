import { useCallback, useRef, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { WorldScene, type WorldSceneState } from "../../components/WorldScene";
import { CharacterCanvas } from "../character/CharacterCanvas";
import { useOverture } from "./OvertureProvider";
import {
  OVERTURE_IRIS_BLADE_COUNT,
  OVERTURE_STAGE_MS,
  OVERTURE_STATIC_MS,
  WORLD_CAMERA,
  WORLD_PARALLAX_DEPTHS,
} from "./motion";
import { cn } from "../../lib/utils";
import "./overture.css";

export function OvertureScene({
  skinUrl,
  capeUrl,
  model = "auto",
  paused = false,
  interactive = false,
  sceneId = "default",
  label,
  characterFallback,
  className,
  children,
  state = "idle",
  progress = 0,
}: {
  skinUrl?: string | null;
  capeUrl?: string | null;
  model?: "auto" | "classic" | "slim";
  paused?: boolean;
  interactive?: boolean;
  sceneId?: string;
  label?: string;
  characterFallback?: ReactNode;
  className?: string;
  children?: ReactNode;
  state?: WorldSceneState;
  progress?: number;
}) {
  const { current, playing, reducedMotion } = useOverture();
  const { t } = useTranslation();
  const characterCameraRef = useRef<HTMLDivElement>(null);
  const staticMotion = paused || reducedMotion;
  const ambientPaused = staticMotion || playing;
  const updateCharacterCamera = useCallback((pose: { x: number; y: number; scale: number }) => {
    const camera = characterCameraRef.current;
    if (!camera) return;
    const x = pose.x * WORLD_CAMERA.maxOffsetPx * WORLD_PARALLAX_DEPTHS.character;
    const y = pose.y * WORLD_CAMERA.maxOffsetPx * WORLD_PARALLAX_DEPTHS.character * 0.62;
    camera.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) scale(${pose.scale.toFixed(4)})`;
  }, []);

  return (
    <div
      className={cn("vx-overture-scene", className)}
      data-event={current?.kind ?? ""}
      data-playing={playing}
      data-motion={staticMotion ? "static" : "full"}
      data-scene={sceneId}
      data-visual-owner="overture"
      style={{
        "--overture-stage-duration": `${OVERTURE_STAGE_MS}ms`,
        "--overture-static-duration": `${OVERTURE_STATIC_MS}ms`,
      } as CSSProperties}
    >
      <div key={sceneId} className="vx-overture-scene__media" aria-hidden="true">
        <WorldScene
          className="vx-overture-scene__landscape"
          state={state}
          progress={progress}
          paused={ambientPaused}
          onCameraFrame={updateCharacterCamera}
        />
      </div>
      <div className="vx-overture-scene__character-frame">
        <div
          ref={characterCameraRef}
          className="vx-overture-scene__character-camera"
          data-parallax="character"
          data-parallax-layer="character"
        >
          <div className="vx-overture-scene__viewfinder" aria-hidden="true">
            <svg viewBox="0 0 320 420" focusable="false">
              <ellipse cx="160" cy="210" rx="150" ry="196" />
            </svg>
          </div>
          {skinUrl ? (
            <CharacterCanvas
              className="vx-overture-scene__character"
              skinUrl={skinUrl}
              capeUrl={capeUrl}
              model={model}
              paused={ambientPaused}
              interactive={interactive}
              autoRotate={false}
              animation={state === "running" ? "run" : state === "preparing" ? "walk" : "idle"}
              label={label ?? t("home:defaultPreview")}
            />
          ) : characterFallback ?? null}
          {playing ? (
            <div key={current?.id} className="vx-overture-scene__aperture" data-kind={current?.kind} aria-hidden="true">
              <svg className="vx-overture-scene__optics" viewBox="0 0 320 420" focusable="false">
                <g className="vx-overture-scene__blades">
                  {Array.from({ length: OVERTURE_IRIS_BLADE_COUNT }, (_, index) => (
                    <g key={index} transform={`rotate(${index * (360 / OVERTURE_IRIS_BLADE_COUNT)} 160 210)`}>
                      <path className="vx-overture-scene__blade" d="M160 42A168 168 0 0 1 278.8 91.2L239.2 130.8A112 112 0 0 0 160 98Z" />
                    </g>
                  ))}
                </g>
              </svg>
            </div>
          ) : null}
        </div>
      </div>
      <div className="vx-overture-scene__scrim" aria-hidden="true" />
      <div className="vx-overture-scene__content">{children}</div>
    </div>
  );
}
