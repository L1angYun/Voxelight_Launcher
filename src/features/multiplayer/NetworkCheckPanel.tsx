import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Activity, Check, Copy, Globe, Info, ShieldAlert, ShieldCheck, Sparkles, Wifi } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/Feedback";
import { formatDate } from "../../i18n/format";
import { useLumen } from "../assistant/LumenContext";
import type { useMultiplayer } from "./useMultiplayer";

function formatDirectAddress(ip: string, port: number, ipv6: boolean): string {
  return ipv6 ? `[${ip}]:${port}` : `${ip}:${port}`;
}

export function NetworkCheckPanel({ model }: { model: ReturnType<typeof useMultiplayer> }) {
  const { t, i18n } = useTranslation();
  const lumen = useLumen();
  const { networkReport: report, networkBusy, runNetworkCheck, currentManaged } = model;
  const [portInput, setPortInput] = useState(() => String(currentManaged?.settings.port ?? 25565));
  const [copiedTarget, setCopiedTarget] = useState<string>("");
  const needsNatHelp = Boolean(
    report && (report.cgnatSuspected || report.natType === "addressPortDependent" || report.natType === "unreachable"),
  );

  const parsedPort = Number(portInput);
  const validPort = Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535 ? parsedPort : 25565;

  const directV6 = report?.directConnectIpv6 && report.ipv6.publicIp
    ? formatDirectAddress(report.ipv6.publicIp, validPort, true)
    : null;
  const directV4 = report?.directConnectIpv4 && report.ipv4.publicIp
    ? formatDirectAddress(report.ipv4.publicIp, validPort, false)
    : null;

  async function copyAddress(key: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedTarget(key);
    } catch {
      setCopiedTarget("");
    }
  }

  return (
    <div className="vx-network-check">
      <div className="vx-multiplayer-toolbar vx-panel">
        <p>{t("multiplayer:network.description")}</p>
        <div className="vx-action-row">
          <Button
            variant="primary"
            icon={<Activity size={15} />}
            loading={networkBusy}
            disabled={networkBusy}
            onClick={() => void runNetworkCheck()}
          >
            {report ? t("multiplayer:network.rerunCheck") : t("multiplayer:network.runCheck")}
          </Button>
          {lumen.configured && needsNatHelp && report ? (
            <Button
              variant="ghost"
              icon={<Sparkles size={14} />}
              onClick={() => lumen.openLumen({
                reason: t("shell:assistant.wake.networkReason"),
                prompt: t("shell:assistant.wake.networkPrompt", { natType: report.natType }),
                autoSend: true,
              })}
            >
              {t("shell:assistant.wake.askNetwork")}
            </Button>
          ) : null}
        </div>
      </div>

      {!report ? (
        <section className="vx-network-empty">
          <EmptyState
            icon={<Wifi size={36} strokeWidth={1.3} />}
            title={t("multiplayer:network.emptyTitle")}
            description={t("multiplayer:network.emptyDescription")}
          />
          <p className="vx-network-privacy">{t("multiplayer:network.privacyNote")}</p>
        </section>
      ) : (
        <div className="vx-network-results">
          <div className="vx-network-grid">
            <article className="vx-network-card" data-tone={report.ipv4.available ? "good" : "warn"}>
              <header>
                <h3><Globe size={16} aria-hidden="true" />{t("multiplayer:network.ipv4Title")}</h3>
                <span className="vx-network-badge" data-tone={report.ipv4.available ? "good" : "warn"}>
                  {report.ipv4.available ? t("multiplayer:network.available") : t("multiplayer:network.unavailable")}
                </span>
              </header>
              <dl className="vx-network-kv">
                <div>
                  <dt>{t("multiplayer:network.publicIp")}</dt>
                  <dd className="vx-mono">{report.ipv4.publicIp ?? t("multiplayer:network.none")}</dd>
                </div>
                <div>
                  <dt>{t("multiplayer:network.localIp")}</dt>
                  <dd className="vx-mono">{report.ipv4.localIp ?? t("multiplayer:network.none")}</dd>
                </div>
                <div>
                  <dt>{t("multiplayer:network.mappedPort")}</dt>
                  <dd className="vx-mono">
                    {report.ipv4.mappedPort != null
                      ? report.ipv4.localPort != null && report.ipv4.localPort !== report.ipv4.mappedPort
                        ? `${report.ipv4.localPort} → ${report.ipv4.mappedPort}`
                        : String(report.ipv4.mappedPort)
                      : t("multiplayer:network.none")}
                  </dd>
                </div>
                {report.ipv4.rttMs != null ? (
                  <div>
                    <dt>{t("multiplayer:network.latency")}</dt>
                    <dd className="vx-mono">{t("multiplayer:latency", { value: report.ipv4.rttMs })}</dd>
                  </div>
                ) : null}
              </dl>
            </article>

            <article
              className="vx-network-card"
              data-tone={report.ipv6.status === "globalPublic" ? "good" : report.ipv6.status === "behindNat6" ? "info" : "neutral"}
            >
              <header>
                <h3><Globe size={16} aria-hidden="true" />{t("multiplayer:network.ipv6Title")}</h3>
                <span
                  className="vx-network-badge"
                  data-tone={report.ipv6.status === "globalPublic" ? "good" : report.ipv6.status === "behindNat6" ? "info" : "neutral"}
                >
                  {t(`multiplayer:network.ipv6Status.${report.ipv6.status}`)}
                </span>
              </header>
              <dl className="vx-network-kv">
                <div>
                  <dt>{t("multiplayer:network.publicIp")}</dt>
                  <dd className="vx-mono">{report.ipv6.publicIp ?? t("multiplayer:network.none")}</dd>
                </div>
                <div>
                  <dt>{t("multiplayer:network.localIp")}</dt>
                  <dd className="vx-mono">{report.ipv6.localIp ?? t("multiplayer:network.none")}</dd>
                </div>
                {report.ipv6.rttMs != null ? (
                  <div>
                    <dt>{t("multiplayer:network.latency")}</dt>
                    <dd className="vx-mono">{t("multiplayer:latency", { value: report.ipv6.rttMs })}</dd>
                  </div>
                ) : null}
              </dl>
            </article>

            <article
              className="vx-network-card"
              data-tone={
                report.natType === "openInternet"
                  ? "good"
                  : report.natType === "addressPortDependent" || report.natType === "unreachable"
                    ? "warn"
                    : "info"
              }
            >
              <header>
                <h3><Activity size={16} aria-hidden="true" />{t("multiplayer:network.natTitle")}</h3>
                <span
                  className="vx-network-badge"
                  data-tone={
                    report.natType === "openInternet"
                      ? "good"
                      : report.natType === "addressPortDependent" || report.natType === "unreachable"
                        ? "warn"
                        : "info"
                  }
                >
                  {t(`multiplayer:network.natType.${report.natType}`)}
                </span>
              </header>
              <p className="vx-network-nat-summary">{t(`multiplayer:network.natSummary.${report.natType}`)}</p>
              {report.cgnatSuspected ? (
                <p className="vx-network-cgnat-note">{t("multiplayer:network.cgnatBadge")}</p>
              ) : null}
            </article>
          </div>

          {(directV6 || directV4) ? (
            <section className="vx-network-section" aria-labelledby="network-direct-title">
              <header className="vx-network-section__header">
                <h2 id="network-direct-title">{t("multiplayer:network.directTitle")}</h2>
                <label className="vx-network-port-field">
                  <span>{t("multiplayer:fields.port")}</span>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    aria-label={t("multiplayer:network.directPort")}
                    value={portInput}
                    onChange={(event) => {
                      setPortInput(event.target.value);
                      setCopiedTarget("");
                    }}
                  />
                </label>
              </header>
              <div className="vx-network-addresses">
                {directV6 ? (
                  <div className="vx-network-address-row">
                    <div>
                      <strong>{t("multiplayer:network.directIpv6Label")}</strong>
                      <code className="vx-mono">{directV6}</code>
                    </div>
                    <Button
                      variant="secondary"
                      icon={copiedTarget === "v6" ? <Check size={14} /> : <Copy size={14} />}
                      onClick={() => void copyAddress("v6", directV6)}
                    >
                      {copiedTarget === "v6" ? t("multiplayer:network.copied") : t("multiplayer:network.copyAddress")}
                    </Button>
                  </div>
                ) : null}
                {directV4 ? (
                  <div className="vx-network-address-row">
                    <div>
                      <strong>{t("multiplayer:network.directIpv4Label")}</strong>
                      <code className="vx-mono">{directV4}</code>
                    </div>
                    <Button
                      variant="secondary"
                      icon={copiedTarget === "v4" ? <Check size={14} /> : <Copy size={14} />}
                      onClick={() => void copyAddress("v4", directV4)}
                    >
                      {copiedTarget === "v4" ? t("multiplayer:network.copied") : t("multiplayer:network.copyAddress")}
                    </Button>
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}

          <section className="vx-network-section" aria-labelledby="network-advice-title">
            <h2 id="network-advice-title">{t("multiplayer:network.adviceTitle")}</h2>
            <ul className="vx-network-advice">
              {report.advice.map((item) => {
                const Icon = item.severity === "good" ? ShieldCheck : item.severity === "warn" ? ShieldAlert : Info;
                return (
                  <li key={item.code} data-severity={item.severity}>
                    <Icon size={16} aria-hidden="true" />
                    <span>{t(`multiplayer:network.advice.${item.code}`)}</span>
                  </li>
                );
              })}
            </ul>
          </section>

          <footer className="vx-network-footer">
            <span>{t("multiplayer:network.stunHosts", { hosts: report.stunHostsQueried.join(", ") })}</span>
            <span>{t("multiplayer:network.checkedAt", { time: formatDate(report.checkedAt, i18n.language) })}</span>
          </footer>
        </div>
      )}
    </div>
  );
}
