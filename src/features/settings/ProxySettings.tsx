import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/Button";
import { Select } from "../../components/ui/Select";
import { command, type Config } from "../../lib/launcher";
import type { SettingsSectionProps } from "./types";

function probeSettings(config: Config) {
  const { proxyMode, proxyScheme, proxyHost, proxyPort } = config;
  return { proxyMode, proxyScheme, proxyHost, proxyPort };
}

function ProxyActions({ config, endpointSaved, onError, onNotice }: Pick<SettingsSectionProps, "config" | "onError" | "onNotice"> & { endpointSaved: boolean }) {
  const { t } = useTranslation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [configured, setConfigured] = useState(false);
  const [statusUnreadable, setStatusUnreadable] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState(endpointSaved);
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const inFlight = useRef(false);

  useEffect(() => {
    active.current = true;
    let current = true;
    if (endpointSaved) {
      void command<{ proxyCredentialsConfigured?: boolean; proxyCredentialsUnreadable?: boolean }>("get_service_status")
        .then((value) => {
          if (!current) return;
          setConfigured(value.proxyCredentialsConfigured === true);
          setStatusUnreadable(value.proxyCredentialsUnreadable === true);
          if (value.proxyCredentialsUnreadable) onError({ code: "proxy.invalidCredentials" });
        })
        .catch((cause) => { if (current) onError(cause); })
        .finally(() => { if (current) setLoadingStatus(false); });
    }
    return () => { current = false; active.current = false; };
  }, [endpointSaved, onError]);

  async function testConnection() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const { latencyMs } = await command<{ latencyMs: number }>("test_proxy_connection", probeSettings(config));
      if (active.current) onNotice("proxyConnected", { latencyMs });
    } catch (cause) {
      if (active.current) onError(cause);
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  }

  async function saveCredentials(clear: boolean) {
    if (!endpointSaved || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const saved = await command<boolean>("set_proxy_credentials", {
        ...probeSettings(config), username: clear ? "" : username, password: clear ? "" : password,
      });
      if (active.current) {
        setConfigured(saved);
        setStatusUnreadable(false);
        setUsername("");
        setPassword("");
        onNotice(saved ? "proxyCredentialsSaved" : "proxyCredentialsCleared");
      }
    } catch (cause) {
      if (active.current) onError(cause);
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  }

  return (
    <>
      <div className="vx-action-row">
        <Button disabled={busy} onClick={() => void testConnection()}>{t("settings:proxy.test")}</Button>
      </div>
      {config.proxyMode === "custom" ? (
        <>
          <p>{t("settings:proxy.credentialStorage")}</p>
          {config.proxyScheme === "http" ? <p>{t("settings:proxy.httpWarning")}</p> : null}
          {!endpointSaved ? <p>{t("settings:proxy.saveEndpointFirst")}</p> : null}
          <div className="vx-settings-fields">
            <label>{t("settings:proxy.username")}
              <input aria-label={t("settings:proxy.username")} autoComplete="off" maxLength={255} value={username}
                disabled={!endpointSaved || loadingStatus || busy} onChange={(event) => setUsername(event.target.value)} />
            </label>
            <label>{t("settings:proxy.password")}
              <input aria-label={t("settings:proxy.password")} type="password" autoComplete="new-password" maxLength={255} value={password}
                disabled={!endpointSaved || loadingStatus || busy} onChange={(event) => setPassword(event.target.value)} />
            </label>
          </div>
          <div className="vx-action-row">
            <Button disabled={!endpointSaved || loadingStatus || busy || !username} onClick={() => void saveCredentials(false)}>{t("settings:proxy.saveCredentials")}</Button>
            {configured || statusUnreadable ? <Button variant="ghost" disabled={busy || loadingStatus} onClick={() => void saveCredentials(true)}>{t("settings:proxy.clearCredentials")}</Button> : null}
          </div>
          {configured ? <><p>{t("settings:proxy.credentialsConfigured")}</p><p>{t("settings:proxy.javaNoCredentials")}</p></> : null}
        </>
      ) : null}
    </>
  );
}

export function ProxySettings({ config, savedConfig, onChange, onError, onNotice }: SettingsSectionProps & { savedConfig: Config }) {
  const { t } = useTranslation();
  const endpointKey = JSON.stringify(probeSettings(config));
  const endpointSaved = config.proxyMode === "custom" && endpointKey === JSON.stringify(probeSettings(savedConfig));
  return (
    <section className="vx-settings-group">
      <h3>{t("settings:proxy.title")}</h3>
      <p>{t("settings:proxy.restartNotice")}</p>
      <label>{t("settings:proxy.mode")}
        <Select aria-label={t("settings:proxy.mode")} value={config.proxyMode ?? "system"}
          onChange={(proxyMode) => onChange({ ...config, proxyMode })}
          options={["system", "none", "custom"].map((value) => ({ value, label: t(`settings:proxy.modes.${value}`) }))} />
      </label>
      {config.proxyMode === "custom" ? (
        <>
          <label>{t("settings:proxy.scheme")}
            <Select aria-label={t("settings:proxy.scheme")} value={config.proxyScheme ?? "http"}
              onChange={(proxyScheme) => onChange({ ...config, proxyScheme })}
              options={[{ value: "http", label: "http://" }, { value: "https", label: "https://" }]} />
          </label>
          <div className="vx-settings-fields">
            <label>{t("settings:proxy.host")}
              <input aria-label={t("settings:proxy.host")} maxLength={253} value={config.proxyHost ?? ""}
                onChange={(event) => onChange({ ...config, proxyHost: event.target.value })} />
            </label>
            <label>{t("settings:proxy.port")}
              <input aria-label={t("settings:proxy.port")} type="number" min={1} max={65535} value={config.proxyPort || ""}
                onChange={(event) => onChange({ ...config, proxyPort: Number(event.target.value) })} />
            </label>
          </div>
        </>
      ) : null}
      <label>{t("settings:proxy.gameMode")}
        <Select aria-label={t("settings:proxy.gameMode")} value={config.gameProxyMode ?? "off"}
          onChange={(gameProxyMode) => onChange({ ...config, gameProxyMode })}
          options={["off", "system", "launcher"].map((value) => ({ value, label: t(`settings:proxy.gameModes.${value}`) }))} />
      </label>
      <p>{t("settings:proxy.javaDescription")}</p>
      <ProxyActions key={`${endpointKey}:${endpointSaved}`} config={config} endpointSaved={endpointSaved} onError={onError} onNotice={onNotice} />
    </section>
  );
}
