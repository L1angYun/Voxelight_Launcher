// SPDX-License-Identifier: GPL-3.0-only
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { I18nextProvider, useTranslation } from "react-i18next";
import { buildAccentScale } from "../../src/design/accent";
import { installFolderFromPicked } from "./browsePath";
import { focusHeading } from "./focusHeading";
import { createSetupI18n, resolveSetupLocale } from "./i18n";
import { LatticeBackdrop } from "./components/LatticeBackdrop";
import { LicenseDialog } from "./components/LicenseDialog";
import { SetupChrome } from "./components/SetupChrome";
import { StepIndicator } from "./components/StepIndicator";
import { DoneStep } from "./steps/DoneStep";
import { ErrorStep } from "./steps/ErrorStep";
import { InstallingStep } from "./steps/InstallingStep";
import { LocationStep } from "./steps/LocationStep";
import { OptionsStep } from "./steps/OptionsStep";
import { WelcomeStep } from "./steps/WelcomeStep";
import {
  createTauriSetupBridge,
  normalizeInstallFailure,
  type InstallFailure,
  type InstallProgress,
  type PathValidation,
  type SetupBootstrap,
  type SetupBridge,
  type SystemAppearance,
} from "./setupApi";

export type SetupStep =
  | "welcome"
  | "location"
  | "options"
  | "installing"
  | "done"
  | "error";

const WIZARD_ORDER: readonly SetupStep[] = [
  "welcome",
  "location",
  "options",
  "installing",
];

function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : false,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, [query]);
  return matches;
}

const DEFAULT_APPEARANCE: SystemAppearance = {
  theme: "dark",
  accentColor: "#0078d4",
  animationsEnabled: true,
  advancedEffectsEnabled: true,
  locale: "en-US",
};

const INITIAL_PROGRESS: InstallProgress = {
  phase: "extract",
  completed: 0,
  total: 1000,
  indeterminate: false,
  bytesWritten: 0,
  expectedBytes: 0,
};

function SetupShell({
  bridge,
  bootstrap,
  appearance,
}: {
  bridge: SetupBridge;
  bootstrap: SetupBootstrap;
  appearance: SystemAppearance;
}) {
  const { t } = useTranslation("setup");
  const [step, setStep] = useState<SetupStep>("welcome");
  const [installDir, setInstallDir] = useState(bootstrap.detected.installDir);
  const [validation, setValidation] = useState<PathValidation>(bootstrap.validation);
  const [checkingPath, setCheckingPath] = useState(false);
  const [createShortcuts, setCreateShortcuts] = useState(true);
  const [launchAfterInstall, setLaunchAfterInstall] = useState(
    bootstrap.launchAvailable !== false,
  );
  const launchAvailable = bootstrap.launchAvailable !== false;
  const [progress, setProgress] = useState<InstallProgress>({
    ...INITIAL_PROGRESS,
    expectedBytes: bootstrap.expectedInstallBytes,
  });
  const [installedDir, setInstalledDir] = useState(bootstrap.detected.installDir);
  const [launching, setLaunching] = useState(false);
  const [launchFailed, setLaunchFailed] = useState(false);
  const [failure, setFailure] = useState<InstallFailure | null>(null);
  const [licenseOpen, setLicenseOpen] = useState(false);
  const [licenseText, setLicenseText] = useState<string | null>(null);
  const [classicInstaller, setClassicInstaller] = useState<"idle" | "opening" | "failed">("idle");

  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const validationSeq = useRef(0);
  const mountedStep = useRef(false);

  const systemLight = useMedia("(prefers-color-scheme: light)");
  const reducedMotionMedia = useMedia("(prefers-reduced-motion: reduce)");
  const reducedTransparencyMedia = useMedia("(prefers-reduced-transparency: reduce)");
  const forcedColors = useMedia("(forced-colors: active)");
  const moreContrast = useMedia("(prefers-contrast: more)");

  const resolvedTheme: "light" | "dark" =
    appearance.theme === "light" || appearance.theme === "dark"
      ? appearance.theme
      : systemLight
        ? "light"
        : "dark";
  const reducedMotion = reducedMotionMedia || !appearance.animationsEnabled;
  const reducedTransparency = reducedTransparencyMedia || !appearance.advancedEffectsEnabled;
  const highContrast = forcedColors || moreContrast;
  const accentScale = useMemo(
    () => buildAccentScale(appearance.accentColor, resolvedTheme),
    [appearance.accentColor, resolvedTheme],
  );

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolvedTheme;
    root.dataset.reducedMotion = String(reducedMotion);
    root.dataset.reducedTransparency = String(reducedTransparency);
    root.dataset.highContrast = String(highContrast);
    root.dataset.effects = reducedMotion || reducedTransparency ? "lite" : "full";
    root.style.setProperty("--accent", accentScale.base);
    root.style.setProperty("--accent-hover", accentScale.hover);
    root.style.setProperty("--accent-active", accentScale.active);
    root.style.setProperty("--accent-foreground", accentScale.foreground);
    root.style.setProperty("--accent-ink", accentScale.ink);
    root.style.setProperty("--accent-indicator", accentScale.indicator);
  }, [accentScale, highContrast, reducedMotion, reducedTransparency, resolvedTheme]);

  useEffect(() => {
    if (!mountedStep.current) {
      mountedStep.current = true;
      return;
    }
    focusHeading(headingRef.current);
  }, [step]);

  useEffect(() => {
    let active = true;
    const unlistenPromise = bridge.onInstallProgress((update) => {
      if (active) setProgress(update);
    });
    return () => {
      active = false;
      void unlistenPromise.then((dispose) => dispose()).catch(() => {});
    };
  }, [bridge]);

  const validatePathNow = useCallback(
    async (candidate: string) => {
      const seq = ++validationSeq.current;
      setCheckingPath(true);
      try {
        const result = await bridge.validateInstallPath(candidate);
        if (seq === validationSeq.current) {
          setValidation(result);
        }
      } finally {
        if (seq === validationSeq.current) {
          setCheckingPath(false);
        }
      }
    },
    [bridge],
  );

  const handleChangePath = useCallback(
    (next: string) => {
      setInstallDir(next);
      void validatePathNow(next);
    },
    [validatePathNow],
  );

  const handleBrowse = useCallback(async () => {
    const picked = await bridge.pickInstallDirectory(installDir);
    const target = installFolderFromPicked(picked);
    if (!target) return;
    setInstallDir(target);
    await validatePathNow(target);
  }, [bridge, installDir, validatePathNow]);

  const handleOpenClassicInstaller = useCallback(async () => {
    setClassicInstaller("opening");
    try {
      // On success Setup closes and the classic installer takes over.
      await bridge.openClassicInstaller();
    } catch {
      setClassicInstaller("failed");
    }
  }, [bridge]);

  const handleOpenLicense = useCallback(async () => {
    setLicenseOpen(true);
    if (licenseText === null) {
      try {
        const text = await bridge.getLicenseText();
        setLicenseText(text);
      } catch {
        setLicenseText("GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007");
      }
    }
  }, [bridge, licenseText]);

  const handleLaunch = useCallback(async () => {
    setLaunching(true);
    setLaunchFailed(false);
    try {
      await bridge.launchInstalled();
    } catch {
      setLaunching(false);
      setLaunchFailed(true);
    }
  }, [bridge]);

  const handleStartInstall = useCallback(async () => {
    const target = validation.normalizedPath || installDir;
    setFailure(null);
    setLaunchFailed(false);
    setLaunching(false);
    setProgress({
      phase: "extract",
      completed: 0,
      total: 1000,
      indeterminate: false,
      bytesWritten: 0,
      expectedBytes: bootstrap.expectedInstallBytes,
    });
    setStep("installing");

    try {
      const outcome = await bridge.startInstall({
        installDir: target,
        createShortcuts,
      });
      setInstalledDir(outcome.installDir);
      setStep("done");
      if (launchAfterInstall && launchAvailable) {
        setLaunching(true);
        try {
          await bridge.launchInstalled();
        } catch {
          setLaunching(false);
          setLaunchFailed(true);
        }
      }
    } catch (error) {
      setFailure(normalizeInstallFailure(error));
      setStep("error");
    }
  }, [
    bootstrap.expectedInstallBytes,
    bridge,
    createShortcuts,
    installDir,
    launchAfterInstall,
    launchAvailable,
    validation.normalizedPath,
  ]);

  const stepIndex = WIZARD_ORDER.indexOf(step);
  const stepTitle =
    step === "welcome"
      ? t("welcome.title")
      : step === "location"
        ? t("location.title")
        : step === "options"
          ? t("options.title")
          : step === "installing"
            ? t("installing.title")
            : step === "done"
              ? t("done.title")
              : t("error.title");

  const announcement =
    stepIndex >= 0
      ? t("app.stepAnnouncement", {
          current: stepIndex + 1,
          total: WIZARD_ORDER.length,
          title: stepTitle,
        })
      : stepTitle;

  return (
    <div className="vx-setup-root" data-step={step}>
      <LatticeBackdrop />
      <SetupChrome
        closeDisabled={step === "installing"}
        onMinimize={() => void bridge.minimizeWindow()}
        onClose={() => {
          if (step !== "installing") void bridge.closeWindow();
        }}
      />

      <main className="vx-setup-main">
        <section className="vx-setup-card" aria-label={t("app.setupName")}>
          <div className="sr-only" aria-live="polite" aria-atomic="true">
            {announcement}
          </div>

          <StepIndicator
            currentIndex={stepIndex >= 0 ? stepIndex : WIZARD_ORDER.length - 1}
            totalSteps={WIZARD_ORDER.length}
            complete={step === "done"}
          />

          {step === "welcome" ? (
            <WelcomeStep
              version={bootstrap.version}
              detected={bootstrap.detected}
              headingRef={headingRef}
              onOpenLicense={() => void handleOpenLicense()}
              onNext={() => setStep("location")}
            />
          ) : null}

          {step === "location" ? (
            <LocationStep
              detected={bootstrap.detected}
              installDir={installDir}
              validation={validation}
              checking={checkingPath}
              classicInstaller={classicInstaller}
              headingRef={headingRef}
              onChangePath={handleChangePath}
              onBrowse={() => void handleBrowse()}
              onOpenClassicInstaller={() => void handleOpenClassicInstaller()}
              onBack={() => setStep("welcome")}
              onNext={() => setStep("options")}
            />
          ) : null}

          {step === "options" ? (
            <OptionsStep
              version={bootstrap.version}
              detected={bootstrap.detected}
              installDir={validation.normalizedPath || installDir}
              createShortcuts={createShortcuts}
              launchAfterInstall={launchAfterInstall}
              launchAvailable={launchAvailable}
              headingRef={headingRef}
              onChangeShortcuts={setCreateShortcuts}
              onChangeLaunchAfterInstall={setLaunchAfterInstall}
              onBack={() => setStep("location")}
              onInstall={() => void handleStartInstall()}
            />
          ) : null}

          {step === "installing" ? (
            <InstallingStep progress={progress} headingRef={headingRef} />
          ) : null}

          {step === "done" ? (
            <DoneStep
              version={bootstrap.version}
              installedDir={installedDir}
              launching={launching}
              launchFailed={launchFailed}
              launchAvailable={launchAvailable}
              headingRef={headingRef}
              onLaunch={() => void handleLaunch()}
              onClose={() => void bridge.closeWindow()}
            />
          ) : null}

          {step === "error" && failure ? (
            <ErrorStep
              version={bootstrap.version}
              installDir={validation.normalizedPath || installDir}
              failure={failure}
              headingRef={headingRef}
              onBack={() => setStep("options")}
              onRetry={() => void handleStartInstall()}
            />
          ) : null}
        </section>
      </main>

      <LicenseDialog
        open={licenseOpen}
        onOpenChange={setLicenseOpen}
        licenseText={licenseText}
      />
    </div>
  );
}

export function SetupApp({ bridge }: { bridge?: SetupBridge }) {
  const activeBridge = useMemo(() => bridge ?? createTauriSetupBridge(), [bridge]);
  const [bootstrap, setBootstrap] = useState<SetupBootstrap | null>(null);
  const [appearance, setAppearance] = useState<SystemAppearance>(DEFAULT_APPEARANCE);

  const i18n = useMemo(
    () => createSetupI18n(appearance.locale),
    [appearance.locale],
  );

  useEffect(() => {
    const locale = resolveSetupLocale(appearance.locale);
    document.documentElement.lang = locale;
  }, [appearance.locale]);

  useEffect(() => {
    let active = true;
    void activeBridge.getSetupState().then((data) => {
      if (!active) return;
      setAppearance(data.appearance);
      setBootstrap(data);
    });
    const unlistenPromise = activeBridge.onAppearanceChange((next) => {
      if (active) setAppearance(next);
    });
    return () => {
      active = false;
      void unlistenPromise.then((dispose) => dispose()).catch(() => {});
    };
  }, [activeBridge]);

  if (!bootstrap) {
    return (
      <div className="vx-setup-root" aria-busy="true">
        <LatticeBackdrop />
      </div>
    );
  }

  return (
    <I18nextProvider i18n={i18n}>
      <SetupShell
        bridge={activeBridge}
        bootstrap={bootstrap}
        appearance={appearance}
      />
    </I18nextProvider>
  );
}
