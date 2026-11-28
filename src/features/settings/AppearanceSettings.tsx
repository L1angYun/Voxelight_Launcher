import { useTranslation } from "react-i18next";
import { useId, useRef, type CSSProperties, type KeyboardEvent } from "react";
import { pickLauncherPath } from "../../lib/nativePaths";
import { Image, RotateCcw, X } from "lucide-react";
import { DEFAULT_ACCENT } from "../../design/accent";
import { ACCENT_PRESETS } from "../../design/accentPresets";
import { command, type Config } from "../../lib/launcher";
import { useAppearance } from "../../app/AppearanceProvider";
import { Button } from "../../components/ui/Button";
import { Select } from "../../components/ui/Select";
import { LOCALE_LABELS, SUPPORTED_LOCALES } from "../../i18n";
import type { SettingsSectionProps } from "./types";
import { useWorldAvailability, useWorldPaused } from "../../components/world/worldAvailability";
import { canReplayWorldIntro, requestWorldIntroReplay } from "../../components/world/worldReplay";

const ACCENT_OPTION_IDS = ["system", ...ACCENT_PRESETS.map((preset) => preset.id), "custom"] as const;

export function AppearanceSettings({ config, onChange, onPersistedPatch, onError, onNotice }: SettingsSectionProps) {
  const { t } = useTranslation();
  const appearance = useAppearance();
  const availability = useWorldAvailability();
  const worldPaused = useWorldPaused();
  const materialNoticeId = useId();
  const materialNotice = availability === "lite" ? t("settings:worldMaterial.liteUnloaded")
    : availability === "css" ? t("settings:worldMaterial.cssFallback")
    : availability === "solid-only" && config.worldMaterial === "lattice" ? t("settings:worldMaterial.solidFallback") : "";
  const canReplayIntro = canReplayWorldIntro({
    effects: config.effects === "lite" || appearance.effects === "lite" ? "lite" : "full",
    material: config.worldMaterial,
    scene: config.worldScene,
    reducedMotion: Boolean(appearance.reducedMotion),
    highContrast: Boolean(appearance.highContrast),
    availability,
    paused: worldPaused,
  });
  const systemCurrentId = useId();
  const accentButtons = useRef(new Map<string, HTMLButtonElement>());
  const systemSelected = config.accentSource !== "custom";
  const selectedPreset = config.accentSource === "custom"
    ? ACCENT_PRESETS.find((preset) => preset.hex === config.accentColor.toLowerCase())
    : undefined;
  const selectedAccent = systemSelected ? "system" : selectedPreset?.id ?? "custom";
  const pickerColor = /^#[0-9a-f]{6}$/i.test(config.accentColor) ? config.accentColor : DEFAULT_ACCENT;
  const systemAccent = appearance.accentColor || DEFAULT_ACCENT;

  function chooseAccent(id: string) {
    if (id === "system") {
      onChange({ ...config, accentSource: "system" });
      return;
    }
    if (id === "custom") {
      const matchingPreset = ACCENT_PRESETS.some((preset) => preset.hex === pickerColor.toLowerCase());
      onChange({ ...config, accentSource: "custom", accentColor: matchingPreset ? DEFAULT_ACCENT : pickerColor });
      return;
    }
    const preset = ACCENT_PRESETS.find((candidate) => candidate.id === id);
    if (preset) onChange({ ...config, accentSource: "custom", accentColor: preset.hex });
  }

  function onAccentKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number | undefined;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % ACCENT_OPTION_IDS.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + ACCENT_OPTION_IDS.length) % ACCENT_OPTION_IDS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = ACCENT_OPTION_IDS.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    const nextId = ACCENT_OPTION_IDS[next];
    chooseAccent(nextId);
    accentButtons.current.get(nextId)?.focus();
  }

  async function background(path?: string) {
    try {
      const selected = path === undefined
        ? await pickLauncherPath("background")
        : path;
      if (selected === undefined || selected === null || typeof selected !== "string" && path === undefined) return;
      const next = await command<Config>("set_launcher_background", { path: selected || null });
      await onPersistedPatch({ customBackground: next.customBackground });
      // A changed path already re-runs HomeBackground's fetch. Re-picking the
      // same path (the file on disk may have been replaced) needs this signal.
      if (next.customBackground === config.customBackground) {
        window.dispatchEvent(new Event("vx:home-background-refresh"));
      }
      onNotice(selected ? "backgroundUpdated" : "backgroundCleared");
    } catch (cause) {
      onError(cause);
    }
  }

  return (
    <div className="vx-settings-section">
      <header>
        <h2>{t("settings:section.appearance")}</h2>
        <div className="vx-settings-appearance-head">
          <p>{t("settings:appearanceDescription")}</p>
          {canReplayIntro ? (
            <Button
              variant="ghost"
              size="sm"
              icon={<RotateCcw size={14} />}
              data-world-intro-replay=""
              aria-label={t("settings:worldPreview.replayIntro")}
              onClick={requestWorldIntroReplay}
            >
              {t("settings:worldPreview.replayIntro")}
            </Button>
          ) : null}
        </div>
      </header>
      <section className="vx-settings-group">
        <div className="vx-settings-fields">
          <label data-settings-target="appearance-theme">
            {t("settings:fields.theme")}
            <Select
              aria-label={t("settings:fields.theme")}
              value={config.theme}
              onChange={(v) => onChange({ ...config, theme: v as Config["theme"] })}
              options={[
                { value: "system", label: t("settings:theme.system") },
                { value: "dark", label: t("settings:theme.dark") },
                { value: "light", label: t("settings:theme.light") },
              ]}
            />
          </label>
          <label data-settings-target="appearance-language">
            {t("settings:fields.language")}
            <Select
              aria-label={t("settings:fields.language")}
              value={config.language}
              onChange={(v) => onChange({ ...config, language: v })}
              options={[
                { value: "system", label: t("settings:language.system") },
                ...SUPPORTED_LOCALES.map((code) => ({ value: code, label: LOCALE_LABELS[code] })),
              ]}
            />
          </label>
          <label data-settings-target="appearance-effects">
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
          <label data-settings-target="appearance-world-scene">
            {t("settings:fields.worldScene")}
            <Select
              aria-label={t("settings:fields.worldScene")}
              value={config.worldScene}
              onChange={(v) => onChange({ ...config, worldScene: v as Config["worldScene"] })}
              options={[
                { value: "horizon", label: t("settings:worldScene.horizon") },
                { value: "massif", label: t("settings:worldScene.massif") },
              ]}
            />
          </label>
          <label data-settings-target="appearance-world-material">
            {t("settings:fields.worldMaterial")}
            <Select
              aria-label={t("settings:fields.worldMaterial")}
              aria-describedby={materialNotice ? materialNoticeId : undefined}
              value={config.worldMaterial}
              onChange={(v) => onChange({ ...config, worldMaterial: v as Config["worldMaterial"] })}
              options={[
                { value: "lattice", label: t("settings:worldMaterial.lattice") },
                { value: "solid", label: t("settings:worldMaterial.solid") },
              ]}
            />
            {materialNotice ? <small id={materialNoticeId} role="status">{materialNotice}</small> : null}
          </label>
          <div className="vx-settings-accent" data-settings-target="appearance-accent-source">
            <span className="vx-settings-accent__label">{t("settings:fields.accentSource")}</span>
            <div className="vx-settings-swatches" role="radiogroup" aria-label={t("settings:fields.accentSource")}>
              <button
                ref={(node) => { if (node) accentButtons.current.set("system", node); else accentButtons.current.delete("system"); }}
                type="button"
                role="radio"
                aria-checked={systemSelected}
                aria-label={t("settings:accent.system")}
                aria-describedby={systemSelected ? systemCurrentId : undefined}
                tabIndex={selectedAccent === "system" ? 0 : -1}
                className="vx-settings-swatch vx-settings-swatch--system"
                onClick={() => chooseAccent("system")}
                onKeyDown={(event) => onAccentKeyDown(event, 0)}
              >
                <span className="vx-settings-swatch__name">{t("settings:accent.system")}</span>
                {systemSelected ? (
                  <span id={systemCurrentId} className="vx-settings-system-accent" style={{ "--system-accent": systemAccent } as CSSProperties}>
                    {t("settings:accent.systemCurrent", { color: systemAccent })}
                  </span>
                ) : null}
              </button>
              {ACCENT_PRESETS.map((preset, index) => {
                const name = t(preset.nameKey);
                return (
                  <button
                    key={preset.id}
                    ref={(node) => { if (node) accentButtons.current.set(preset.id, node); else accentButtons.current.delete(preset.id); }}
                    type="button"
                    role="radio"
                    aria-checked={selectedPreset?.id === preset.id}
                    aria-label={name}
                    title={name}
                    tabIndex={selectedAccent === preset.id ? 0 : -1}
                    className="vx-settings-swatch"
                    onClick={() => chooseAccent(preset.id)}
                    onKeyDown={(event) => onAccentKeyDown(event, index + 1)}
                  >
                    <span className="vx-settings-swatch__color" style={{ background: preset.hex }} aria-hidden="true" />
                    <span className="vx-settings-swatch__name">{name}</span>
                  </button>
                );
              })}
              <button
                ref={(node) => { if (node) accentButtons.current.set("custom", node); else accentButtons.current.delete("custom"); }}
                type="button"
                role="radio"
                aria-checked={!systemSelected && !selectedPreset}
                aria-label={t("settings:accent.custom")}
                tabIndex={selectedAccent === "custom" ? 0 : -1}
                className="vx-settings-swatch vx-settings-swatch--custom"
                onClick={() => chooseAccent("custom")}
                onKeyDown={(event) => onAccentKeyDown(event, ACCENT_OPTION_IDS.length - 1)}
              >
                <span className="vx-settings-swatch__name">{t("settings:accent.custom")}</span>
              </button>
            </div>
            <label className="vx-settings-accent__custom" data-settings-target="appearance-accent-color">
              {t("settings:fields.accentColor")}
              <input
                aria-label={t("settings:fields.accentColor")}
                type="color"
                value={pickerColor}
                onChange={(event) => onChange({ ...config, accentSource: "custom", accentColor: event.target.value })}
              />
            </label>
          </div>
          <label className="vx-settings-check" data-settings-target="appearance-sound">
            <input type="checkbox" aria-label={t("settings:fields.sound")} checked={config.soundEnabled} onChange={(event) => onChange({ ...config, soundEnabled: event.target.checked })} />
            <span>{t("settings:fields.sound")}<small>{t("settings:soundDescription")}</small></span>
          </label>
        </div>
      </section>

      <section className="vx-settings-group">
        <h3>{t("settings:background.title")}</h3>
        <p>{t("settings:background.description")}</p>
        <div className="vx-settings-background-controls">
          <label className="vx-settings-check" data-settings-target="appearance-ambient-light">
            <input
              type="checkbox"
              aria-label={t("settings:background.ambientEnabled")}
              checked={config.ambientLightEnabled ?? true}
              onChange={(event) => onChange({ ...config, ambientLightEnabled: event.target.checked })}
            />
            <span>
              {t("settings:background.ambientEnabled")}
              <small>{t("settings:background.ambientDescription")}</small>
            </span>
          </label>
          <div className="vx-settings-fields">
            <label className="vx-settings-range" data-settings-target="appearance-ambient-intensity">
              <span className="vx-settings-range__head">
                <span>{t("settings:background.ambientIntensity")}</span>
                <span className="vx-settings-range__value">
                  {t("settings:background.percent", { value: config.ambientLightIntensity ?? 60 })}
                </span>
              </span>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                aria-label={t("settings:background.ambientIntensity")}
                value={config.ambientLightIntensity ?? 60}
                disabled={!(config.ambientLightEnabled ?? true)}
                onChange={(event) => onChange({ ...config, ambientLightIntensity: Number(event.target.value) })}
              />
            </label>
            <label className="vx-settings-range" data-settings-target="appearance-background-blur">
              <span className="vx-settings-range__head">
                <span>{t("settings:background.blur")}</span>
                <span className="vx-settings-range__value">
                  {t("settings:background.blurPixels", { value: config.backgroundBlur ?? 8 })}
                </span>
              </span>
              <input
                type="range"
                min={0}
                max={24}
                step={1}
                aria-label={t("settings:background.blur")}
                value={config.backgroundBlur ?? 8}
                disabled={!config.customBackground}
                onChange={(event) => onChange({ ...config, backgroundBlur: Number(event.target.value) })}
              />
            </label>
            <label className="vx-settings-range" data-settings-target="appearance-background-dim">
              <span className="vx-settings-range__head">
                <span>{t("settings:background.dim")}</span>
                <span className="vx-settings-range__value">
                  {t("settings:background.percent", { value: config.backgroundDim ?? 35 })}
                </span>
              </span>
              <input
                type="range"
                min={0}
                max={80}
                step={5}
                aria-label={t("settings:background.dim")}
                value={config.backgroundDim ?? 35}
                disabled={!config.customBackground}
                onChange={(event) => onChange({ ...config, backgroundDim: Number(event.target.value) })}
              />
            </label>
          </div>
          <label className="vx-settings-check" data-settings-target="appearance-background-drift">
            <input
              type="checkbox"
              aria-label={t("settings:background.drift")}
              checked={Boolean(config.backgroundDrift)}
              disabled={!config.customBackground}
              onChange={(event) => onChange({ ...config, backgroundDrift: event.target.checked })}
            />
            <span>
              {t("settings:background.drift")}
              <small>{t("settings:background.driftDescription")}</small>
            </span>
          </label>
          <div className="vx-action-row" data-settings-target="appearance-background">
            <Button variant="secondary" icon={<Image size={15} />} onClick={() => void background()}>{t("settings:background.choose")}</Button>
            {config.customBackground ? <Button variant="ghost" icon={<X size={15} />} onClick={() => void background("")}>{t("settings:background.reset")}</Button> : null}
          </div>
        </div>
      </section>
    </div>
  );
}
