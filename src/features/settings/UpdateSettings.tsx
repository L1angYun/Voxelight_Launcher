import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, ExternalLink as OpenIcon, RefreshCw, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useLauncher } from "../../app/controller/LauncherProvider";
import { Button } from "../../components/ui/Button";
import { Select } from "../../components/ui/Select";
import { LatticeProgress } from "../../visual/lattice/LatticeProgress";
import { command, type Config } from "../../lib/launcher";
import type { LauncherError } from "../../lib/errors";
import { useLauncherUpdates, type UpdateStatus } from "../updates/LauncherUpdates";
import type { SettingsSectionProps } from "./types";

type Props = Pick<SettingsSectionProps, "config" | "onPersistedPatch" | "onError"> & {
  /** Set when the startup notice asks to review the update; handled once. */
  focusRequest?: number;
  onFocusHandled?: () => void;
};

const sources = ["auto", "github", "gitee"] as const;

/** Settings → About → Updates (HSR "Updates" section). */
export function UpdateSettings({ config, onPersistedPatch, onError, focusRequest, onFocusHandled }: Props) {
  const { t, i18n } = useTranslation();
  const { running } = useLauncher();
  const updates = useLauncherUpdates();
  const { result, status, progress, checking, installing } = updates;
  const [saving, setSaving] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const section = useRef<HTMLElement>(null);
  const installButton = useRef<HTMLButtonElement>(null);
  const checkButton = useRef<HTMLButtonElement>(null);
  const gameRunning = running.length > 0;
  const available = result?.status === "newer";
  const canInstall = available && Boolean(result?.installerSize);
  const unblocked = !checking && !installing && !saving;

  useEffect(() => {
    if (!focusRequest) return;
    section.current?.scrollIntoView?.({ block: "nearest" });
    const target = installButton.current && !installButton.current.disabled ? installButton.current : checkButton.current;
    target?.focus();
    // HSR moves focus once; coming back to About later leaves it alone.
    onFocusHandled?.();
  }, [focusRequest, onFocusHandled]);

  async function savePreferences(patch: Pick<Config, "checkForUpdates" | "updateSource">) {
    setSaving(true);
    try {
      const next = await command<Config>("set_launcher_update_preferences", patch);
      // Saved: clear what no longer applies before the page reloads its data.
      if (next.updateSource !== config.updateSource) updates.sourceChanged();
      if (!next.checkForUpdates) updates.dismissNotice();
      await onPersistedPatch({ checkForUpdates: next.checkForUpdates, updateSource: next.updateSource });
    } catch (cause) {
      onError(cause);
    } finally {
      setSaving(false);
    }
  }

  async function openRelease() {
    if (!result) return;
    setOpenFailed(false);
    try {
      await openUrl(result.releaseUrl);
    } catch {
      setOpenFailed(true);
    }
  }

  function errorText(error: LauncherError) {
    const key = [`settings:errors.${error.code}`, `shell:errors.${error.code}`].find((key) => i18n.exists(key));
    return key ? t(key, error.params) : "";
  }

  function statusText(value: UpdateStatus) {
    switch (value.key) {
      case "available":
      case "noInstaller":
      case "current":
      case "stale":
        return t(`settings:updates.status.${value.key}`, { version: value.version });
      case "downloading":
        return t("settings:updates.status.downloading", { percent: Math.round(progress * 100) });
      case "failed": {
        const fixed = { "update.rateLimited": "rateLimited", "update.timedOut": "timedOut" }[value.error.code];
        if (fixed) return t(`settings:updates.status.${fixed}`);
        // A proxy or network code names the real cause; another source would not help.
        const reason = value.error.code.startsWith("update.") ? "" : errorText(value.error);
        return reason || t("settings:updates.status.failed");
      }
      case "blocked":
        return errorText(value.error) || t("settings:updates.status.installFailed");
      case "downloadFailed":
      case "installFailed": {
        // A refusal with its own reason (a game is running, the source changed…) says why.
        return errorText(value.error) || t(`settings:updates.status.${value.key}`);
      }
      default:
        return t(`settings:updates.status.${value.key}`);
    }
  }

  const failed = status.key === "failed" || status.key === "downloadFailed" || status.key === "installFailed" || status.key === "blocked";
  return (
    <section ref={section} className="vx-settings-group vx-settings-updates" aria-labelledby="vx-updates-title">
      <h3 id="vx-updates-title">{t("settings:updates.section")}</h3>
      <label className="vx-settings-check">
        <input type="checkbox" aria-label={t("settings:updates.checkOnStartup")} checked={config.checkForUpdates} disabled={saving}
          onChange={(event) => void savePreferences({ checkForUpdates: event.target.checked, updateSource: config.updateSource })} />
        <span>{t("settings:updates.checkOnStartup")}<small>{t("settings:updates.checkOnStartupTip")}</small></span>
      </label>
      <label>
        {t("settings:updates.source")}
        <Select aria-label={t("settings:updates.source")} value={config.updateSource} disabled={!unblocked}
          onChange={(value) => {
            if (value !== config.updateSource) void savePreferences({ checkForUpdates: config.checkForUpdates, updateSource: value as Config["updateSource"] });
          }}
          options={sources.map((value) => ({ value, label: t(`settings:updates.sources.${value}`) }))} />
      </label>
      <p>{t("settings:updates.sourceTip")}</p>
      <p className={failed ? "vx-settings-error" : undefined} role={failed ? "alert" : "status"} data-testid="launcher-update-status">
        {statusText(status)}
      </p>
      {openFailed ? <p className="vx-settings-error" role="alert">{t("settings:updates.openFailed")}</p> : null}
      {installing ? (
        <LatticeProgress completed={Math.round(progress * 100)} total={100} unit="items"
          status={status.key === "preparing" ? "unknown" : "active"} label={t("settings:updates.progress")} />
      ) : null}
      {canInstall && gameRunning && !installing ? <p>{t("settings:updates.installWhenIdle")}</p> : null}
      {available && result?.notes ? (
        <details className="vx-settings-update-notes">
          <summary>{t("settings:updates.notes", { version: result.latestVersion })}</summary>
          <p>{result.notes}</p>
        </details>
      ) : null}
      <div className="vx-action-row">
        <Button ref={checkButton} variant="secondary" icon={<RefreshCw size={15} />} loading={checking} disabled={!unblocked}
          onClick={() => void updates.check()}>
          {t("settings:updates.checkNow")}
        </Button>
        {available ? (
          <Button variant="ghost" icon={<OpenIcon size={15} />} disabled={!unblocked} onClick={() => void openRelease()}>
            {t("settings:updates.openRelease")}
          </Button>
        ) : null}
        {canInstall && !installing ? (
          <Button ref={installButton} variant="primary" icon={<Download size={15} />} disabled={!unblocked || gameRunning}
            onClick={() => void updates.install()}>
            {t(status.key === "downloadFailed" || status.key === "installFailed" ? "settings:updates.retryInstall" : "settings:updates.install")}
          </Button>
        ) : null}
        {installing && status.key === "downloading" ? (
          <Button variant="ghost" icon={<X size={15} />} onClick={updates.cancel}>{t("settings:updates.cancel")}</Button>
        ) : null}
      </div>
      {canInstall ? <p>{t("settings:updates.installTip")}</p> : null}
    </section>
  );
}
