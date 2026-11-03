import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Play, Plus, RefreshCw, Square } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Select } from "../../components/ui/Select";
import { EmptyState } from "../../components/ui/Feedback";
import { LoadingStatus } from "../../components/ui/LoadingStatus";
import { formatDate } from "../../i18n/format";
import { defaultServerSettings, type ServerSettings, type useMultiplayer } from "./useMultiplayer";

export function ManagedServerPanel({ model }: { model: ReturnType<typeof useMultiplayer> }) {
  const { t, i18n } = useTranslation();
  const {
    managedServers,
    selectedManagedId,
    setSelectedManagedId,
    currentManaged: current,
    logs,
    busy,
    manifest,
    refreshManaged,
    createManaged,
    updateManaged,
    setEula,
    startManaged,
    stopManaged,
    sendManagedCommand,
    report,
  } = model;
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState(t("multiplayer:defaultServerName"));
  const [versionId, setVersionId] = useState(manifest?.latestRelease ?? "");
  const [settings, setSettings] = useState<ServerSettings>({ ...defaultServerSettings });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [consoleInput, setConsoleInput] = useState("");
  const [player, setPlayer] = useState("");
  const [playerAction, setPlayerAction] = useState("whitelist add");
  const [autoScroll, setAutoScroll] = useState(true);
  const logEnd = useRef<HTMLDivElement>(null);
  const alive = Boolean(current?.pid);
  const versions = manifest?.versions.map((version) => version.id) ?? [];

  useEffect(() => {
    if (!versionId && manifest) setVersionId(manifest.latestRelease || manifest.versions[0]?.id || "");
  }, [manifest, versionId]);
  useEffect(() => {
    if (current) setSettings(current.settings);
    setConsoleInput("");
  }, [current?.id, current?.settings]);
  useEffect(() => {
    if (autoScroll) logEnd.current?.scrollIntoView?.({ block: "nearest" });
  }, [logs, autoScroll]);

  async function create() {
    const result = await createManaged(name, versionId);
    if (result !== undefined) setCreating(false);
  }

  async function send(value: string, clear: () => void) {
    const result = await sendManagedCommand(value);
    if (result !== undefined) clear();
  }

  return (
    <div className="vx-managed-servers">
      <div className="vx-multiplayer-toolbar">
        <p>{t("multiplayer:managedDescription")}</p>
        <div className="vx-action-row">
          <Button variant="ghost" icon={<RefreshCw size={15} />} disabled={Boolean(busy)} onClick={() => void refreshManaged()}>{t("multiplayer:refresh")}</Button>
          {managedServers.length > 0 || creating ? <Button variant="primary" icon={<Plus size={15} />} disabled={Boolean(busy)} onClick={() => setCreating((value) => !value)}>{t("multiplayer:createServer")}</Button> : null}
        </div>
      </div>
      <LoadingStatus active={Boolean(busy)}>{t("multiplayer:managedBusy")}</LoadingStatus>

      {creating ? (
        <form
          className="vx-managed-create"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <h2>{t("multiplayer:createTitle")}</h2>
          <label>
            {t("multiplayer:fields.serverName")}
            <input aria-label={t("multiplayer:fields.serverName")} value={name} maxLength={80} required onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            {t("multiplayer:serverVersion")}
            {versions.length ? (
              <Select aria-label={t("multiplayer:serverVersion")} value={versionId} onChange={setVersionId}
                options={versions.map((value) => ({ value, label: value }))} />
            ) : <input aria-label={t("multiplayer:serverVersion")} value={versionId} required onChange={(event) => setVersionId(event.target.value)} />}
          </label>
          <p>{t("multiplayer:createNotice")}</p>
          <div className="vx-action-row">
            <Button variant="primary" type="submit" loading={busy === "create-managed"} disabled={!name.trim() || !versionId}>{t("multiplayer:installServer")}</Button>
            <Button variant="ghost" onClick={() => setCreating(false)}>{t("common:actions.cancel")}</Button>
          </div>
        </form>
      ) : null}

      <div className="vx-managed-layout">
        <aside className="vx-managed-list" aria-label={t("multiplayer:managedList")}>
          {managedServers.length ? managedServers.map((server) => (
            <button type="button" key={server.id} aria-pressed={selectedManagedId === server.id} onClick={() => setSelectedManagedId(server.id)}>
              <strong>{server.name}</strong>
              <span>{server.versionId} · :{server.settings.port}</span>
              <small>{t(`multiplayer:managedStatus.${server.status}`, { defaultValue: t("multiplayer:managedStatus.unknown") })}</small>
            </button>
          )) : <p>{t("multiplayer:noManaged")}</p>}
        </aside>

        {current ? (
          <div className="vx-managed-detail">
            <section className="vx-managed-overview">
              <header>
                <div>
                  <h2>{current.name}</h2>
                  <p>Vanilla {current.versionId} · Java {current.javaMajor ?? t("multiplayer:javaAuto")}{current.pid ? ` · PID ${current.pid}` : ""}</p>
                </div>
                <strong>{t(`multiplayer:managedStatus.${current.status}`, { defaultValue: t("multiplayer:managedStatus.unknown") })}</strong>
              </header>
              <p className="vx-managed-directory">{current.directory}</p>
              {current.error ? <p className="vx-managed-error" role="alert">{t("multiplayer:errors.processFailed")}</p> : null}
              <label className="vx-managed-checkbox">
                <input
                  type="checkbox"
                  aria-label={t("multiplayer:eula.accept")}
                  checked={current.eulaAccepted}
                  disabled={Boolean(busy) || alive}
                  onChange={(event) => void setEula(event.target.checked)}
                />
                <span>{t("multiplayer:eula.consent")} <a href={current.eulaUrl} onClick={(event) => { event.preventDefault(); void openUrl(current.eulaUrl).catch(report); }}>Minecraft EULA</a></span>
              </label>
              <div className="vx-action-row">
                <Button variant="primary" icon={<Play size={14} />} disabled={Boolean(busy) || alive || !current.eulaAccepted} onClick={() => void startManaged()}>
                  {current.installed ? t("multiplayer:startServer") : t("multiplayer:installAndStart")}
                </Button>
                <Button variant="secondary" icon={<Square size={14} />} disabled={Boolean(busy) || !alive || current.status === "stopping"} onClick={() => void stopManaged(false)}>{t("multiplayer:saveAndStop")}</Button>
                <Button variant="ghost" disabled={Boolean(busy) || !alive} onClick={() => void stopManaged(true)}>{t("multiplayer:forceStop")}</Button>
              </div>
            </section>

            <section className="vx-managed-settings">
              <Button variant="ghost" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((value) => !value)}>{t("multiplayer:serverSettings")}</Button>
              {settingsOpen ? (
                <div className="vx-managed-settings__body">
                  <div className="vx-managed-fields">
                    <label>{t("multiplayer:fields.port")}<input aria-label={t("multiplayer:fields.port")} type="number" min={1} max={65535} value={settings.port} disabled={alive || Boolean(busy)} onChange={(event) => setSettings({ ...settings, port: Number(event.target.value) })} /></label>
                    <label>{t("multiplayer:fields.maxPlayers")}<input aria-label={t("multiplayer:fields.maxPlayers")} type="number" min={1} max={10000} value={settings.maxPlayers} disabled={alive || Boolean(busy)} onChange={(event) => setSettings({ ...settings, maxPlayers: Number(event.target.value) })} /></label>
                    <label>{t("multiplayer:fields.maxMemory")}<input aria-label={t("multiplayer:fields.maxMemory")} type="number" min={512} max={65536} step={512} value={settings.maxMemoryMb} disabled={alive || Boolean(busy)} onChange={(event) => setSettings({ ...settings, maxMemoryMb: Number(event.target.value) })} /></label>
                    <label>{t("multiplayer:fields.viewDistance")}<input aria-label={t("multiplayer:fields.viewDistance")} type="number" min={2} max={32} value={settings.viewDistance} disabled={alive || Boolean(busy)} onChange={(event) => setSettings({ ...settings, viewDistance: Number(event.target.value) })} /></label>
                    <label>{t("multiplayer:fields.gamemode")}<Select aria-label={t("multiplayer:fields.gamemode")} value={settings.gamemode} disabled={alive || Boolean(busy)} onChange={(gamemode) => setSettings({ ...settings, gamemode })} options={["survival", "creative", "adventure", "spectator"].map((value) => ({ value, label: t(`multiplayer:gamemode.${value}`) }))} /></label>
                    <label>{t("multiplayer:fields.difficulty")}<Select aria-label={t("multiplayer:fields.difficulty")} value={settings.difficulty} disabled={alive || Boolean(busy)} onChange={(difficulty) => setSettings({ ...settings, difficulty })} options={["peaceful", "easy", "normal", "hard"].map((value) => ({ value, label: t(`multiplayer:difficulty.${value}`) }))} /></label>
                    <label>{t("multiplayer:fields.bindAddress")}<input aria-label={t("multiplayer:fields.bindAddress")} value={settings.bindAddress} disabled={alive || Boolean(busy)} onChange={(event) => setSettings({ ...settings, bindAddress: event.target.value })} placeholder="127.0.0.1" /></label>
                    <label>{t("multiplayer:fields.motd")}<input aria-label={t("multiplayer:fields.motd")} value={settings.motd} maxLength={256} disabled={alive || Boolean(busy)} onChange={(event) => setSettings({ ...settings, motd: event.target.value })} /></label>
                    <label className="vx-managed-checkbox"><input type="checkbox" checked={settings.onlineMode} disabled={alive || Boolean(busy)} onChange={(event) => setSettings({ ...settings, onlineMode: event.target.checked })} />{t("multiplayer:fields.onlineMode")}</label>
                    <label className="vx-managed-checkbox"><input type="checkbox" checked={settings.whitelist} disabled={alive || Boolean(busy)} onChange={(event) => setSettings({ ...settings, whitelist: event.target.checked })} />{t("multiplayer:fields.whitelist")}</label>
                  </div>
                  <Button variant="primary" disabled={Boolean(busy) || alive} onClick={() => void updateManaged(settings)}>{t("multiplayer:saveSettings")}</Button>
                  {alive ? <p>{t("multiplayer:settingsWhileRunning")}</p> : null}
                </div>
              ) : null}
            </section>

            <section className="vx-managed-console">
              <header>
                <h2>{t("multiplayer:console")}</h2>
                <label className="vx-managed-checkbox"><input type="checkbox" checked={autoScroll} onChange={(event) => setAutoScroll(event.target.checked)} />{t("multiplayer:autoScroll")}</label>
              </header>
              <div className="vx-managed-log" role="log" aria-label={t("multiplayer:consoleLog")}>
                {logs.map((log, index) => (
                  <div className={log.stream === "stderr" ? "stderr" : log.stream === "command" ? "command" : ""} key={`${log.timestamp}-${index}`}>
                    <time dateTime={log.timestamp}>{formatDate(log.timestamp, i18n.language, { dateStyle: undefined, timeStyle: "medium", timeZone: "UTC" })}</time> {log.message}
                  </div>
                ))}
                <div ref={logEnd} />
              </div>
              <form
                className="vx-managed-command"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (consoleInput.trim()) void send(consoleInput, () => setConsoleInput(""));
                }}
              >
                <input aria-label={t("multiplayer:consoleCommand")} value={consoleInput} onChange={(event) => setConsoleInput(event.target.value)} disabled={!alive || Boolean(busy)} maxLength={2048} placeholder={t("multiplayer:consolePlaceholder")} />
                <Button variant="primary" type="submit" disabled={!alive || Boolean(busy) || !consoleInput.trim()}>{t("multiplayer:sendCommand")}</Button>
              </form>
              <div className="vx-managed-player">
                <Select className="vx-managed-player__action" aria-label={t("multiplayer:playerAction")} value={playerAction} onChange={setPlayerAction} disabled={!alive || Boolean(busy)}
                  options={["whitelist add", "whitelist remove", "op", "deop", "ban", "pardon"].map((value) => ({ value, label: t(`multiplayer:playerActions.${value}`) }))} />
                <input aria-label={t("multiplayer:playerName")} value={player} onChange={(event) => setPlayer(event.target.value)} disabled={!alive || Boolean(busy)} maxLength={16} />
                <Button variant="secondary" disabled={!alive || Boolean(busy) || !/^[A-Za-z0-9_]{3,16}$/.test(player)} onClick={() => void send(`${playerAction} ${player}`, () => setPlayer(""))}>{t("multiplayer:managePlayer")}</Button>
              </div>
            </section>
          </div>
        ) : (
          <EmptyState
            title={t("multiplayer:emptyManaged.title")}
            description={t("multiplayer:emptyManaged.description")}
            action={!creating ? <Button variant="primary" onClick={() => setCreating(true)}>{t("multiplayer:createServer")}</Button> : undefined}
          />
        )}
      </div>
    </div>
  );
}
