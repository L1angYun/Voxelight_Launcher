// SPDX-License-Identifier: GPL-3.0-only
import { useTranslation } from "react-i18next";
import { Box, Minus, X } from "lucide-react";
import { IconButton } from "../../../src/components/ui/Button";

export interface SetupChromeProps {
  closeDisabled: boolean;
  onMinimize: () => void;
  onClose: () => void;
}

export function SetupChrome({ closeDisabled, onMinimize, onClose }: SetupChromeProps) {
  const { t } = useTranslation("setup");
  return (
    <header className="vx-setup-chrome" data-tauri-drag-region>
      <div className="vx-setup-chrome__bar" data-tauri-drag-region>
        <div className="vx-setup-chrome__identity" data-tauri-drag-region>
          <span className="vx-setup-chrome__brand" data-tauri-drag-region>
            <Box size={19} strokeWidth={1.6} aria-hidden="true" />
            <span>{t("app.setupName")}</span>
          </span>
        </div>
        <div className="vx-setup-chrome__drag" data-tauri-drag-region aria-hidden="true" />
        <div
          className="vx-setup-chrome__controls"
          role="group"
          aria-label={t("chrome.windowControls")}
        >
          <IconButton
            size="sm"
            label={t("chrome.minimize")}
            icon={<Minus size={15} />}
            onClick={onMinimize}
          />
          <IconButton
            size="sm"
            className="vx-setup-chrome__close"
            label={closeDisabled ? t("chrome.closeBlocked") : t("chrome.close")}
            icon={<X size={16} />}
            disabled={closeDisabled}
            onClick={onClose}
          />
        </div>
      </div>
    </header>
  );
}
