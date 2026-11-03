import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw, Save, SlidersHorizontal, Palette, Gamepad2, Coffee, Download, Info } from "lucide-react";
import { useLauncher } from "../../app/controller/LauncherProvider";
import { settingsSectionRegistry } from "../../app/registry";
import { normalizeError, type LauncherError } from "../../lib/errors";
import { Button } from "../../components/ui/Button";
import { PageHeader, PageShell } from "../../components/ui/PageShell";
import { RailNav } from "../../components/ui/RailNav";
import { SectionPanel } from "../../components/ui/SectionPanel";
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
    <PageShell className="vx-settings-page">
      <PageHeader className="vx-page-heading vx-settings-heading" title={t("settings:title")} description={t("settings:subtitle")} actions={
        <div className="vx-action-row vx-settings-save">
          {dirty ? <span className="vx-settings-dirty" role="status">{t("settings:unsaved")}</span> : null}
          <Button variant="ghost" icon={<RotateCcw size={15} />} disabled={!dirty} onClick={reset}>{t("settings:reset")}</Button>
          <Button variant="primary" icon={<Save size={15} />} loading={busy === "settings.save"} disabled={!dirty} onClick={() => void save()}>{t("settings:save")}</Button>
        </div>
      } />
      {errorText ? <p className="vx-settings-error" role="alert">{errorText}</p> : null}
      {actionNotice ? <p className="vx-settings-notice" role="status">{t(`settings:notice.${actionNotice.code}`, actionNotice.params)}</p> : null}
      {saveFailed && notice?.kind === "error" ? <p className="vx-settings-error" role="alert">{noticeText}</p> : null}
      <div className="vx-settings-layout vx-workspace">
        <RailNav className="vx-settings-nav" label={t("settings:sections")} value={section} onChange={setSection}
          options={settingsSectionRegistry.enabled({}).map((item) => {
            const Icon = sectionIcons[item.id as Section];
            return { value: item.id as Section, icon: <Icon size={17} strokeWidth={1.6} aria-hidden="true" />, label: t(item.labelKey.replace(/^settings\./, ""), { ns: "settings" }) };
          })} />
        <SectionPanel selectionKey={section} className="vx-settings-content vx-panel">
          {section === "general" ? <GeneralSettings {...sectionProps} /> : null}
          {section === "appearance" ? <AppearanceSettings {...sectionProps} /> : null}
          {section === "game" ? <GameSettings {...sectionProps} /> : null}
          {section === "java" ? <JavaSettings {...sectionProps} /> : null}
          {section === "downloads" ? <DownloadSettings {...sectionProps} /> : null}
          {section === "about" ? <AboutSettings onError={onError} /> : null}
        </SectionPanel>
      </div>
    </PageShell>
  );
}
