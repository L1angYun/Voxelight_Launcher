import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { Folder } from "lucide-react";
import { Button } from "../../components/ui/Button";
import type { SettingsSectionProps } from "./types";

export function GameSettings({ config, onChange, onError }: SettingsSectionProps) {
  const { t } = useTranslation();

  async function chooseDirectory() {
    try {
      const path = await open({ directory: true, multiple: false, title: t("settings:game.directoryPicker") });
      if (typeof path === "string") onChange({ ...config, gameDirectory: path });
    } catch (cause) {
      onError(cause);
    }
  }

  return (
    <div className="vx-settings-section">
      <header><h2>{t("settings:section.game")}</h2><p>{t("settings:gameDescription")}</p></header>
      <section className="vx-settings-group">
        <label>
          {t("settings:fields.gameDirectory")}
          <span className="vx-settings-input-action">
            <input aria-label={t("settings:fields.gameDirectory")} value={config.gameDirectory} onChange={(event) => onChange({ ...config, gameDirectory: event.target.value })} />
            <Button variant="secondary" icon={<Folder size={15} />} onClick={() => void chooseDirectory()}>{t("settings:game.browse")}</Button>
          </span>
        </label>
        <label className="vx-settings-check">
          <input type="checkbox" aria-label={t("settings:fields.versionIsolation")} checked={config.versionIsolation} onChange={(event) => onChange({ ...config, versionIsolation: event.target.checked })} />
          <span>{t("settings:fields.versionIsolation")}<small>{t("settings:game.isolationDescription")}</small></span>
        </label>
        <div className="vx-settings-fields">
          <label>
            {t("settings:fields.screenWidth")}
            <input aria-label={t("settings:fields.screenWidth")} type="number" min={320} max={16384} value={config.screenWidth} onChange={(event) => onChange({ ...config, screenWidth: Number(event.target.value) })} />
          </label>
          <label>
            {t("settings:fields.screenHeight")}
            <input aria-label={t("settings:fields.screenHeight")} type="number" min={240} max={16384} value={config.screenHeight} onChange={(event) => onChange({ ...config, screenHeight: Number(event.target.value) })} />
          </label>
        </div>
      </section>
    </div>
  );
}
