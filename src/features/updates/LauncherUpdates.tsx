import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useLauncher } from "../../app/controller/LauncherProvider";
import { useToast } from "../../components/ui/ToastProvider";
import { command, desktop, events, type Config } from "../../lib/launcher";
import { LauncherError, normalizeError } from "../../lib/errors";

/** The last check, as the backend reports it (updates::UpdateView). */
export interface UpdateView {
  currentVersion: string;
  latestVersion: string;
  prerelease?: boolean;
  /** "stale": the source is behind a version this launcher has seen before. */
  status: "newer" | "current" | "stale";
  source: "github" | "gitee";
  releaseUrl: string;
  notes: string | null;
  installerSize: number | null;
}
export interface StagedView { version: string; fileName: string; size: number }
export interface UpdateState {
  currentVersion: string;
  check: UpdateView | null;
  download: "idle" | "downloading" | "cancelling" | "installing";
  staged: StagedView | null;
  /** Why the install would be refused now (an update.* code), or null. */
  busy: string | null;
}

export type UpdateStatus =
  | { key: "notChecked" | "checking" | "downloading" | "preparing" | "cancelled" }
  | { key: "available" | "noInstaller" | "current" | "stale"; version: string }
  | { key: "failed" | "downloadFailed" | "installFailed" | "blocked"; error: LauncherError };

export interface LauncherUpdates {
  result: UpdateView | null;
  status: UpdateStatus;
  /** 0..1 while downloading. */
  progress: number;
  checking: boolean;
  /** Downloading or handing the installer to the helper. */
  installing: boolean;
  /** The startup check found a newer version; shown once, until dismissed or reviewed. */
  notice: UpdateView | null;
  check: () => Promise<void>;
  install: () => Promise<void>;
  cancel: () => void;
  /** HSR clears the result when the source changes: the next check uses the new source. */
  sourceChanged: () => void;
  dismissNotice: () => void;
}

const idle: LauncherUpdates = {
  result: null,
  status: { key: "notChecked" },
  progress: 0,
  checking: false,
  installing: false,
  notice: null,
  check: async () => {},
  install: async () => {},
  cancel: () => {},
  sourceChanged: () => {},
  dismissNotice: () => {},
};
const Context = createContext<LauncherUpdates>(idle);
export const useLauncherUpdates = () => useContext(Context);

/** The status a finished check leaves (HSR Updates.Available / NoInstaller / Current). */
export function checkedStatus(view: UpdateView): UpdateStatus {
  if (view.status === "newer") return { key: view.installerSize ? "available" : "noInstaller", version: view.latestVersion };
  if (view.status === "stale") return { key: "stale", version: view.latestVersion };
  return { key: "current", version: view.currentVersion };
}

/**
 * Session update state above the pages, so a download keeps its progress while
 * the user navigates. The background check runs once after startup when
 * "check on startup" is on; its result is offered once as a notice.
 */
export function LauncherUpdateProvider({ children, pollMs = 1000 }: { children?: ReactNode; pollMs?: number }) {
  const { t } = useTranslation();
  const { bootstrapped, data } = useLauncher();
  const [result, setResult] = useState<UpdateView | null>(null);
  const [status, setStatus] = useState<UpdateStatus>({ key: "notChecked" });
  const [progress, setProgress] = useState(0);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [notice, setNotice] = useState<UpdateView | null>(null);
  const busy = useRef(false);
  const started = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const cancelRequested = useRef(false);
  // HSR offers the startup result only if "check on startup" is still on when
  // the check ends, and a dismissed notice never comes back this session.
  const config: Config = data.config;
  const startupChecks = useRef(config.checkForUpdates);
  startupChecks.current = config.checkForUpdates;
  const noticeDismissed = useRef(false);
  const preferenceKey = `${config.updateSource}:${config.updateChannel ?? "stable"}`;
  // The source and channel the shown result was checked with; another saved value clears it.
  const resultSource = useRef<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const clearResult = useCallback(() => {
    generation.current++;
    resultSource.current = null;
    setResult(null);
    setNotice(null);
    setStatus({ key: "notChecked" });
  }, []);

  const check = useCallback(async (background = false) => {
    if (busy.current || !desktop) return;
    busy.current = true;
    const run = ++generation.current;
    const checkedPreference = preferenceKey;
    setChecking(true);
    setResult(null);
    setNotice(null);
    setStatus({ key: "checking" });
    try {
      const view = await command<UpdateView>("check_launcher_update");
      if (!mounted.current || run !== generation.current) return;
      resultSource.current = checkedPreference;
      setResult(view);
      setStatus(checkedStatus(view));
      if (background && view.status === "newer" && startupChecks.current && !noticeDismissed.current) setNotice(view);
    } catch (cause) {
      if (mounted.current && run === generation.current) setStatus({ key: "failed", error: normalizeError(cause) });
    } finally {
      busy.current = false;
      if (mounted.current) setChecking(false);
    }
  }, [preferenceKey]);

  const install = useCallback(async () => {
    if (busy.current || !result || result.status !== "newer" || !result.installerSize) return;
    busy.current = true;
    const run = ++generation.current;
    cancelRequested.current = false;
    noticeDismissed.current = true;
    setNotice(null);
    setInstalling(true);
    setProgress(0);
    setStatus({ key: "downloading" });
    let downloaded = false;
    try {
      // Like HSR's disabled button: nothing is downloaded while the install would be refused.
      const ready = await command<UpdateState>("get_launcher_update_state");
      if (!mounted.current || run !== generation.current) return;
      if (ready.busy) {
        setStatus({ key: "blocked", error: new LauncherError(ready.busy) });
        return;
      }
      await command<StagedView>("download_launcher_update");
      downloaded = true;
      if (!mounted.current || run !== generation.current) return;
      // A Cancel that arrived while the download was finishing still counts
      // (HSR checks the token after DownloadAsync); the verified file is kept.
      if (cancelRequested.current) {
        setStatus({ key: "cancelled" });
        return;
      }
      setProgress(1);
      setStatus({ key: "preparing" });
      // On success the launcher exits and the helper runs the installer.
      await command("install_launcher_update_and_exit", {
        errorText: t("settings:updates.helperFailed"),
        logsText: t("settings:updates.helperLogs"),
      });
    } catch (cause) {
      const error = normalizeError(cause);
      if (!mounted.current || run !== generation.current) return;
      if (error.code === "update.cancelled") {
        setStatus({ key: "cancelled" });
      } else if (error.code === "update.sourceChanged" || error.code === "update.notOffered") {
        // Only a new check helps: no Retry for these.
        resultSource.current = null;
        setResult(null);
        setStatus({ key: "downloadFailed", error });
      } else {
        setStatus({ key: downloaded ? "installFailed" : "downloadFailed", error });
      }
    } finally {
      busy.current = false;
      if (mounted.current) setInstalling(false);
    }
  }, [result, t]);

  const cancel = useCallback(() => {
    cancelRequested.current = true;
    if (desktop) void command("cancel_launcher_update").catch(() => {});
  }, []);

  const sourceChanged = useCallback(() => {
    if (!busy.current) clearResult();
  }, [clearResult]);

  const dismissNotice = useCallback(() => {
    noticeDismissed.current = true;
    setNotice(null);
  }, []);

  // A source or channel saved another way (a preset import, the settings form) clears a
  // result checked with the old one.
  useEffect(() => {
    if (resultSource.current !== null && resultSource.current !== preferenceKey && !busy.current) clearResult();
  }, [checking, clearResult, preferenceKey, installing]);

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    let stop: (() => void) | undefined;
    void events<{ downloaded: number; total: number }>("launcher://update-progress", ({ downloaded, total }) => {
      if (total > 0) setProgress(Math.min(1, Math.max(0, downloaded / total)));
    }).then((unlisten) => {
      if (active) stop = unlisten;
      else unlisten();
    });
    return () => {
      active = false;
      stop?.();
    };
  }, []);

  // Once per session: restore what the backend still holds (after a window
  // reload), else run the startup check when it is enabled.
  useEffect(() => {
    if (!bootstrapped || started.current || !desktop) return;
    started.current = true;
    void (async () => {
      let state: UpdateState | null = null;
      try {
        state = await command<UpdateState>("get_launcher_update_state");
      } catch {
        state = null;
      }
      if (!mounted.current) return;
      if (state?.check) {
        resultSource.current = preferenceKey;
        setResult(state.check);
        setStatus(checkedStatus(state.check));
      }
      if (state && state.download !== "idle") {
        // An operation from before the reload: follow it until it ends.
        busy.current = true;
        setInstalling(true);
        for (let phase = state.download; mounted.current;) {
          setStatus(followedStatus(phase));
          await new Promise((resolve) => setTimeout(resolve, pollMs));
          const next = await command<UpdateState>("get_launcher_update_state").catch(() => null);
          if (!next) continue;
          if (next.download === "idle") {
            busy.current = false;
            if (!mounted.current) return;
            setInstalling(false);
            setStatus(next.check ? checkedStatus(next.check) : { key: "notChecked" });
            return;
          }
          phase = next.download;
        }
        return;
      }
      if (!state?.check && config.checkForUpdates) await check(true);
    })();
  }, [bootstrapped, check, config.checkForUpdates, preferenceKey, pollMs]);

  const value = useMemo<LauncherUpdates>(() => ({
    result, status, progress, checking, installing, notice,
    check: () => check(false), install, cancel, sourceChanged, dismissNotice,
  }), [result, status, progress, checking, installing, notice, check, install, cancel, sourceChanged, dismissNotice]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** What a followed backend phase shows: no Cancel once it is cancelling or installing. */
function followedStatus(phase: UpdateState["download"]): UpdateStatus {
  if (phase === "installing") return { key: "preparing" };
  if (phase === "cancelling") return { key: "cancelled" };
  return { key: "downloading" };
}

/**
 * Shows the startup notice once (HSR StartupUpdateNotice). Closing it, letting
 * it time out or choosing "View update" dismisses it for the session. It waits
 * while a launcher notice holds the single toast slot or a game is being
 * prepared or runs, and comes back if a launcher notice replaced it.
 */
export function UpdateNoticeBridge({ onReview }: { onReview: () => void }) {
  const { t } = useTranslation();
  const { notice: launcherNotice, preparing, running } = useLauncher();
  const { notice, dismissNotice } = useLauncherUpdates();
  const { notify, dismiss } = useToast();
  const review = useRef(onReview);
  review.current = onReview;
  // HSR shows it only while no session runs (StartupUpdateNotice Visible()).
  const waiting = Boolean(launcherNotice) || preparing || running.length > 0;
  useEffect(() => {
    if (!notice) {
      dismiss("launcher-update");
      return;
    }
    if (waiting) return;
    const version = notice.latestVersion;
    notify({
      id: "launcher-update",
      kind: "info",
      message: t(notice.installerSize ? "settings:updates.notice" : "settings:updates.status.noInstaller", { version }),
      action: { label: t("settings:updates.review"), onClick: () => review.current() },
      onDismiss: dismissNotice,
    });
  }, [notice, waiting, dismissNotice, dismiss, notify, t]);
  return null;
}
