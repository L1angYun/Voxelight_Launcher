import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Download, KeyRound, Upload } from "lucide-react";
import { command } from "../../lib/launcher";
import { Button } from "../../components/ui/Button";
import type { SettingsSectionProps } from "./types";

export function GeneralSettings({ config, onChange, onPersisted, onError, onNotice }: SettingsSectionProps) {
  const { t } = useTranslation();
  const [key, setKey] = useState("");
  const [configured, setConfigured] = useState(false);
  const [builtin, setBuiltin] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void command<{ curseforgeConfigured: boolean; microsoftBuiltin?: boolean }>("get_service_status")
      .then((value) => {
        if (active) {
          setConfigured(value.curseforgeConfigured);
          setBuiltin(value.microsoftBuiltin === true);
        }
      })
      .catch(onError);
    return () => {
      active = false;
    };
  }, [onError]);

  async function saveSecret(secret: string) {
    setBusy(true);
    try {
      const value = await command<boolean>("set_service_secret", { service: "curseforge", secret });
      setConfigured(value);
      if (secret) {
        setKey("");
        onNotice("secretSaved");
      } else onNotice("secretCleared");
    } catch (cause) {
      onError(cause);
    } finally {
      setBusy(false);
    }
  }

  async function preset(mode: "import" | "export") {
    try {
      const path = mode === "export"
        ? await save({
            defaultPath: "voxelight-launcher-preset.json",
            filters: [{ name: t("settings:preset.filter"), extensions: ["json"] }],
          })
        : await open({
            multiple: false,
            filters: [{ name: t("settings:preset.filter"), extensions: ["json"] }],
          });
      if (typeof path !== "string") return;
      if (mode === "export") {
        await command("export_launcher_config", { path });
        onNotice("presetExported");
      } else {
        const next = await command<typeof config>("import_launcher_config", { path });
        await onPersisted(next);
        onNotice("presetImported");
      }
    } catch (cause) {
      onError(cause);
    }
  }

  return (
    <div className="vx-settings-section">
      <header><h2>{t("settings:section.general")}</h2><p>{t("settings:generalDescription")}</p></header>
      <section className="vx-settings-group">
        <h3><KeyRound size={17} />{t("settings:service.title")}</h3>
        <p>{t("settings:service.description")}</p>
        <label>
          {t(builtin ? "settings:service.clientIdOptional" : "settings:service.clientId")}
          <input
            aria-label="Microsoft Client ID"
            value={config.microsoftClientId}
            placeholder={t(builtin ? "settings:service.clientIdBuiltinPlaceholder" : "settings:service.clientIdPlaceholder")}
            onChange={(event) => onChange({ ...config, microsoftClientId: event.target.value.trim() })}
          />
        </label>
        {builtin ? <p>{t("settings:service.builtinActive")}</p> : null}
        <label>
          {t("settings:service.curseforgeKey")}
          <span className="vx-settings-input-action">
            <input
              aria-label="CurseForge API Key"
              type="password"
              autoComplete="off"
              value={key}
              placeholder={configured ? t("settings:service.keyConfiguredPlaceholder") : t("settings:service.keyPlaceholder")}
              onChange={(event) => setKey(event.target.value)}
            />
            <Button variant="secondary" loading={busy} disabled={!key.trim()} onClick={() => void saveSecret(key)}>{t("settings:service.saveKey")}</Button>
          </span>
        </label>
        {configured ? <p role="status">{t("settings:service.configured")} <Button variant="ghost" disabled={busy} onClick={() => void saveSecret("")}>{t("settings:service.clearKey")}</Button></p> : null}
      </section>

      <section className="vx-settings-group">
        <h3>{t("settings:preset.title")}</h3>
        <p>{t("settings:preset.description")}</p>
        <div className="vx-action-row">
          <Button variant="secondary" icon={<Download size={15} />} onClick={() => void preset("export")}>{t("settings:preset.export")}</Button>
          <Button variant="secondary" icon={<Upload size={15} />} onClick={() => void preset("import")}>{t("settings:preset.import")}</Button>
        </div>
      </section>
    </div>
  );
}
