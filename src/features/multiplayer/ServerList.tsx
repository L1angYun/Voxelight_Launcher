import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
import { Globe, Play, Plus, Radio, RefreshCw, Search, Server, Trash2, Wifi, WifiOff } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Select } from "../../components/ui/Select";
import { EmptyState } from "../../components/ui/Feedback";
import type { useMultiplayer } from "./useMultiplayer";

function readableAddress(address: string) {
  return address.split(/([.@:])/).map((part, index) => <Fragment key={index}>{part}{/^[.@:]$/.test(part) ? <wbr /> : null}</Fragment>);
}

export function ServerList({ model }: { model: ReturnType<typeof useMultiplayer> }) {
  const { t } = useTranslation();
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [selectedAddress, setSelectedAddress] = useState("");
  const { servers, status, lan, lanSearched, busy, installedVersions, selectedVersionId, selectVersion, refreshServers, saveServer, removeServer, pingServer, discoverLan, join } = model;
  const selected = servers.find((server) => server.address === selectedAddress) ?? servers[0];
  const currentStatus = selected ? status[selected.address] : undefined;
  const state = currentStatus ? currentStatus.online ? "online" : "offline" : "unknown";
  const StatusIcon = currentStatus ? currentStatus.online ? Wifi : WifiOff : Search;
  const population = currentStatus?.online && currentStatus.playersOnline !== undefined && currentStatus.playersMax !== undefined && currentStatus.playersMax > 0
    ? { online: currentStatus.playersOnline, max: currentStatus.playersMax } : undefined;
  const cells = population ? Math.min(40, population.max) : 0;
  const occupied = population ? Math.min(cells, Math.ceil(population.online / population.max * cells)) : 0;

  async function save() {
    const result = await saveServer(name.trim(), address.trim());
    if (result !== undefined) { setFormOpen(false); setName(""); setAddress(""); }
  }

  return (
    <div className="vx-server-list-page">
      <div className="vx-multiplayer-toolbar vx-panel">
        <label>{t("multiplayer:environment")}
          <Select
            aria-label={t("multiplayer:environment")}
            value={selectedVersionId}
            onChange={(v) => selectVersion(v)}
            options={[
              { value: "", label: t("multiplayer:chooseEnvironment") },
              ...installedVersions.map((version) => ({ value: version.id, label: version.id })),
            ]}
          />
        </label>
        <div className="vx-action-row">
          <Button variant="ghost" icon={<RefreshCw size={15} />} disabled={Boolean(busy)} onClick={() => void refreshServers()}>{t("multiplayer:refresh")}</Button>
          <Button variant="primary" icon={<Plus size={15} />} aria-expanded={formOpen} onClick={() => setFormOpen((value) => !value)}>{t("multiplayer:addServer")}</Button>
        </div>
      </div>
      {!selectedVersionId ? <p className="vx-multiplayer-inline-notice">{t("multiplayer:environmentRequired")}</p> : null}
      {formOpen ? <form className="vx-server-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label>{t("multiplayer:fields.serverName")}<input aria-label={t("multiplayer:fields.serverName")} required value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>{t("multiplayer:fields.serverAddress")}<input aria-label={t("multiplayer:fields.serverAddress")} required value={address} onChange={(event) => setAddress(event.target.value)} placeholder="example.org:25565" /></label>
        <div className="vx-action-row"><Button variant="primary" type="submit" loading={busy === "save-server"} disabled={!selectedVersionId || !name.trim() || !address.trim()}>{t("multiplayer:saveServer")}</Button><Button variant="ghost" onClick={() => setFormOpen(false)}>{t("common:actions.cancel")}</Button></div>
      </form> : null}

      <div className="vx-server-browser">
        <aside className="vx-server-inventory" aria-label={t("multiplayer:tab.servers")}>
          <h2>{t("multiplayer:tab.servers")}<span>{servers.length}</span></h2>
          {servers.length ? <div className="vx-server-addresses">{servers.map((server) => <button type="button" key={server.index + ":" + server.address} aria-current={selected?.address === server.address || undefined} onClick={() => setSelectedAddress(server.address)}>
            <Server size={16} aria-hidden="true" /><span><strong title={server.name}>{server.name}</strong><small>{server.hideAddress ? t("multiplayer:hiddenAddress") : readableAddress(server.address)}</small></span><i className="vx-server-address-state" data-state={status[server.address] ? status[server.address].online ? "online" : "offline" : "unknown"} aria-hidden="true" />
          </button>)}</div> : null}
          <section className="vx-lan-section" aria-labelledby="lan-title">
            <header><h2 id="lan-title"><Radio size={16} aria-hidden="true" />{t("multiplayer:lanTitle")}</h2></header>
            <Button variant="secondary" loading={busy === "lan"} disabled={Boolean(busy)} onClick={() => void discoverLan()}>{t("multiplayer:discoverLan")}</Button>
            {lan.length ? lan.map((world) => <div className="vx-lan-row" key={world.address}><div><strong>{world.motd}</strong><small>{world.address}</small></div><Button variant="secondary" disabled={!selectedVersionId || Boolean(busy)} onClick={() => void join(world.address)}>{t("multiplayer:joinWorld")}</Button></div>) : <p>{t(lanSearched ? "multiplayer:lanEmpty" : "multiplayer:lanHint")}</p>}
          </section>
        </aside>
        <div className="vx-server-detail">
        {selected ? <article className="vx-server-row" data-server-address={selected.address} aria-label={selected.name}>
          <header className="vx-server-row__header">
            <span className="vx-server-row__icon" aria-hidden="true">{selected.icon?.startsWith("data:image/") ? <img src={selected.icon} alt="" /> : <Server size={28} strokeWidth={1.2} />}</span>
            <div className="vx-server-row__copy"><h2 title={selected.name}>{selected.name}</h2><p>{selected.hideAddress ? t("multiplayer:hiddenAddress") : readableAddress(selected.address)}</p></div>
          </header>
          <section className="vx-server-query" data-server-status={state}>
            <div className="vx-server-query__state"><StatusIcon size={18} aria-hidden="true" /><strong>{t("multiplayer:status." + state)}</strong>{currentStatus?.online && currentStatus.latencyMs !== undefined ? <span>{t("multiplayer:latency", { value: currentStatus.latencyMs })}</span> : null}</div>
            {currentStatus?.online && currentStatus.version ? <p className="vx-server-query__version">{t("library:version")} · {currentStatus.version}</p> : null}
            {currentStatus?.description ? <p className="vx-server-row__motd">{currentStatus.description.replace(/§./g, "")}</p> : null}
            {currentStatus?.online && currentStatus.playersOnline !== undefined ? <div className="vx-server-population" role="img" aria-label={t("multiplayer:players", { online: currentStatus.playersOnline, max: currentStatus.playersMax ?? "—" })}>
              {population ? <span className="vx-server-population__cells" aria-hidden="true">{Array.from({ length: cells }, (_, index) => <i key={index} data-occupied={index < occupied} />)}</span> : null}
              <span aria-hidden="true">{t("multiplayer:players", { online: currentStatus.playersOnline, max: currentStatus.playersMax ?? "—" })}</span>
            </div> : null}
          </section>
          <div className="vx-server-row__actions">
            <Button variant="ghost" icon={<Search size={15} />} loading={busy === "ping-" + selected.address} disabled={Boolean(busy)} onClick={() => void pingServer(selected.address)}>{t("multiplayer:checkStatus")}</Button>
            <Button variant="primary" icon={<Play size={14} />} disabled={!selectedVersionId || Boolean(busy)} onClick={() => void join(selected.address)}>{t("multiplayer:join")}</Button>
          </div>
          <div className="vx-server-row__management"><Button variant="ghost" icon={<Trash2 size={14} />} disabled={Boolean(busy)} onClick={() => { if (window.confirm(t("multiplayer:confirmRemove", { name: selected.name }))) void removeServer(selected.index); }}>{t("multiplayer:removeServer")}</Button></div>
        </article> : <article className="vx-server-row vx-server-row--empty"><EmptyState icon={<Globe size={28} strokeWidth={1.2} />} title={t("multiplayer:emptyServers.title")} description={t("multiplayer:emptyServers.description")} /></article>}
        </div>
      </div>
    </div>
  );
}
