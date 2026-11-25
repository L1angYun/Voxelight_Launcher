// SPDX-License-Identifier: GPL-3.0-only
import { useEffect, useMemo, useRef, useState } from "react";
import { command } from "../lib/launcher";
import { useLauncher } from "./controller/LauncherProvider";
import { useAppearance } from "./AppearanceProvider";
import type { NavigationPage } from "./FloatingNav";
import "./home-background.css";

/** Settings dispatches this after `set_launcher_background` succeeds with the
 *  same path, so re-picking a file whose contents changed on disk still
 *  refreshes Home. Defined as a literal in both places to keep the settings
 *  section independent from this component and its stylesheet. */
const REFRESH_EVENT = "vx:home-background-refresh";

/**
 * Shows the user-selected launcher background above the global world scene.
 * The image is only shown on Home so the world scene stays the shared
 * background everywhere else.
 */
export function HomeBackground({ page, onImageShownChange }: {
  page: NavigationPage;
  /** Lets the shell pause the covered world scene while this layer is opaque. */
  onImageShownChange?: (shown: boolean) => void;
}) {
  const { bootstrapped, config } = useLauncher();
  const { effects, reducedMotion, highContrast } = useAppearance();
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);

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

    void command<string | null>("get_launcher_background")
      .then((url) => {
        if (!isCurrent()) return;
        if (!url) {
          setImageUrl(null);
          return;
        }
        preload = new Image();
        preload.onload = () => {
          releasePreload();
          if (isCurrent()) setImageUrl(url);
        };
        preload.onerror = () => {
          releasePreload();
          if (isCurrent()) setImageUrl(null);
        };
        preload.src = url;
      })
      .catch(() => {
        if (isCurrent()) setImageUrl(null);
      });

    return () => {
      active = false;
      releasePreload();
    };
  }, [bootstrapped, config.customBackground, refresh]);

  // Build the CSS string once per image. Rebuilding `url(<multi-MB data URL>)`
  // inside a render would make every progress/log-driven Home render allocate
  // and compare the full string again.
  const backgroundImage = useMemo(
    () => imageUrl ? `url(${JSON.stringify(imageUrl)})` : undefined,
    [imageUrl],
  );

  useEffect(() => {
    onImageShownChange?.(Boolean(imageUrl));
  }, [imageUrl, onImageShownChange]);

  if (!imageUrl) return null;

  const visible = page === "home";
  const staticMotion = effects !== "full" || reducedMotion || highContrast;

  return (
    <div
      key={imageUrl}
      className="vx-home-background"
      data-home-background=""
      data-visible={visible}
      data-motion={staticMotion ? "reduced" : "full"}
      aria-hidden="true"
      style={{
        backgroundImage,
        opacity: visible ? 1 : 0,
        pointerEvents: "none",
      }}
    />
  );
}
