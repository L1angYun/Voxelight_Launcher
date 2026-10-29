import { useEffect, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Box, Copy, Maximize2, Minus, X } from "lucide-react";
import { IconButton } from "../components/ui/Button";
import { getLauncherWindow } from "../lib/window";
import { GlassSurface } from "../visual/glass/GlassSystem";
import "./shell.css";

export function WindowChrome({ children }: { children?: ReactNode }) {
  const { t } = useTranslation();
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const window = getLauncherWindow();
    if (!window) return;
    let active = true;
    const update = () => void window.isMaximized().then((value) => {
      if (!active) return;
      setMaximized(value);
      document.documentElement.dataset.windowState = value ? "maximized" : "normal";
    }).catch(() => {});
    update();
    const unlisten = window.onResized(update);
    return () => {
      active = false;
      void unlisten.then((dispose) => dispose()).catch(() => {});
    };
  }, []);

  async function toggleMaximize() {
    const window = getLauncherWindow();
    if (!window) return;
    await window.toggleMaximize();
    const value = await window.isMaximized();
    setMaximized(value);
    document.documentElement.dataset.windowState = value ? "maximized" : "normal";
  }

  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    // Allow dragging from any part of the drag region, including child elements.
    // Interactive children (buttons) stop propagation so they never reach here.
    if (event.detail < 2) void getLauncherWindow()?.startDragging();
  }

  return (
    <header className="vx-window-chrome" data-window-state={maximized ? "maximized" : "normal"}>
      <GlassSurface variant="nav" className="vx-window-chrome__bar">
        <div className="vx-window-chrome__identity">
          <div className="vx-window-chrome__brand" aria-label={t("shell:brand.name")}><Box size={23} strokeWidth={1.5} aria-hidden="true" /><span>Voxelight</span></div>
          <div
            className="vx-window-chrome__drag"
            data-tauri-drag-region="true"
            onPointerDown={startDrag}
            onDoubleClick={() => void toggleMaximize()}
            aria-hidden="true"
          />
        </div>
        {children}
        <div className="vx-window-chrome__controls" role="group" aria-label={t("common:a11y.windowControls")}>
          <IconButton label={t("common:actions.minimize")} icon={<Minus size={16} />} onClick={() => void getLauncherWindow()?.minimize()} />
          <IconButton
            label={maximized ? t("common:actions.restore") : t("common:actions.maximize")}
            icon={maximized ? <Copy size={14} /> : <Maximize2 size={15} />}
            onClick={() => void toggleMaximize()}
          />
          <IconButton label={t("common:actions.close")} icon={<X size={17} />} onClick={() => void getLauncherWindow()?.close()} />
        </div>
      </GlassSurface>
    </header>
  );
}
