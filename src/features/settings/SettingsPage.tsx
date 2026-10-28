import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw, Save, SlidersHorizontal, Palette, Gamepad2, Coffee, Download, Info } from "lucide-react";
import { useLauncher } from "../../app/controller/LauncherProvider";
import { settingsSectionRegistry } from "../../app/registry";
import { normalizeError, type LauncherError } from "../../lib/errors";
import { Button } from "../../components/ui/Button";
import { ToastRegion } from "../../components/ui/Feedback";
import { GeneralSettings } from "./GeneralSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { GameSettings } from "./GameSettings";
import { JavaSettings } from "./JavaSettings";
import { DownloadSettings } from "./DownloadSettings";
import { AboutSettings } from "./AboutSettings";
import "./settings.css";

type Section = "general" | "appearance" | "game" | "java" | "downloads" | "about";
const sectionIcons = { general: SlidersHorizontal, appearance: Palette, game: Gamepad2, java: Coffee, downloads: Download, about: Info };

export function SettingsPage() {
  const { t, i18n } = useTranslation();
  const {
    config,
    setConfig,
    saveConfig,
    reload,
    busy,
    notice,
    dismissNotice,
  } = useLauncher();
  const [section, setSection] = useState<Section>("general");
  const [draft, setDraft] = useState(config);
  const [actionError, setActionError] = useState<LauncherError | null>(null);
  const [actionNotice, setActionNotice] = useState<{ code: string; params?: Record<string, unknown> } | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const savedConfig = useRef(config);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const dirty = JSON.stringify(draft) !== JSON.stringify(savedConfig.current);

  useEffect(() => () => setConfig(savedConfig.current), [setConfig]);

  const onChange = useCallback((next: typeof draft) => {
    setDraft(next);
    if (section === "appearance") setConfig(next);
  }, [section, setConfig]);

  const onPersisted = useCallback(async (next: typeof draft) => {
    savedConfig.current = next;
    setDraft(next);
    setConfig(next);
    await reload();
  }, [reload, setConfig]);

  const onPersistedPatch = useCallback(async (patch: Partial<typeof draft>) => {
    const nextDraft = { ...draftRef.current, ...patch };
    savedConfig.current = { ...savedConfig.current, ...patch };
    setDraft(nextDraft);
    setConfig(nextDraft);
    await reload();
    if (section === "appearance") setConfig(nextDraft);
  }, [reload, section, setConfig]);

  const onError = useCallback((cause: unknown) => {
    setActionError(normalizeError(cause));
    setActionNotice(null);
  }, []);
  const onNotice = useCallback((code: string, params?: Record<string, unknown>) => {
    setActionError(null);
    setActionNotice({ code, params });
  }, []);

  async function save() {
    setActionError(null);
    setActionNotice(null);
    setSaveFailed(false);
    if (await saveConfig(draft)) {
      savedConfig.current = draft;
      await reload();
    } else setSaveFailed(true);
  }

  function reset() {
    setDraft(savedConfig.current);
    setConfig(savedConfig.current);
    setActionError(null);
    setActionNotice(null);
    setSaveFailed(false);
  }

  const errorText = actionError
    ? i18n.exists(`settings:errors.${actionError.code}`)
      ? t(`settings:errors.${actionError.code}`, actionError.params)
      : t("common:errors.internalUnexpected")
    : "";
  const noticeText = notice
    ? i18n.exists(`shell:notifications.${notice.code}`)
      ? t(`shell:notifications.${notice.code}`, notice.params)
      : i18n.exists(`shell:errors.${notice.code}`)
        ? t(`shell:errors.${notice.code}`, notice.params)
        : i18n.exists(`settings:errors.${notice.code}`)
          ? t(`settings:errors.${notice.code}`, notice.params)
        : t("common:errors.internalUnexpected")
    : "";
  const sectionProps = {
    config: draft,
    onChange,
    onPersisted,
    onPersistedPatch,
    onError,
    onNotice,
  };

  return (
    <div className="vx-settings-page">
      <header className="vx-page-heading vx-settings-heading">
        <div><h1>{t("settings:title")}</h1><p>{t("settings:subtitle")}</p></div>
        <div className="vx-action-row vx-settings-save">
          {dirty ? <span className="vx-settings-dirty" role="status">{t("settings:unsaved")}</span> : null}
          <Button variant="ghost" icon={<RotateCcw size={15} />} disabled={!dirty} onClick={reset}>{t("settings:reset")}</Button>
          <Button variant="primary" icon={<Save size={15} />} loading={busy === "settings.save"} disabled={!dirty} onClick={() => void save()}>{t("settings:save")}</Button>
        </div>
      </header>
      {errorText ? <p className="vx-settings-error" role="alert">{errorText}</p> : null}
      {actionNotice ? <p className="vx-settings-notice" role="status">{t(`settings:notice.${actionNotice.code}`, actionNotice.params)}</p> : null}
      <div className="vx-settings-layout">
        <nav className="vx-settings-nav" aria-label={t("settings:sections")}>
          {settingsSectionRegistry.enabled({}).map((item) => {
            const Icon = sectionIcons[item.id as Section];
            return (
            <button
              key={item.id}
              type="button"
              aria-current={section === item.id ? "page" : undefined}
              onClick={() => setSection(item.id as Section)}
            >
              <Icon size={17} strokeWidth={1.6} aria-hidden="true" />
              <span>{t(item.labelKey.replace(/^settings\./, ""), { ns: "settings" })}</span>
            </button>
          ); })}
        </nav>
        <div className="vx-settings-content">
          {section === "general" ? <GeneralSettings {...sectionProps} /> : null}
          {section === "appearance" ? <AppearanceSettings {...sectionProps} /> : null}
          {section === "game" ? <GameSettings {...sectionProps} /> : null}
          {section === "java" ? <JavaSettings {...sectionProps} /> : null}
          {section === "downloads" ? <DownloadSettings {...sectionProps} /> : null}
          {section === "about" ? <AboutSettings onError={onError} /> : null}
        </div>
      </div>
      {notice && (saveFailed || notice.kind === "info") ? <ToastRegion message={noticeText} kind={notice.kind} onDismiss={dismissNotice} closeLabel={t("common:actions.close")} /> : null}
    </div>
  );
}
