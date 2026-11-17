import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw, Save, SlidersHorizontal, Palette, Gamepad2, Coffee, Download, Info } from "lucide-react";
import { useLauncher } from "../../app/controller/LauncherProvider";
import { settingsSectionRegistry } from "../../app/registry";
import { appearanceFields, configChanges, type Config } from "../../lib/launcher";
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
const appearanceKeys = new Set<keyof Config>(appearanceFields);
type SaveResult = { ok: true } | { ok: false; error: LauncherError };

export function SettingsPage() {
  const { t, i18n } = useTranslation();
  const {
    config,
    data: launcherData,
    setConfig,
    saveConfig,
    reload,
  } = useLauncher();
  const [section, setSection] = useState<Section>("general");
  const [draft, setDraft] = useState(config);
  const [actionError, setActionError] = useState<LauncherError | null>(null);
  const [actionNotice, setActionNotice] = useState<{ code: string; params?: Record<string, unknown> } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveResults, setSaveResults] = useState<{ appearance?: SaveResult; other?: SaveResult }>({});
  const saveInProgress = useRef(false);
  const mounted = useRef(true);
  const savedConfig = useRef(launcherData.config);
  const draftRef = useRef(draft);
  const dirty = Object.keys(configChanges(savedConfig.current, draft)).length > 0;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      setConfig(savedConfig.current);
    };
  }, [setConfig]);

  const updateDraft = useCallback((next: Config) => {
    draftRef.current = next;
    setDraft(next);
  }, []);

  const onChange = useCallback((next: typeof draft) => {
    updateDraft(next);
    if (section === "appearance") setConfig(next);
  }, [section, setConfig, updateDraft]);

  const onPersisted = useCallback(async (next: typeof draft) => {
    savedConfig.current = next;
    updateDraft(next);
    setConfig(next);
    await reload();
  }, [reload, setConfig, updateDraft]);

  const onPersistedPatch = useCallback(async (patch: Partial<typeof draft>) => {
    const nextDraft = { ...draftRef.current, ...patch };
    savedConfig.current = { ...savedConfig.current, ...patch };
    updateDraft(nextDraft);
    setConfig(nextDraft);
    await reload();
    if (section === "appearance") setConfig(draftRef.current);
  }, [reload, section, setConfig, updateDraft]);

  const onError = useCallback((cause: unknown) => {
    setActionError(normalizeError(cause));
    setActionNotice(null);
  }, []);
  const onNotice = useCallback((code: string, params?: Record<string, unknown>) => {
    setActionError(null);
    setActionNotice({ code, params });
  }, []);

  async function save() {
    if (saveInProgress.current) return;
    const changes = Object.entries(configChanges(savedConfig.current, draftRef.current));
    const appearance = Object.fromEntries(changes.filter(([key]) => appearanceKeys.has(key as keyof Config)));
    const other = Object.fromEntries(changes.filter(([key]) => !appearanceKeys.has(key as keyof Config)));
    if (!changes.length) return;
    saveInProgress.current = true;
    setSaving(true);
    setActionError(null);
    setActionNotice(null);
    setSaveResults({});
    async function persist(scope: "appearance" | "other", patch: Partial<Config>) {
      const fields = Object.keys(patch) as (keyof Config)[];
      if (!fields.length) return false;
      const candidate = { ...savedConfig.current, ...patch };
      try {
        const saved = await saveConfig(candidate, scope === "appearance" ? { appearancePatch: patch } : { preserveAppearance: true });
        if (!mounted.current) return true;
        const latest = draftRef.current;
        const remaining = configChanges(savedConfig.current, latest);
        for (const key of fields) {
          if (Object.is(latest[key], candidate[key])) delete remaining[key];
          else Object.assign(remaining, { [key]: latest[key] });
        }
        savedConfig.current = saved;
        const next = { ...saved, ...remaining };
        updateDraft(next);
        setConfig(next);
        setSaveResults((results) => ({ ...results, [scope]: { ok: true } }));
        return true;
      } catch (error) {
        if (mounted.current) setSaveResults((results) => ({ ...results, [scope]: { ok: false, error: normalizeError(error) } }));
        return false;
      }
    }
    try {
      await persist("appearance", appearance);
      if (await persist("other", other)) {
        try { await reload(); } catch (error) { if (mounted.current) onError(error); }
      }
    } finally {
      saveInProgress.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  function reset() {
    updateDraft(savedConfig.current);
    setConfig(savedConfig.current);
    setActionError(null);
    setActionNotice(null);
    setSaveResults({});
  }

  function errorText(error: LauncherError) {
    const key = [`settings:errors.${error.code}`, `shell:errors.${error.code}`].find((key) => i18n.exists(key));
    return key ? t(key, error.params) : t("common:errors.internalUnexpected");
  }
  function showSaveResult(result: SaveResult | undefined, saved: string, failed: string) {
    if (!result) return null;
    return result.ok
      ? <p className="vx-settings-notice" role="status">{saved}</p>
      : <p className="vx-settings-error" role="alert">{failed} {errorText(result.error)}</p>;
  }
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
      <PageHeader title={t("settings:title")} description={t("settings:subtitle")} actions={
        <div className="vx-action-row vx-settings-save">
          {dirty ? <span className="vx-settings-dirty" role="status">{t("settings:unsaved")}</span> : null}
          <Button variant="ghost" icon={<RotateCcw size={15} />} disabled={!dirty || saving} onClick={reset}>{t("settings:reset")}</Button>
          <Button variant="primary" icon={<Save size={15} />} loading={saving} disabled={!dirty} onClick={() => void save()}>{t("settings:save")}</Button>
        </div>
      } />
      {actionError ? <p className="vx-settings-error" role="alert">{errorText(actionError)}</p> : null}
      {actionNotice ? <p className="vx-settings-notice" role="status">{t(`settings:notice.${actionNotice.code}`, actionNotice.params)}</p> : null}
      {showSaveResult(saveResults.appearance, t("settings:saveResult.appearanceSaved"), t("settings:saveResult.appearanceFailed"))}
      {showSaveResult(saveResults.other, t("settings:saveResult.otherSaved"), t("settings:saveResult.otherFailed"))}
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
