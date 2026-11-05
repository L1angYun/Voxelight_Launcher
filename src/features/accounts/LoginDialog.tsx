import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { command, desktop, type Config } from "../../lib/launcher";
import { LauncherError } from "../../lib/errors";
import {
  cancelled,
  waitForMicrosoftLogin,
  type AuthlibLogin,
  type AuthlibProfile,
  type DeviceLogin,
  type DevicePoll,
} from "../../components/accountLogin";
import { Dialog } from "../../components/ui/Dialog";
import { Button } from "../../components/ui/Button";
import { Segmented } from "../../components/ui/Segmented";
import { accountErrorText } from "./utils";

type LoginTab = "microsoft" | "offline" | "authlib";
interface ActiveLogin {
  controller: AbortController;
  sessionId?: string;
}

export function LoginDialog({
  open,
  onOpenChange,
  config,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: Config;
  onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<LoginTab>("microsoft");
  const [clientId, setClientId] = useState(config.microsoftClientId || "");
  const [offlineName, setOfflineName] = useState("");
  const [server, setServer] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [device, setDevice] = useState<DeviceLogin | null>(null);
  const [profiles, setProfiles] = useState<AuthlibProfile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [remaining, setRemaining] = useState(0);
  const [retryAfter, setRetryAfter] = useState(0);
  const active = useRef<ActiveLogin | null>(null);
  const mounted = useRef(true);
  const deadline = useRef(0);
  const callbacks = useRef({ onChanged, onOpenChange });
  callbacks.current = { onChanged, onOpenChange };

  function cancelActive() {
    const previous = active.current;
    active.current = null;
    previous?.controller.abort();
    if (previous?.sessionId) {
      void command("cancel_auth_login", { sessionId: previous.sessionId }).catch(() => {});
    }
  }

  function resetAttempt() {
    cancelActive();
    setBusy(false);
    setDevice(null);
    setProfiles([]);
    setError("");
    setNotice("");
    setPassword("");
  }

  function close() {
    resetAttempt();
    callbacks.current.onOpenChange(false);
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancelActive();
    };
  }, []);

  useEffect(() => setClientId(config.microsoftClientId || ""), [config.microsoftClientId]);
  useEffect(() => {
    if (!open) resetAttempt();
  }, [open]);

  useEffect(() => {
    if (!device) return;
    const tick = () => setRemaining(Math.max(0, Math.ceil((deadline.current - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [device]);

  function report(cause: unknown) {
    if (mounted.current) setError(accountErrorText(cause, t));
  }

  function newAttempt(): ActiveLogin {
    resetAttempt();
    const attempt = { controller: new AbortController() };
    active.current = attempt;
    setBusy(true);
    return attempt;
  }

  function isCurrent(attempt: ActiveLogin) {
    return mounted.current && active.current === attempt && !attempt.controller.signal.aborted;
  }

  async function finished(attempt: ActiveLogin) {
    if (!isCurrent(attempt)) return;
    active.current = null;
    setDevice(null);
    setProfiles([]);
    setBusy(false);
    try {
      await callbacks.current.onChanged();
      if (mounted.current) callbacks.current.onOpenChange(false);
    } catch (cause) {
      report(cause);
    }
  }

  function fail(attempt: ActiveLogin, cause: unknown) {
    if (!isCurrent(attempt)) return;
    cancelActive();
    setBusy(false);
    setDevice(null);
    setProfiles([]);
    if (!(cause instanceof DOMException && cause.name === "AbortError")) report(cause);
  }

  function changeTab(next: LoginTab) {
    if (next === tab) return;
    resetAttempt();
    setTab(next);
  }

  async function saveClientId() {
    if (!clientId.trim()) {
      report(new LauncherError("auth.clientIdRequired"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      await command("save_config", { config: { ...config, microsoftClientId: clientId.trim() } });
      await callbacks.current.onChanged();
      if (mounted.current) setNotice(t("accounts:notice.clientIdSaved"));
    } catch (cause) {
      report(cause);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function startMicrosoft() {
    if (!clientId.trim()) {
      report(new LauncherError("auth.clientIdRequired"));
      return;
    }
    const attempt = newAttempt();
    try {
      if (clientId.trim() !== config.microsoftClientId) {
        await command("save_config", { config: { ...config, microsoftClientId: clientId.trim() } });
        if (!isCurrent(attempt)) throw cancelled();
        await callbacks.current.onChanged();
      }
      const result = await command<DeviceLogin>("begin_microsoft_login");
      attempt.sessionId = result.sessionId;
      if (!isCurrent(attempt)) {
        void command("cancel_auth_login", { sessionId: result.sessionId }).catch(() => {});
        return;
      }
      deadline.current = Date.now() + result.expiresIn * 1000;
      setDevice(result);
      await waitForMicrosoftLogin(
        result,
        (sessionId) => command<DevicePoll>("poll_microsoft_login", { sessionId }),
        attempt.controller.signal,
        {
          deadline: deadline.current,
          onBackoff: (seconds) => {
            if (isCurrent(attempt)) setRetryAfter(seconds);
          },
        },
      );
      await finished(attempt);
    } catch (cause) {
      fail(attempt, cause);
    }
  }

  async function openVerification() {
    if (!device) return;
    try {
      if (desktop) await openUrl(device.verificationUri);
      else window.open(device.verificationUri, "_blank", "noopener,noreferrer");
    } catch (cause) {
      report(cause);
    }
  }

  async function addOffline() {
    if (!/^[A-Za-z0-9_]{3,16}$/.test(offlineName.trim())) {
      report(new LauncherError("auth.offlineNameInvalid"));
      return;
    }
    const attempt = newAttempt();
    try {
      await command("add_offline_account", { username: offlineName.trim() });
      await finished(attempt);
    } catch (cause) {
      fail(attempt, cause);
    }
  }

  async function loginAuthlib() {
    const attempt = newAttempt();
    const enteredPassword = password;
    setPassword("");
    try {
      const result = await command<AuthlibLogin>("login_authlib", {
        server: server.trim(),
        username: username.trim(),
        password: enteredPassword,
        profileId: null,
      });
      if (result.sessionId) attempt.sessionId = result.sessionId;
      if (!isCurrent(attempt)) {
        if (result.sessionId) void command("cancel_auth_login", { sessionId: result.sessionId }).catch(() => {});
        return;
      }
      if (result.status === "complete" && result.account) {
        await finished(attempt);
      } else if (result.status === "selectProfile" && result.sessionId && result.profiles.length) {
        setProfiles(result.profiles);
        setBusy(false);
      } else {
        throw new LauncherError("auth.invalidResponse");
      }
    } catch (cause) {
      fail(attempt, cause);
    }
  }

  async function chooseProfile(profileId: string) {
    const attempt = active.current;
    if (!attempt?.sessionId || !isCurrent(attempt)) return;
    setBusy(true);
    setError("");
    try {
      await command("select_authlib_profile", { sessionId: attempt.sessionId, profileId });
      await finished(attempt);
    } catch (cause) {
      fail(attempt, cause);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) close(); }}
      title={t("accounts:loginTitle")}
      description={t("accounts:loginDescription")}
      closeLabel={t("common:actions.close")}
      className="vx-login-dialog"
    >
      <Segmented semantic="tabs" label={t("accounts:loginMethods")} value={tab} onChange={changeTab}
        idPrefix="login-method" panelId={id => `login-panel-${id}`} activation={device ? "manual" : "automatic"}
        options={(["microsoft", "offline", "authlib"] as const).map(value => ({ value, label: t(`accounts:method.${value}`) }))} />
      {error ? <p className="vx-account-login__error" role="alert">{error}</p> : null}
      {notice ? <p className="vx-account-login__notice" role="status">{notice}</p> : null}

      {tab === "microsoft" ? (
        <div id="login-panel-microsoft" role="tabpanel" aria-labelledby="login-method-microsoft" className="vx-account-login__panel">
          {!device ? (
            <>
              <p>{t("accounts:microsoft.description")}</p>
              <label>
                {t("accounts:microsoft.clientId")}
                <input
                  aria-label={t("accounts:microsoft.clientId")}
                  value={clientId}
                  onChange={(event) => setClientId(event.target.value)}
                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                  autoComplete="off"
                  disabled={busy}
                />
              </label>
              {!config.microsoftClientId ? <p className="vx-account-login__help">{t("accounts:microsoft.clientIdHelp")}</p> : null}
              <div className="vx-action-row">
                <Button variant="secondary" disabled={busy || !clientId.trim()} onClick={() => void saveClientId()}>{t("accounts:microsoft.saveClientId")}</Button>
                <Button variant="primary" loading={busy} disabled={!clientId.trim()} onClick={() => void startMicrosoft()}>{t("accounts:microsoft.start")}</Button>
              </div>
            </>
          ) : (
            <div className="vx-account-device">
              <p>{t("accounts:microsoft.deviceInstruction")}</p>
              <strong className="vx-account-device__code">{device.userCode}</strong>
              <Button variant="primary" onClick={() => void openVerification()}>{t("accounts:microsoft.openVerification")}</Button>
              <a
                href={device.verificationUri}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => {
                  event.preventDefault();
                  void openVerification();
                }}
              >
                {device.verificationUri}
              </a>
              <p role="status">{t("accounts:microsoft.waiting", {
                minutes: Math.floor(remaining / 60),
                seconds: String(remaining % 60).padStart(2, "0"),
                interval: retryAfter || device.interval,
              })}</p>
              <Button
                variant="ghost"
                onClick={() => {
                  cancelActive();
                  setDevice(null);
                  setBusy(false);
                  setNotice(t("accounts:notice.loginCancelled"));
                }}
              >
                {t("accounts:microsoft.cancel")}
              </Button>
            </div>
          )}
        </div>
      ) : null}

      {tab === "offline" ? (
        <form
          id="login-panel-offline"
          aria-labelledby="login-method-offline"
          role="tabpanel"
          className="vx-account-login__panel"
          onSubmit={(event) => {
            event.preventDefault();
            void addOffline();
          }}
        >
          <p>{t("accounts:offline.description")}</p>
          <label>
            {t("accounts:offline.name")}
            <input
              aria-label={t("accounts:fields.playerName")}
              value={offlineName}
              onChange={(event) => setOfflineName(event.target.value)}
              placeholder={t("accounts:offline.namePlaceholder")}
              minLength={3}
              maxLength={16}
              pattern="[A-Za-z0-9_]{3,16}"
              required
              disabled={busy}
            />
          </label>
          <Button variant="primary" loading={busy} disabled={!/^[A-Za-z0-9_]{3,16}$/.test(offlineName.trim())} type="submit">
            {t("accounts:offline.submit")}
          </Button>
        </form>
      ) : null}

      {tab === "authlib" ? (
        <div id="login-panel-authlib" role="tabpanel" aria-labelledby="login-method-authlib" className="vx-account-login__panel">
          {profiles.length ? (
            <>
              <p>{t("accounts:authlib.chooseProfile")}</p>
              <div className="vx-account-profiles">
                {profiles.map((profile) => (
                  <button key={profile.id} className="vx-account-profile-choice" type="button" disabled={busy} onClick={() => void chooseProfile(profile.id)}>
                    <span><strong>{profile.name}</strong><small>{profile.id}</small></span>
                  </button>
                ))}
              </div>
              <Button variant="ghost" onClick={resetAttempt}>{t("accounts:authlib.cancelProfile")}</Button>
            </>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void loginAuthlib();
              }}
            >
              <p>{t("accounts:authlib.description")}</p>
              <label>
                {t("accounts:authlib.server")}
                <input aria-label={t("accounts:fields.authlibApiUrl")} type="url" required value={server} onChange={(event) => setServer(event.target.value)} placeholder="https://example.com/api/yggdrasil/" autoComplete="url" disabled={busy} />
              </label>
              <label>
                {t("accounts:authlib.username")}
                <input aria-label={t("accounts:fields.usernameOrEmail")} required value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" disabled={busy} />
              </label>
              <label>
                {t("accounts:authlib.password")}
                <input aria-label={t("accounts:fields.password")} type="password" required value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" disabled={busy} />
              </label>
              <Button variant="primary" loading={busy} type="submit" disabled={!server.trim() || !username.trim() || !password}>
                {t("accounts:authlib.submit")}
              </Button>
            </form>
          )}
        </div>
      ) : null}
      <p className="vx-account-login__footnote">{t("accounts:credentialNotice")}</p>
    </Dialog>
  );
}
