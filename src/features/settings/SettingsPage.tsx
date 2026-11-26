import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw, Save, SlidersHorizontal, Palette, Gamepad2, Coffee, Download, Bot, Info } from "lucide-react";
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
import { AssistantSettings } from "./AssistantSettings";
import { AboutSettings } from "./AboutSettings";
import { searchSettings, type SettingsEntry, type SettingsSectionId } from "./settingsIndex";
import "./settings.css";

type Section = SettingsSectionId;
const sectionIcons = { general: SlidersHorizontal, appearance: Palette, game: Gamepad2, java: Coffee, downloads: Download, assistant: Bot, about: Info };
const appearanceKeys = new Set<keyof Config>(appearanceFields);
type SaveResult = { ok: true } | { ok: false; error: LauncherError };

/** `reviewUpdates` changes when the startup notice asks to review the update. */
export function SettingsPage({
  reviewUpdates = 0,
  focusAssistant = 0,
  onOpenAssistant,
}: {
  reviewUpdates?: number;
  focusAssistant?: number;
  onOpenAssistant?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const {
    config,
    data: launcherData,
    setConfig,
    saveConfig,
    reload,
  } = useLauncher();
  const [section, setSection] = useState<Section>(
    reviewUpdates ? "about" : focusAssistant ? "assistant" : "general",
  );
  // The review request focuses the update action once, not on every return to About.
  // Parent effects run after the child's, so the handled tick is remembered here.
  const [focusUpdates, setFocusUpdates] = useState(0);
  const handledReview = useRef(0);
  const handledAssistant = useRef(0);
  const focusHandled = useCallback(() => setFocusUpdates(0), []);
  useEffect(() => {
    if (!reviewUpdates || reviewUpdates === handledReview.current) return;
    handledReview.current = reviewUpdates;
    setSection("about");
    setFocusUpdates(reviewUpdates);
  }, [reviewUpdates]);
  useEffect(() => {
    if (!focusAssistant || focusAssistant === handledAssistant.current) return;
    handledAssistant.current = focusAssistant;
    setSection("assistant");
  }, [focusAssistant]);
  const [query, setQuery] = useState("");
  const [pendingTarget, setPendingTarget] = useState<SettingsEntry | null>(null);
  const layout = useRef<HTMLDivElement>(null);
  const firstResult = useRef<HTMLButtonElement>(null);
  const revealed = useRef<HTMLElement | null>(null);
  const revealTimer = useRef<number | undefined>(undefined);
  const trimmedQuery = query.trim();
  const results = trimmedQuery ? searchSettings(query, t) : [];
  const searchStatus = !trimmedQuery
    ? ""
    : results.length
      ? t("settings:search.resultCount", { count: results.length })
      : t("settings:search.noMatch");
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

  useEffect(() => {
    if (!pendingTarget) return;
    const entry = pendingTarget;
    const focusableSelector = 'button, input, select, textarea, a[href], [tabindex]';
    let cancelled = false;
    let frame = 0;
    let timer: number | undefined;

    function candidates(scope: HTMLElement) {
      // A target that is itself a control (or names one via
      // data-settings-primary) settles only that control. Falling through to
      // its siblings can focus a different action, such as "Cancel update"
      // while "Check for updates" is disabled by a download.
      const primary = scope.querySelector<HTMLElement>("[data-settings-primary]");
      if (primary) return [primary];
      return scope.matches(focusableSelector) ? [scope] : [...scope.querySelectorAll<HTMLElement>(focusableSelector)];
    }
    function usable(element: HTMLElement) {
      return !element.hasAttribute("disabled") && element.tabIndex >= 0
        && !element.closest("[inert]") && element.getAttribute("aria-hidden") !== "true";
    }
    function findTarget(id: string | undefined) {
      if (!id) return undefined;
      return layout.current?.querySelector<HTMLElement>(`[data-settings-target="${id}"]`) ?? undefined;
    }
    function clearPending() {
      if (!cancelled) setPendingTarget(null);
    }
    function reveal(element: HTMLElement) {
      element.scrollIntoView?.({ block: "center" });
      if (revealed.current !== element) revealed.current?.classList.remove("vx-settings-target-revealed");
      revealed.current = element;
      window.clearTimeout(revealTimer.current);
      element.classList.add("vx-settings-target-revealed");
      revealTimer.current = window.setTimeout(() => {
        element.classList.remove("vx-settings-target-revealed");
        if (revealed.current === element) revealed.current = null;
      }, 1500);
    }
    function focusSectionFallback() {
      const heading = layout.current?.querySelector<HTMLElement>(".vx-settings-section h2");
      if (heading) {
        heading.tabIndex = -1;
        heading.focus();
      } else {
        // The search input stays mounted; never let focus fall to <body>.
        layout.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
      }
      clearPending();
    }
    function focusRow(element: HTMLElement) {
      element.tabIndex = -1;
      element.focus();
      if (document.activeElement === element) clearPending();
      else focusSectionFallback();
    }
    function focusFallback(element: HTMLElement) {
      const fallback = findTarget(entry.fallbackTarget);
      if (!fallback || fallback === element) return false;
      const control = candidates(fallback).find(usable);
      if (!control) return false;
      reveal(fallback);
      control.focus();
      clearPending();
      return true;
    }
    function settle(element: HTMLElement) {
      const control = candidates(element).find(usable);
      if (control) {
        control.focus();
        clearPending();
        return;
      }
      // Credential fields stay disabled for one IPC round trip. Retry briefly
      // instead of leaving focus on the label before the input enables.
      if (entry.waitForEnabled && candidates(element).some((candidate) => candidate.hasAttribute("disabled"))) {
        const deadline = Date.now() + 500;
        const retry = () => {
          if (cancelled) return;
          const enabled = candidates(element).find(usable);
          if (enabled) {
            enabled.focus();
            clearPending();
            return;
          }
          if (Date.now() < deadline) {
            scheduleRetry(retry);
            return;
          }
          if (!focusFallback(element)) focusRow(element);
        };
        retry();
        return;
      }
      if (!focusFallback(element)) focusRow(element);
    }
    function scheduleRetry(run: () => void) {
      if (typeof requestAnimationFrame === "function") frame = requestAnimationFrame(run);
      else timer = window.setTimeout(run, 25);
    }
    function start() {
      if (cancelled) return;
      const target = findTarget(entry.target) ?? findTarget(entry.fallbackTarget);
      if (!target) {
        focusSectionFallback();
        return;
      }
      reveal(target);
      settle(target);
    }
    if (typeof requestAnimationFrame === "function") frame = requestAnimationFrame(start);
    else timer = window.setTimeout(start, 0);
    return () => {
      cancelled = true;
      if (frame) cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [pendingTarget]);

  useEffect(() => () => {
    window.clearTimeout(revealTimer.current);
    revealed.current?.classList.remove("vx-settings-target-revealed");
  }, []);

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

  function chooseSearchResult(entry: SettingsEntry) {
    setSection(entry.section);
    setQuery("");
    setPendingTarget(entry);
  }

  function onSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      if (query) {
        event.preventDefault();
        setQuery("");
      }
      return;
    }
    if (event.key === "ArrowDown" && results.length) {
      event.preventDefault();
      firstResult.current?.focus();
      return;
    }
    if (event.key === "Enter" && results.length) {
      event.preventDefault();
      chooseSearchResult(results[0].entry);
    }
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
      <div ref={layout} className="vx-settings-layout vx-workspace">
        <div className="vx-settings-rail">
          <div className="vx-settings-search" role="search">
            <input
              type="search"
              aria-label={t("settings:search.label")}
              placeholder={t("settings:search.placeholder")}
              aria-controls={results.length ? "vx-settings-search-results" : undefined}
              value={query}
              autoComplete="off"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onSearchKeyDown}
            />
            <p className="sr-only" role="status" aria-live="polite" data-testid="settings-search-status">
              {searchStatus}
            </p>
            {trimmedQuery ? (
              results.length ? (
                <ul id="vx-settings-search-results" className="vx-settings-search-results" aria-label={t("settings:search.results")}>
                  {results.map((result, index) => (
                    <li key={`${result.entry.section}-${result.entry.target}-${result.entry.labelKey}`}>
                      <button ref={index === 0 ? firstResult : undefined} type="button"
                        data-settings-result={result.entry.target} onClick={() => chooseSearchResult(result.entry)}>
                        <span className="vx-settings-search-result__label">{result.label}</span>
                        <span className="vx-settings-search-result__section">{result.sectionLabel}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : <p className="vx-settings-search-empty">{t("settings:search.noMatch")}</p>
            ) : null}
          </div>
          <RailNav className="vx-settings-nav" label={t("settings:sections")} value={section} onChange={setSection}
            options={settingsSectionRegistry.enabled({}).map((item) => {
              const Icon = sectionIcons[item.id as Section];
              return { value: item.id as Section, icon: <Icon size={17} strokeWidth={1.6} aria-hidden="true" />, label: t(item.labelKey.replace(/^settings\./, ""), { ns: "settings" }) };
            })} />
        </div>
        <SectionPanel selectionKey={section} className="vx-settings-content vx-panel">
          {section === "general" ? <GeneralSettings {...sectionProps} /> : null}
          {section === "appearance" ? <AppearanceSettings {...sectionProps} /> : null}
          {section === "game" ? <GameSettings {...sectionProps} /> : null}
          {section === "java" ? <JavaSettings {...sectionProps} /> : null}
          {section === "downloads" ? <DownloadSettings {...sectionProps} savedConfig={savedConfig.current} /> : null}
          {section === "assistant" ? <AssistantSettings {...sectionProps} savedConfig={savedConfig.current} onOpenAssistant={onOpenAssistant} /> : null}
          {section === "about" ? <AboutSettings {...sectionProps} focusUpdates={focusUpdates} onFocusHandled={focusHandled} /> : null}
        </SectionPanel>
      </div>
    </PageShell>
  );
}
