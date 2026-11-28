import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Radar } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Select } from "../../components/ui/Select";
import { command, desktop, type Config, type DetectedProxy, type LocalProxyReport } from "../../lib/launcher";
import { useLeaveGuard } from "../../app/leaveGuard";
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
  // One proxy operation at a time; the leave guard needs to know which one runs.
  const inFlight = useRef<{ kind: "test" | "credentials"; done: Promise<boolean> } | null>(null);

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

  function exclusive(kind: "test" | "credentials", task: () => Promise<boolean>): Promise<boolean> {
    setBusy(true);
    const done = task().finally(() => {
      if (inFlight.current?.done === done) inFlight.current = null;
      if (active.current) setBusy(false);
    });
    inFlight.current = { kind, done };
    return done;
  }

  function testConnection() {
    if (inFlight.current) return;
    void exclusive("test", async () => {
      try {
        const { latencyMs } = await command<{ latencyMs: number }>("test_proxy_connection", probeSettings(config));
        if (active.current) onNotice("proxyConnected", { latencyMs });
        return true;
      } catch (cause) {
        if (active.current) onError(cause);
        return false;
      }
    });
  }

  function saveCredentials(clear: boolean): Promise<boolean> {
    if (!endpointSaved) return Promise.resolve(false);
    if (inFlight.current) return inFlight.current.kind === "credentials" ? inFlight.current.done : Promise.resolve(false);
    return exclusive("credentials", async () => {
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
        return true;
      } catch (cause) {
        if (active.current) onError(cause);
        return false;
      }
    });
  }

  // Typed credentials live only in these fields, outside the settings draft, so
  // they register with the leave guard and save through the same command.
  useLeaveGuard(username.length > 0 || password.length > 0, {
    save: async () => {
      if (!username && !password) return { ok: true };
      if (!endpointSaved) return { ok: false, message: t("settings:proxy.leaveEndpointUnsaved") };
      // The backend refuses a password without a username, as the Save button does.
      if (!username) return { ok: false, message: t("settings:proxy.leaveUsernameRequired") };
      const running = inFlight.current;
      if (running?.kind === "credentials") return (await running.done) ? { ok: true } : { ok: false };
      // A connection test holds the lock; let it finish instead of reporting a failed save.
      if (running) await running.done;
      return (await saveCredentials(false)) ? { ok: true } : { ok: false };
    },
    discard: () => {
      setUsername("");
      setPassword("");
    },
    running: () => (inFlight.current?.kind === "credentials" ? inFlight.current.done : null),
  });

  return (
    <>
      <div className="vx-action-row" data-settings-target="downloads-proxy-test">
        <Button disabled={busy} onClick={() => void testConnection()}>{t("settings:proxy.test")}</Button>
      </div>
      {config.proxyMode === "custom" ? (
        <>
          <p>{t("settings:proxy.credentialStorage")}</p>
          {config.proxyScheme === "http" ? <p>{t("settings:proxy.httpWarning")}</p> : null}
          {!endpointSaved ? <p>{t("settings:proxy.saveEndpointFirst")}</p> : null}
          <div className="vx-settings-fields">
            <label data-settings-target="downloads-proxy-username">{t("settings:proxy.username")}
              <input aria-label={t("settings:proxy.username")} autoComplete="off" maxLength={255} value={username}
                disabled={!endpointSaved || loadingStatus || busy} onChange={(event) => setUsername(event.target.value)} />
            </label>
            <label data-settings-target="downloads-proxy-password">{t("settings:proxy.password")}
              <input aria-label={t("settings:proxy.password")} type="password" autoComplete="new-password" maxLength={255} value={password}
                disabled={!endpointSaved || loadingStatus || busy} onChange={(event) => setPassword(event.target.value)} />
            </label>
          </div>
          <div className="vx-action-row" data-settings-target="downloads-proxy-credentials-actions">
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
  const [detected, setDetected] = useState<LocalProxyReport | null>(null);
  const [detecting, setDetecting] = useState(false);
  const mounted = useRef(true);
  const endpointKey = JSON.stringify(probeSettings(config));
  const endpointSaved = config.proxyMode === "custom" && endpointKey === JSON.stringify(probeSettings(savedConfig));

  const detectLocal = useCallback(async (announce: boolean) => {
    if (!desktop) return;
    setDetecting(true);
    try {
      const report = await command<LocalProxyReport>("detect_local_proxies");
      if (!mounted.current || !report) return;
      setDetected(report);
      if (announce) {
        onNotice(
          report.candidates.length > 0 ? "proxyDetected" : "proxyNoneDetected",
          { count: report.candidates.length },
        );
      }
    } catch (cause) {
      if (announce && mounted.current) onError(cause);
    } finally {
      if (mounted.current) setDetecting(false);
    }
  }, [onError, onNotice]);

  useEffect(() => {
    mounted.current = true;
    void detectLocal(false);
    return () => { mounted.current = false; };
  }, [detectLocal]);

  function applyDetected(item: DetectedProxy) {
    if (item.source === "windowsSystem" && config.proxyMode !== "system") {
      onChange({ ...config, proxyMode: "system" });
      return;
    }
    onChange({
      ...config,
      proxyMode: "custom",
      proxyScheme: item.scheme,
      proxyHost: item.host,
      proxyPort: item.port,
    });
  }

  return (
    <section className="vx-settings-group">
      <h3>{t("settings:proxy.title")}</h3>
      <p>{t("settings:proxy.restartNotice")}</p>
      <label data-settings-target="downloads-proxy-mode">{t("settings:proxy.mode")}
        <Select aria-label={t("settings:proxy.mode")} value={config.proxyMode ?? "system"}
          onChange={(proxyMode) => onChange({ ...config, proxyMode })}
          options={["system", "none", "custom"].map((value) => ({ value, label: t(`settings:proxy.modes.${value}`) }))} />
      </label>

      <div className="vx-proxy-detected" data-testid="proxy-detected-panel">
        <div className="vx-proxy-detected__head">
          <span role="status">
            {detected?.systemProxy
              ? t("settings:proxy.systemDetected", { url: detected.systemProxy.url })
              : detected?.autoConfigUrl
                ? t("settings:proxy.pacDetected", { url: detected.autoConfigUrl })
                : t("settings:proxy.systemNone")}
          </span>
          <div data-settings-target="downloads-proxy-detect">
            <Button
              size="sm"
              variant="secondary"
              data-settings-primary=""
              icon={<Radar size={14} />}
              loading={detecting}
              onClick={() => void detectLocal(true)}
            >
              {t("settings:proxy.detect")}
            </Button>
          </div>
        </div>
        {detected && detected.candidates.length > 0 ? (
          <ul className="vx-proxy-detected__list">
            {detected.candidates.map((item) => (
              <li key={item.url} className="vx-proxy-detected__row">
                <div className="vx-proxy-detected__info">
                  <code>{item.url}</code>
                  <small className="vx-proxy-detected__meta">
                    <span>{t(`settings:proxy.sources.${item.source}`)}</span>{" "}
                    <span>{item.label}</span>
                  </small>
                </div>
                <Button size="sm" variant="ghost" onClick={() => applyDetected(item)}>
                  {t("settings:proxy.applyDetected")}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {config.proxyMode === "custom" ? (
        <>
          <label data-settings-target="downloads-proxy-scheme">{t("settings:proxy.scheme")}
            <Select aria-label={t("settings:proxy.scheme")} value={config.proxyScheme ?? "http"}
              onChange={(proxyScheme) => onChange({ ...config, proxyScheme })}
              options={[{ value: "http", label: "http://" }, { value: "https", label: "https://" }]} />
          </label>
          <div className="vx-settings-fields">
            <label data-settings-target="downloads-proxy-host">{t("settings:proxy.host")}
              <input aria-label={t("settings:proxy.host")} maxLength={253} value={config.proxyHost ?? ""}
                onChange={(event) => onChange({ ...config, proxyHost: event.target.value })} />
            </label>
            <label data-settings-target="downloads-proxy-port">{t("settings:proxy.port")}
              <input aria-label={t("settings:proxy.port")} type="number" min={1} max={65535} value={config.proxyPort || ""}
                onChange={(event) => onChange({ ...config, proxyPort: Number(event.target.value) })} />
            </label>
          </div>
        </>
      ) : null}
      <label data-settings-target="downloads-proxy-game-mode">{t("settings:proxy.gameMode")}
        <Select aria-label={t("settings:proxy.gameMode")} value={config.gameProxyMode ?? "system"}
          onChange={(gameProxyMode) => onChange({ ...config, gameProxyMode })}
          options={["system", "off", "launcher"].map((value) => ({ value, label: t(`settings:proxy.gameModes.${value}`) }))} />
      </label>
      <p>{t("settings:proxy.javaDescription")}</p>
      <ProxyActions key={`${endpointKey}:${endpointSaved}`} config={config} endpointSaved={endpointSaved} onError={onError} onNotice={onNotice} />
    </section>
  );
}
