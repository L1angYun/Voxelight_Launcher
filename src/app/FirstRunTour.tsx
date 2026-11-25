import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { Compass, Cpu, Download, FolderOpen, Layers, Library, Radar, RefreshCw, Settings, UserPlus } from "lucide-react";
import { Button } from "../components/ui/Button";
import { Segmented } from "../components/ui/Segmented";
import { Select } from "../components/ui/Select";
import { LOCALE_LABELS, SUPPORTED_LOCALES } from "../i18n";
import { useMotionTier } from "../design/useMotionTier";
import {
  command,
  desktop,
  type AppearancePatch,
  type Config,
  type DetectedProxy,
  type JavaRuntime,
  type LocalProxyReport,
  type MemoryOverview,
} from "../lib/launcher";
import { useLauncher } from "./controller/LauncherProvider";
import "./tour.css";

const oobeSteps = [
  { id: "welcome", titleKey: "shell:tour.oobe.welcome.title", bodyKey: "shell:tour.oobe.welcome.body" },
  { id: "account", titleKey: "shell:tour.oobe.account.title", bodyKey: "shell:tour.oobe.account.body" },
  { id: "environment", titleKey: "shell:tour.oobe.environment.title", bodyKey: "shell:tour.oobe.environment.body" },
  { id: "ready", titleKey: "shell:tour.oobe.ready.title", bodyKey: "shell:tour.oobe.ready.body" },
] as const;

const orientationItems = [
  { id: "library", icon: Library, titleKey: "shell:tour.steps.library.title", bodyKey: "shell:tour.steps.library.body" },
  { id: "discover", icon: Compass, titleKey: "shell:tour.steps.discover.title", bodyKey: "shell:tour.steps.discover.body" },
  { id: "downloads", icon: Download, titleKey: "shell:tour.steps.downloads.title", bodyKey: "shell:tour.steps.downloads.body" },
  { id: "settings", icon: Settings, titleKey: "shell:tour.steps.settings.title", bodyKey: "shell:tour.steps.settings.body" },
] as const;

function focusable(card: HTMLElement): HTMLElement[] {
  return [...card.querySelectorAll<HTMLElement>(
    "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex='0']",
  )].filter((element) => element.tabIndex >= 0 && !element.closest("[inert], [hidden], [aria-hidden='true']"));
}

export function FirstRunTour({
  reopen = false,
  onDismissed,
}: {
  reopen?: boolean;
  onDismissed?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { bootstrapped, config, data, setConfig, saveConfig, setTourCompleted, reload } = useLauncher();
  const { tier } = useMotionTier();
  const [step, setStep] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [draft, setDraft] = useState<Config>(config);
  const [offlineName, setOfflineName] = useState("");
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountNotice, setAccountNotice] = useState("");
  const [accountError, setAccountError] = useState("");
  const [javaList, setJavaList] = useState<JavaRuntime[] | null>(null);
  const [javaBusy, setJavaBusy] = useState(false);
  const [memoryOverview, setMemoryOverview] = useState<MemoryOverview | null>(null);
  const [proxyReport, setProxyReport] = useState<LocalProxyReport | null>(null);
  const [finishing, setFinishing] = useState(false);

  const cardRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const closing = useRef(false);
  const focusNextAfterBack = useRef(false);
  const initialConfigRef = useRef<Config>(config);
  const draftRef = useRef<Config>(config);
  const appearancePatchRef = useRef<AppearancePatch>({});
  const otherPatchRef = useRef<Partial<Config>>({});
  const prevTourCompleted = useRef(config.tourCompleted);
  const bodyId = useId();
  const visible = bootstrapped && !dismissed && (reopen || !config.tourCompleted);
  const current = oobeSteps[step];
  const last = step === oobeSteps.length - 1;
  const accounts = data?.accounts ?? [];

  const revertPreview = useCallback(() => {
    if (Object.keys(appearancePatchRef.current).length > 0) {
      setConfig?.(initialConfigRef.current);
      appearancePatchRef.current = {};
    }
    otherPatchRef.current = {};
  }, [setConfig]);

  const skip = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    revertPreview();
    setDismissed(true);
    onDismissed?.();
    try {
      // A narrow command: it cannot be refused by a running install and it
      // leaves an unsaved appearance preview alone.
      void setTourCompleted(true).catch(() => {
        // A failed save must not trap the user in the tour this session.
      });
    } catch {
      // A synchronous save failure also leaves the tour closed for this session.
    }
  }, [onDismissed, revertPreview, setTourCompleted]);

  const finish = useCallback(async () => {
    if (closing.current) return;
    closing.current = true;
    setFinishing(true);
    const appearancePatch = { ...appearancePatchRef.current };
    const otherPatch = { ...otherPatchRef.current };
    appearancePatchRef.current = {};
    otherPatchRef.current = {};
    let base = initialConfigRef.current;
    try {
      if (Object.keys(appearancePatch).length > 0) {
        base = await saveConfig({ ...base, ...appearancePatch }, { appearancePatch });
      }
      if (Object.keys(otherPatch).length > 0) {
        base = await saveConfig({ ...base, ...otherPatch }, { preserveAppearance: true });
      }
    } catch {
      // If saving preferences fails (e.g. an operation is running), still allow completing setup.
      setConfig?.(initialConfigRef.current);
    } finally {
      setFinishing(false);
    }
    setDismissed(true);
    onDismissed?.();
    try {
      void setTourCompleted(true).catch(() => {});
    } catch {
      // Leave closed for this session.
    }
  }, [onDismissed, saveConfig, setConfig, setTourCompleted]);

  const skipRef = useRef(skip);
  skipRef.current = skip;

  const goBack = () => {
    if (step === 0) return;
    focusNextAfterBack.current = step === 1;
    setStep(step - 1);
  };

  function previewAppearance<K extends keyof AppearancePatch>(key: K, value: NonNullable<AppearancePatch[K]>) {
    const next = { ...draftRef.current, [key]: value };
    draftRef.current = next;
    setDraft(next);
    if (Object.is(initialConfigRef.current[key], value)) {
      delete appearancePatchRef.current[key];
    } else {
      appearancePatchRef.current[key] = value;
    }
    setConfig?.(next);
  }

  function setDownloadSource(source: Config["downloadSource"]) {
    const next = { ...draftRef.current, downloadSource: source };
    draftRef.current = next;
    setDraft(next);
    if (initialConfigRef.current.downloadSource === source) {
      delete otherPatchRef.current.downloadSource;
    } else {
      otherPatchRef.current.downloadSource = source;
    }
  }

  async function addOfflinePlayer() {
    const trimmed = offlineName.trim();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(trimmed)) {
      setAccountError(t("shell:tour.oobe.account.invalidName"));
      setAccountNotice("");
      return;
    }
    setAccountBusy(true);
    setAccountError("");
    setAccountNotice("");
    try {
      await command("add_offline_account", { username: trimmed });
      setOfflineName("");
      setAccountNotice(t("shell:tour.oobe.account.added", { name: trimmed }));
      await reload?.();
    } catch {
      setAccountError(t("shell:tour.oobe.account.invalidName"));
    } finally {
      setAccountBusy(false);
    }
  }

  function adoptLocalProxy(proxy: DetectedProxy) {
    const next = {
      ...draftRef.current,
      proxyMode: "custom",
      proxyScheme: proxy.scheme,
      proxyHost: proxy.host,
      proxyPort: proxy.port,
    };
    draftRef.current = next;
    setDraft(next);
    otherPatchRef.current.proxyMode = "custom";
    otherPatchRef.current.proxyScheme = proxy.scheme;
    otherPatchRef.current.proxyHost = proxy.host;
    otherPatchRef.current.proxyPort = proxy.port;
  }

  const probeEnvironment = useCallback(async () => {
    if (!desktop) return;
    setJavaBusy(true);
    try {
      const [javas, mem, proxies] = await Promise.all([
        command<JavaRuntime[]>("detect_java").catch(() => null),
        command<MemoryOverview>("get_memory_overview").catch(() => null),
        command<LocalProxyReport>("detect_local_proxies").catch(() => null),
      ]);
      if (javas) setJavaList(javas);
      if (mem) setMemoryOverview(mem);
      if (proxies) setProxyReport(proxies);
    } finally {
      setJavaBusy(false);
    }
  }, []);

  useLayoutEffect(() => {
    if (reopen) setDismissed(false);
  }, [reopen]);

  // Re-open OOBE immediately when factory reset sets tourCompleted back to false.
  useLayoutEffect(() => {
    if (prevTourCompleted.current && !config.tourCompleted) {
      setDismissed(false);
    }
    prevTourCompleted.current = config.tourCompleted;
  }, [config.tourCompleted]);

  useLayoutEffect(() => {
    if (!visible) return;
    setStep(0);
    initialConfigRef.current = config;
    draftRef.current = config;
    appearancePatchRef.current = {};
    otherPatchRef.current = {};
    setDraft(config);
    setAccountNotice("");
    setAccountError("");
    setOfflineName("");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- snapshot once when OOBE becomes visible
  }, [visible]);

  useEffect(() => {
    if (visible && step === 2 && javaList === null && desktop) {
      void probeEnvironment();
    }
  }, [visible, step, javaList, probeEnvironment]);

  useLayoutEffect(() => {
    if (!visible) return;
    closing.current = false;
    const focusCard = () => {
      const card = cardRef.current;
      if (card?.isConnected) card.focus({ preventScroll: true });
    };
    focusCard();
    const closingDialog = document.querySelector<HTMLDialogElement>("dialog[open]");
    const finishDialogClose = () => {
      if (document.querySelector("dialog[open]")) return;
      focusCard();
    };
    closingDialog?.addEventListener("close", finishDialogClose, { once: true });
    return () => {
      closingDialog?.removeEventListener("close", finishDialogClose);
      document.querySelector<HTMLElement>("main")?.focus({ preventScroll: true });
    };
  }, [visible]);

  useLayoutEffect(() => {
    if (!focusNextAfterBack.current) return;
    focusNextAfterBack.current = false;
    nextRef.current?.focus({ preventScroll: true });
  }, [step]);

  useEffect(() => {
    if (!visible) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        skipRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const card = cardRef.current;
      if (!card) return;
      const items = focusable(card);
      if (!items.length) {
        event.preventDefault();
        card.focus({ preventScroll: true });
        return;
      }
      const first = items[0];
      const lastItem = items[items.length - 1];
      const active = document.activeElement;
      if (!card.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? lastItem : first).focus();
        return;
      }
      if (event.shiftKey && (active === first || active === card)) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && (active === lastItem || active === card)) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [visible]);

  if (!visible) return null;

  const gb = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 });
  const highestJava = javaList && javaList.length > 0
    ? Math.max(...javaList.map((item) => item.major))
    : null;

  return (
    <div className="vx-tour">
      <motion.div
        ref={cardRef}
        className="vx-tour__card"
        role="dialog"
        aria-label={t("shell:tour.title")}
        aria-describedby={bodyId}
        tabIndex={-1}
        data-motion-tier={tier}
        data-position="centred"
        data-tour-step={step + 1}
        data-tour-total={oobeSteps.length}
        initial={tier === "none" ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: tier === "none" ? 0 : 0.18 }}
      >
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {t("shell:tour.announcement", {
            current: step + 1,
            total: oobeSteps.length,
            title: t(current.titleKey),
            body: t(current.bodyKey),
          })}
        </span>

        <div className="vx-tour__head">
          <div className="vx-oobe__brand">
            <span className="vx-oobe__dot" aria-hidden="true" />
            <span className="vx-oobe__wordmark">{t("shell:brand.name")}</span>
            <span className="vx-tour__count">
              {t("shell:tour.step", { current: step + 1, total: oobeSteps.length })}
            </span>
          </div>
          <Button variant="ghost" size="sm" onClick={skip}>{t("shell:tour.skip")}</Button>
        </div>

        <div className="vx-oobe__rail" aria-hidden="true">
          {oobeSteps.map((item, index) => (
            <span
              key={item.id}
              className="vx-oobe__rail-segment"
              data-state={index < step ? "done" : index === step ? "active" : "pending"}
            />
          ))}
        </div>

        <div className="vx-oobe__header">
          <h2 className="vx-tour__heading">{t(current.titleKey)}</h2>
          <p className="vx-tour__body" id={bodyId}>{t(current.bodyKey)}</p>
        </div>

        {step === 0 ? (
          <div className="vx-oobe__grid">
            <div className="vx-oobe__field">
              <span className="vx-oobe__label">{t("settings:fields.language")}</span>
              <Select
                aria-label={t("settings:fields.language")}
                value={draft.language}
                onChange={(value) => previewAppearance("language", value as Config["language"])}
                options={[
                  { value: "system", label: t("settings:language.system") },
                  ...SUPPORTED_LOCALES.map((code) => ({ value: code, label: LOCALE_LABELS[code] })),
                ]}
              />
            </div>

            <div className="vx-oobe__field">
              <span className="vx-oobe__label">{t("settings:fields.theme")}</span>
              <Segmented
                semantic="toggle"
                label={t("settings:fields.theme")}
                value={draft.theme}
                onChange={(value) => previewAppearance("theme", value as Config["theme"])}
                options={[
                  { value: "system", label: t("settings:theme.system") },
                  { value: "dark", label: t("settings:theme.dark") },
                  { value: "light", label: t("settings:theme.light") },
                ]}
              />
            </div>

            <div className="vx-oobe__field">
              <span className="vx-oobe__label">{t("settings:fields.worldScene")}</span>
              <Segmented
                semantic="toggle"
                label={t("settings:fields.worldScene")}
                value={draft.worldScene}
                onChange={(value) => previewAppearance("worldScene", value as Config["worldScene"])}
                options={[
                  { value: "horizon", label: t("settings:worldScene.horizon") },
                  { value: "massif", label: t("settings:worldScene.massif") },
                ]}
              />
            </div>

            <div className="vx-oobe__field">
              <span className="vx-oobe__label">{t("settings:fields.worldMaterial")}</span>
              <Segmented
                semantic="toggle"
                label={t("settings:fields.worldMaterial")}
                value={draft.worldMaterial}
                onChange={(value) => previewAppearance("worldMaterial", value as Config["worldMaterial"])}
                options={[
                  { value: "lattice", label: t("settings:worldMaterial.lattice") },
                  { value: "solid", label: t("settings:worldMaterial.solid") },
                ]}
              />
            </div>

            <div className="vx-oobe__field vx-oobe__field--wide">
              <span className="vx-oobe__label">{t("settings:fields.effects")}</span>
              <Segmented
                semantic="toggle"
                label={t("settings:fields.effects")}
                value={draft.effects}
                onChange={(value) => previewAppearance("effects", value as Config["effects"])}
                options={[
                  { value: "full", label: t("settings:effects.full") },
                  { value: "lite", label: t("settings:effects.lite") },
                ]}
              />
            </div>
          </div>
        ) : null}

        {step === 1 ? (
          <div className="vx-oobe__stack">
            <div className="vx-oobe__panel">
              <span className="vx-oobe__label">{t("shell:tour.oobe.account.existing")}</span>
              {accounts.length > 0 ? (
                <div className="vx-oobe__chips">
                  {accounts.map((account) => (
                    <span key={account.id} className="vx-oobe__chip">
                      {account.username}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="vx-oobe__muted">{t("shell:tour.oobe.account.none")}</p>
              )}
            </div>

            <div className="vx-oobe__field">
              <span className="vx-oobe__label">{t("shell:tour.oobe.account.offlineLabel")}</span>
              <div className="vx-oobe__inline-form">
                <input
                  aria-label={t("shell:tour.oobe.account.offlineLabel")}
                  placeholder={t("shell:tour.oobe.account.offlinePlaceholder")}
                  value={offlineName}
                  maxLength={16}
                  onChange={(event) => setOfflineName(event.target.value)}
                />
                <Button
                  variant="secondary"
                  icon={<UserPlus size={14} />}
                  loading={accountBusy}
                  disabled={!offlineName.trim()}
                  onClick={() => void addOfflinePlayer()}
                >
                  {t("shell:tour.oobe.account.addOffline")}
                </Button>
              </div>
              {accountNotice ? <p className="vx-oobe__status" role="status">{accountNotice}</p> : null}
              {accountError ? <p className="vx-oobe__error" role="alert">{accountError}</p> : null}
            </div>

            <p className="vx-oobe__muted">{t("shell:tour.oobe.account.onlineHint")}</p>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="vx-oobe__stack">
            <div className="vx-oobe__field">
              <span className="vx-oobe__label">{t("settings:fields.downloadSource")}</span>
              <Segmented
                semantic="toggle"
                label={t("settings:fields.downloadSource")}
                value={draft.downloadSource}
                onChange={(value) => setDownloadSource(value as Config["downloadSource"])}
                options={[
                  { value: "official", label: t("shell:tour.oobe.environment.sources.official") },
                  { value: "auto", label: t("shell:tour.oobe.environment.sources.auto") },
                  { value: "bmclapi", label: t("shell:tour.oobe.environment.sources.bmclapi") },
                ]}
              />
            </div>

            <div className="vx-oobe__env-grid">
              <div className="vx-oobe__panel">
                <div className="vx-oobe__panel-head">
                  <span className="vx-oobe__label">
                    <Cpu size={14} aria-hidden="true" />
                    {t("shell:tour.oobe.environment.javaTitle")}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<RefreshCw size={13} />}
                    loading={javaBusy}
                    onClick={() => void probeEnvironment()}
                  >
                    {t("shell:tour.oobe.environment.redetect")}
                  </Button>
                </div>
                <p className="vx-oobe__muted">
                  {javaList && javaList.length > 0 && highestJava
                    ? t("shell:tour.oobe.environment.javaFound", { count: javaList.length, major: highestJava })
                    : t("shell:tour.oobe.environment.javaNone")}
                </p>
              </div>

              <div className="vx-oobe__panel">
                <span className="vx-oobe__label">
                  <Layers size={14} aria-hidden="true" />
                  {t("shell:tour.oobe.environment.memoryTitle")}
                </span>
                <p className="vx-oobe__muted">
                  {memoryOverview && memoryOverview.totalMb != null
                    ? t("shell:tour.oobe.environment.memorySummary", {
                      total: gb.format(memoryOverview.totalMb / 1024),
                      recommended: memoryOverview.recommendedMb,
                    })
                    : t("shell:tour.oobe.environment.memoryAuto")}
                </p>
              </div>
            </div>

            {proxyReport ? (
              <div className="vx-oobe__panel">
                <div className="vx-oobe__panel-head">
                  <span className="vx-oobe__label">
                    <Radar size={14} aria-hidden="true" />
                    {t("shell:tour.oobe.environment.proxyTitle")}
                  </span>
                  {!proxyReport.systemProxy && proxyReport.candidates[0] ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => adoptLocalProxy(proxyReport.candidates[0])}
                    >
                      {draft.proxyMode === "custom" && draft.proxyPort === proxyReport.candidates[0].port
                        ? t("shell:tour.oobe.environment.proxyApplied")
                        : t("shell:tour.oobe.environment.proxyUse")}
                    </Button>
                  ) : null}
                </div>
                <p className="vx-oobe__muted">
                  {draft.proxyMode === "custom" && draft.proxyHost
                    ? t("shell:tour.oobe.environment.proxyCustom", {
                      url: `${draft.proxyScheme}://${draft.proxyHost}:${draft.proxyPort}`,
                    })
                    : proxyReport.systemProxy
                      ? t("shell:tour.oobe.environment.proxySystem", { url: proxyReport.systemProxy.url })
                      : proxyReport.candidates[0]
                        ? t("shell:tour.oobe.environment.proxyLocalFound", {
                          url: proxyReport.candidates[0].url,
                          label: proxyReport.candidates[0].label,
                        })
                        : t("shell:tour.oobe.environment.proxyDirect")}
                </p>
              </div>
            ) : null}

            {draft.gameDirectory ? (
              <div className="vx-oobe__path-row">
                <FolderOpen size={14} aria-hidden="true" />
                <span>{t("shell:tour.oobe.environment.gameDir")}</span>
                <code>{draft.gameDirectory}</code>
              </div>
            ) : null}
          </div>
        ) : null}

        {step === 3 ? (
          <div className="vx-oobe__map">
            {orientationItems.map((item) => {
              const Icon = item.icon;
              return (
                <article key={item.id} className="vx-oobe__map-card">
                  <div className="vx-oobe__map-head">
                    <Icon size={16} aria-hidden="true" />
                    <h3>{t(item.titleKey)}</h3>
                  </div>
                  <p>{t(item.bodyKey)}</p>
                </article>
              );
            })}
          </div>
        ) : null}

        <div className="vx-tour__actions">
          <Button variant="ghost" disabled={step === 0 || finishing} onClick={goBack}>
            {t("shell:tour.back")}
          </Button>
          <Button
            ref={nextRef}
            variant="primary"
            loading={finishing}
            onClick={last ? () => void finish() : () => setStep(step + 1)}
          >
            {last ? t("shell:tour.finish") : t("shell:tour.next")}
          </Button>
        </div>
      </motion.div>
    </div>
  );
}
