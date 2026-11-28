import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Box, Copy, Maximize2, Minus, X } from "lucide-react";
import { IconButton } from "../components/ui/Button";
import { ICON } from "../design/icons";
import { getLauncherWindow } from "../lib/window";
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

  return (
    <header
      className="vx-window-chrome"
      data-window-state={maximized ? "maximized" : "normal"}
      data-tauri-drag-region="deep"
    >
      <div className="vx-window-chrome__bar">
        <div className="vx-window-chrome__identity">
          <div className="vx-window-chrome__brand" aria-label={t("shell:brand.name")}><Box size={ICON.lg} aria-hidden="true" /><span>Voxelight</span></div>
          <div
            className="vx-window-chrome__drag"
            aria-hidden="true"
          />
        </div>
        {children}
        <div className="vx-window-chrome__controls" role="group" aria-label={t("common:a11y.windowControls")}>
          <IconButton size="sm" label={t("common:actions.minimize")} icon={<Minus />} onClick={() => void getLauncherWindow()?.minimize()} />
          <IconButton
            size="sm"
            label={maximized ? t("common:actions.restore") : t("common:actions.maximize")}
            icon={maximized ? <Copy /> : <Maximize2 />}
            onClick={() => void toggleMaximize()}
          />
          <IconButton size="sm" label={t("common:actions.close")} icon={<X />} onClick={() => void getLauncherWindow()?.close()} />
        </div>
      </div>
    </header>
  );
}
