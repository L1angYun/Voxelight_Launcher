// SPDX-License-Identifier: GPL-3.0-only
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { command } from "../lib/launcher";
import { useLauncher } from "./controller/LauncherProvider";
import { useAppearance } from "./AppearanceProvider";
import type { NavigationPage } from "./FloatingNav";
import "./home-background.css";

/** Settings dispatches this after `set_launcher_background` succeeds with the
 *  same path, so re-picking a file whose contents changed on disk still
 *  refreshes the background. Defined as a literal in both places to keep the
 *  settings section independent from this component and its stylesheet. */
const REFRESH_EVENT = "vx:home-background-refresh";
const CROSSFADE_MS = 220;

interface LoadedImage {
  url: string;
  backgroundImage: string;
}

interface OutgoingImage {
  backgroundImage: string;
  token: number;
}

/**
 * Shows the user-selected launcher background across all pages, with
 * configurable blur, dim scrim, and optional slow drift.
 */
export function AppBackground({ onImageShownChange }: {
  page?: NavigationPage;
  /** Lets the shell pause the covered world scene while this layer is active. */
  onImageShownChange?: (shown: boolean) => void;
}) {
  const { bootstrapped, config } = useLauncher();
  const { effects, reducedMotion, highContrast } = useAppearance();
  const staticMotion = effects !== "full" || reducedMotion || highContrast;
  const blurPx = config.backgroundBlur ?? 8;
  const dim = config.backgroundDim ?? 35;
  const drift = !staticMotion && Boolean(config.backgroundDrift);
  const [image, setImage] = useState<LoadedImage | null>(null);
  const [outgoing, setOutgoing] = useState<OutgoingImage | null>(null);
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  const swapToken = useRef(0);
  const currentImageRef = useRef<LoadedImage | null>(null);
  const canCrossfadeRef = useRef(false);
  canCrossfadeRef.current = !staticMotion;

  useEffect(() => {
    const requestRefresh = () => setRefresh((value) => value + 1);
    window.addEventListener(REFRESH_EVENT, requestRefresh);
    return () => window.removeEventListener(REFRESH_EVENT, requestRefresh);
  }, []);

  useEffect(() => {
    if (!bootstrapped) return;
    const request = ++generation.current;
    let active = true;
    let preload: HTMLImageElement | null = null;
    const isCurrent = () => active && request === generation.current;
    const releasePreload = () => {
      if (!preload) return;
      preload.onload = null;
      preload.onerror = null;
      preload = null;
    };
    const commitImage = (nextUrl: string | null) => {
      const previous = currentImageRef.current;
      if (!nextUrl) {
        currentImageRef.current = null;
        setOutgoing(null);
        setImage(null);
        return;
      }
      if (previous?.url === nextUrl) return;
      // Build the CSS string once per loaded image so progress/log-driven
      // renders never re-stringify a multi-MB data URL.
      const next: LoadedImage = {
        url: nextUrl,
        backgroundImage: `url(${JSON.stringify(nextUrl)})`,
      };
      currentImageRef.current = next;
      if (previous && canCrossfadeRef.current) {
        setOutgoing({ backgroundImage: previous.backgroundImage, token: ++swapToken.current });
      } else {
        setOutgoing(null);
      }
      setImage(next);
    };

    void command<string | null>("get_launcher_background")
      .then((url) => {
        if (!isCurrent()) return;
        if (!url) {
          commitImage(null);
          return;
        }
        preload = new Image();
        preload.onload = () => {
          releasePreload();
          if (isCurrent()) commitImage(url);
        };
        preload.onerror = () => {
          releasePreload();
          if (isCurrent()) commitImage(null);
        };
        preload.src = url;
      })
      .catch(() => {
        if (isCurrent()) commitImage(null);
      });

    return () => {
      active = false;
      releasePreload();
    };
  }, [bootstrapped, config.customBackground, refresh]);

  useEffect(() => {
    if (!outgoing) return;
    if (staticMotion || !image) {
      setOutgoing(null);
      return;
    }
    const timer = window.setTimeout(() => setOutgoing(null), CROSSFADE_MS);
    return () => window.clearTimeout(timer);
  }, [outgoing, staticMotion, image]);

  useEffect(() => {
    onImageShownChange?.(Boolean(image));
  }, [image, onImageShownChange]);

  if (!image) return null;

  return (
    <div
      className="vx-app-background vx-home-background"
      data-app-background=""
      data-home-background=""
      data-visible="true"
      data-motion={staticMotion ? "reduced" : "full"}
      data-drift={drift ? "true" : "false"}
      aria-hidden="true"
      style={{
        "--background-blur-px": String(blurPx),
        "--background-dim": (dim / 100).toFixed(2),
        opacity: 1,
        pointerEvents: "none",
      } as CSSProperties}
    >
      <span
        className="vx-app-background__image"
        data-app-background-image=""
        style={{ backgroundImage: image.backgroundImage }}
      />
      {outgoing && !staticMotion ? (
        <span
          key={outgoing.token}
          className="vx-app-background__outgoing vx-home-background__outgoing"
          data-home-background-outgoing=""
          style={{ backgroundImage: outgoing.backgroundImage }}
          onAnimationEnd={() => setOutgoing(null)}
        />
      ) : null}
    </div>
  );
}

export const HomeBackground = AppBackground;
