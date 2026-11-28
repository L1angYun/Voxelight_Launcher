import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { pickLauncherPath } from "../../lib/nativePaths";
import { Download, RotateCcw, Upload } from "lucide-react";
import { command, type Config } from "../../lib/launcher";
import { normalizeError } from "../../lib/errors";
import { useLeaveGuard, useSharedSave } from "../../app/leaveGuard";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { useLumen } from "../assistant/LumenContext";
import type { SettingsSectionProps } from "./types";

export function GeneralSettings({ config, onChange, onPersisted, onError, onNotice }: SettingsSectionProps) {
  const { t } = useTranslation();
  const lumen = useLumen();
  const keyHintId = useId();
  const [key, setKey] = useState("");
  const [configured, setConfigured] = useState(false);
  const [builtin, setBuiltin] = useState(false);
  const [curseforgeBuiltin, setCurseforgeBuiltin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmResetOpen, setConfirmResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const mountedRef = useRef(true);
  const statusGenRef = useRef(0);
  const secretSave = useSharedSave<boolean>();

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const loadServiceStatus = useCallback(async () => {
    const gen = ++statusGenRef.current;
    try {
      const value = await command<{ curseforgeConfigured: boolean; curseforgeBuiltin?: boolean; microsoftBuiltin?: boolean }>("get_service_status");
      if (!mountedRef.current || gen !== statusGenRef.current) return;
      setConfigured(value.curseforgeConfigured);
      setCurseforgeBuiltin(value.curseforgeBuiltin === true);
      setBuiltin(value.microsoftBuiltin === true);
    } catch (cause) {
      if (mountedRef.current && gen === statusGenRef.current) onError(cause);
    }
  }, [onError]);

  useEffect(() => {
    void loadServiceStatus();
  }, [loadServiceStatus]);

  function saveSecret(secret: string): Promise<boolean> {
    return secretSave.run(async () => {
      setBusy(true);
      try {
        const value = await command<boolean>("set_service_secret", { service: "curseforge", secret });
        setConfigured(value);
        if (secret) {
          setKey("");
          onNotice("secretSaved");
        } else onNotice("secretCleared");
        return true;
      } catch (cause) {
        onError(cause);
        return false;
      } finally {
        setBusy(false);
      }
    });
  }

  // The typed key lives only in this field, outside the settings draft, so it
  // registers with the leave guard itself and saves through the same command.
  useLeaveGuard(key.trim().length > 0, {
    save: async () => {
      const running = secretSave.current();
      if (running) return (await running) ? { ok: true } : { ok: false };
      if (!key.trim()) return { ok: true };
      return (await saveSecret(key)) ? { ok: true } : { ok: false };
    },
    discard: () => setKey(""),
    running: secretSave.current,
  });

  async function preset(mode: "import" | "export") {
    try {
      const path = mode === "export"
        ? await pickLauncherPath("presetWrite", "voxelight-launcher-preset.json")
        : await pickLauncherPath("presetRead");
      if (typeof path !== "string") return;
      if (mode === "export") {
        await command("export_launcher_config", { path });
        onNotice("presetExported");
      } else {
        const imported = await command<{ config: typeof config; heapArgumentsRemoved: boolean }>("import_launcher_config", { path });
        await onPersisted(imported.config);
        onNotice(imported.heapArgumentsRemoved ? "presetImportedHeapRemoved" : "presetImported");
      }
    } catch (cause) {
      onError(cause);
    }
  }

  return (
    <div className="vx-settings-section">
      <header><h2>{t("settings:section.general")}</h2><p>{t("settings:generalDescription")}</p></header>
      <section className="vx-settings-group">
        <h3>{t("settings:service.title")}</h3>
        <p>{t("settings:service.description")}</p>
        <label data-settings-target="general-client-id">
          {t(builtin ? "settings:service.clientIdOptional" : "settings:service.clientId")}
          <input
            aria-label="Microsoft Client ID"
            value={config.microsoftClientId}
            placeholder={t(builtin ? "settings:service.clientIdBuiltinPlaceholder" : "settings:service.clientIdPlaceholder")}
            onChange={(event) => onChange({ ...config, microsoftClientId: event.target.value.trim() })}
          />
        </label>
        {builtin ? <p>{t("settings:service.builtinActive")}</p> : null}
        <label data-settings-target="general-curseforge-key">
          {t("settings:service.curseforgeKey")}
          <span className="vx-settings-input-action">
            <input
              aria-label="CurseForge API Key"
              type="password"
              autoComplete="off"
              aria-describedby={keyHintId}
              value={key}
              placeholder={configured
                ? t("settings:service.keyConfiguredPlaceholder")
                : curseforgeBuiltin ? t("settings:service.curseforgeBuiltinPlaceholder") : t("settings:service.keyPlaceholder")}
              onChange={(event) => setKey(event.target.value)}
            />
            <Button variant="secondary" loading={busy} disabled={!key.trim()} onClick={() => void saveSecret(key)}>{t("settings:service.saveKey")}</Button>
          </span>
          <small className="vx-settings-hint" id={keyHintId}>{t("settings:service.keySeparateHint")}</small>
        </label>
        {configured ? <p role="status">{t("settings:service.configured")} <Button variant="ghost" disabled={busy} onClick={() => void saveSecret("")}>{t("settings:service.clearKey")}</Button></p> : null}
      </section>

      <section className="vx-settings-group">
        <h3>{t("settings:preset.title")}</h3>
        <p>{t("settings:preset.description")}</p>
        <div className="vx-action-row" data-settings-target="general-presets">
          <Button variant="secondary" data-settings-target="general-export-preset" icon={<Download size={15} />} onClick={() => void preset("export")}>{t("settings:preset.export")}</Button>
          <Button variant="secondary" data-settings-target="general-import-preset" icon={<Upload size={15} />} onClick={() => void preset("import")}>{t("settings:preset.import")}</Button>
        </div>
      </section>

      <section className="vx-settings-group">
        <h3>{t("settings:resetLauncher.title")}</h3>
        <p>{t("settings:resetLauncher.description")}</p>
        <div className="vx-action-row" data-settings-target="general-reset-launcher">
          <Button
            variant="secondary"
            tone="danger"
            data-settings-primary=""
            icon={<RotateCcw size={15} />}
            onClick={() => setConfirmResetOpen(true)}
          >
            {t("settings:resetLauncher.action")}
          </Button>
        </div>
      </section>

      {confirmResetOpen ? (
        <Dialog
          open
          onOpenChange={setConfirmResetOpen}
          title={t("settings:resetLauncher.confirmTitle")}
          description={t("settings:resetLauncher.confirmDescription")}
          closeLabel={t("common:a11y.closeDialog")}
          footer={
            <>
              <Button variant="ghost" disabled={resetting} onClick={() => setConfirmResetOpen(false)}>
                {t("common:actions.cancel")}
              </Button>
              <Button
                variant="primary"
                tone="danger"
                loading={resetting}
                onClick={async () => {
                  setResetting(true);
                  const adoptReset = async (fresh: Config) => {
                    setConfigured(false);
                    setKey("");
                    await Promise.all([lumen.refreshStatus(), loadServiceStatus()]);
                    await onPersisted(fresh);
                    setConfirmResetOpen(false);
                  };
                  try {
                    await adoptReset(await command<Config>("reset_launcher_state"));
                    onNotice("launcherReset");
                  } catch (cause) {
                    // This code means the reset already committed and only an
                    // account token is left for the next start. The form must
                    // take the committed config, or a later save would write
                    // the old one back over the reset.
                    if (normalizeError(cause).code === "reset.credentialsPending") {
                      try {
                        await adoptReset(await command<Config>("get_config"));
                      } catch {
                        // The reset error below still tells the user to restart.
                      }
                    }
                    onError(cause);
                  } finally {
                    setResetting(false);
                  }
                }}
              >
                {t("settings:resetLauncher.confirmAction")}
              </Button>
            </>
          }
        >
          <div className="vx-reset-confirm">
            <p>{t("settings:resetLauncher.willResetTitle")}</p>
            <ul>
              <li>{t("settings:resetLauncher.willResetConfig")}</li>
              <li>{t("settings:resetLauncher.willResetAccounts")}</li>
              <li>{t("settings:resetLauncher.willResetSecrets")}</li>
              <li>{t("settings:resetLauncher.willResetRegistry")}</li>
            </ul>
            <p className="vx-reset-confirm__safe">{t("settings:resetLauncher.preservedNote")}</p>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
