import { useTranslation } from "react-i18next";
import type { CSSProperties } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Image, X } from "lucide-react";
import { command, type Config } from "../../lib/launcher";
import { useAppearance } from "../../app/AppearanceProvider";
import { Button } from "../../components/ui/Button";
import { Select } from "../../components/ui/Select";
import type { SettingsSectionProps } from "./types";

const accentPresets = ["#b4f17a", "#78ded5", "#a9a2ef", "#f1b889", "#ee9ec5", "#86bbf4"];

export function AppearanceSettings({ config, onChange, onPersistedPatch, onError, onNotice }: SettingsSectionProps) {
  const { t } = useTranslation();
  const appearance = useAppearance();

  async function background(path?: string) {
    try {
      const selected = path === undefined
        ? await open({
            multiple: false,
            directory: false,
            title: t("settings:background.picker"),
            filters: [{ name: t("settings:background.filter"), extensions: ["png", "jpg", "jpeg", "webp"] }],
          })
        : path;
      if (selected === undefined || selected === null || typeof selected !== "string" && path === undefined) return;
      const next = await command<Config>("set_launcher_background", { path: selected || null });
      await onPersistedPatch({ customBackground: next.customBackground });
      onNotice(selected ? "backgroundUpdated" : "backgroundCleared");
    } catch (cause) {
      onError(cause);
    }
  }

  return (
    <div className="vx-settings-section">
      <header><h2>{t("settings:section.appearance")}</h2><p>{t("settings:appearanceDescription")}</p></header>
      <section className="vx-settings-group">
        <div className="vx-settings-fields">
          <label>
            {t("settings:fields.theme")}
            <Select
              aria-label={t("settings:fields.theme")}
              value={config.theme}
              onChange={(v) => onChange({ ...config, theme: v as Config["theme"] })}
              options={[
                { value: "dark", label: t("settings:theme.dark") },
                { value: "light", label: t("settings:theme.light") },
                { value: "system", label: t("settings:theme.system") },
              ]}
            />
          </label>
          <label>
            {t("settings:fields.language")}
            <Select
              aria-label={t("settings:fields.language")}
              value={config.language}
              onChange={(v) => onChange({ ...config, language: v })}
              options={[
                { value: "system", label: t("settings:language.system") },
                { value: "zh-CN", label: "简体中文" },
                { value: "en-US", label: "English" },
              ]}
            />
          </label>
          <label>
            {t("settings:fields.effects")}
            <Select
              aria-label={t("settings:fields.effects")}
              value={config.effects}
              onChange={(v) => onChange({ ...config, effects: v as Config["effects"] })}
              options={[
                { value: "lite", label: t("settings:effects.lite") },
                { value: "full", label: t("settings:effects.full") },
              ]}
            />
          </label>
          <label>
            {t("settings:fields.accentSource")}
            <Select
              aria-label={t("settings:fields.accentSource")}
              value={config.accentSource}
              onChange={(v) => onChange({ ...config, accentSource: v as Config["accentSource"] })}
              options={[
                { value: "voxelight", label: t("settings:accent.voxelight") },
                { value: "system", label: t("settings:accent.system") },
                { value: "custom", label: t("settings:accent.custom") },
              ]}
            />
          </label>
          {config.accentSource === "custom" ? (
            <label>
              {t("settings:fields.accentColor")}
              <input aria-label={t("settings:fields.accentColor")} type="color" value={config.accentColor} onChange={(event) => onChange({ ...config, accentColor: event.target.value })} />
            </label>
          ) : null}
          <label className="vx-settings-check">
            <input type="checkbox" aria-label={t("settings:fields.sound")} checked={config.soundEnabled} onChange={(event) => onChange({ ...config, soundEnabled: event.target.checked })} />
            <span>{t("settings:fields.sound")}<small>{t("settings:soundDescription")}</small></span>
          </label>
        </div>
        {config.accentSource === "system" ? <span className="vx-settings-system-accent" style={{ "--system-accent": appearance.accentColor } as CSSProperties}>{t("settings:accent.systemCurrent", { color: appearance.accentColor })}</span> : null}
        {config.accentSource === "custom" ? (
          <div className="vx-settings-swatches" aria-label={t("settings:accent.presets")}>
            {accentPresets.map((color) => (
              <button
                key={color}
                type="button"
                className="vx-settings-swatch"
                aria-label={t("settings:accent.preset", { color })}
                aria-pressed={config.accentColor.toLowerCase() === color}
                style={{ background: color }}
                onClick={() => onChange({ ...config, accentSource: "custom", accentColor: color })}
              />
            ))}
          </div>
        ) : null}
      </section>

      <section className="vx-settings-group">
        <h3>{t("settings:background.title")}</h3>
        <p>{t("settings:background.description")}</p>
        <div className="vx-action-row">
          <Button variant="secondary" icon={<Image size={15} />} onClick={() => void background()}>{t("settings:background.choose")}</Button>
          {config.customBackground ? <Button variant="ghost" icon={<X size={15} />} onClick={() => void background("")}>{t("settings:background.reset")}</Button> : null}
        </div>
      </section>
    </div>
  );
}
