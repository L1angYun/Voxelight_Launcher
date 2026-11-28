import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Activity, Check, Copy, Globe, Info, ShieldAlert, ShieldCheck, Wifi } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/Feedback";
import { ICON } from "../../design/icons";
import { formatDate } from "../../i18n/format";
import { LumenHelpButton } from "../assistant/LumenHelpButton";
import type { useMultiplayer } from "./useMultiplayer";

function formatDirectAddress(ip: string, port: number, ipv6: boolean): string {
  return ipv6 ? `[${ip}]:${port}` : `${ip}:${port}`;
}

export function NetworkCheckPanel({ model }: { model: ReturnType<typeof useMultiplayer> }) {
  const { t, i18n } = useTranslation();
  const labelSeparator = /^(?:zh|ja)/i.test(i18n.language) ? "：" : ": ";
  const { networkReport: report, networkBusy, runNetworkCheck, currentManaged } = model;
  const managedPort = currentManaged?.settings.port;
  const [portInput, setPortInput] = useState(() => String(managedPort ?? 25565));
  const [copiedTarget, setCopiedTarget] = useState<string>("");
  const needsNatHelp = Boolean(
    report &&
      (report.cgnatSuspected ||
        report.natType === "addressPortDependent" ||
        report.natType === "unreachable" ||
        report.natType === "proxied"),
  );

  useEffect(() => {
    if (managedPort != null) {
      setPortInput(String(managedPort));
      setCopiedTarget("");
    }
  }, [managedPort]);

  const parsedPort = Number(portInput.trim());
  const portValid = portInput.trim().length > 0 && Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535;
  const effectivePort = portValid ? parsedPort : 25565;

  const directV6 = report?.directConnectIpv6 && report.ipv6.publicIp
    ? formatDirectAddress(report.ipv6.publicIp, effectivePort, true)
    : null;
  const directV4 = report?.directConnectIpv4 && report.ipv4.publicIp
    ? formatDirectAddress(report.ipv4.publicIp, effectivePort, false)
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
      {report ? (
        <div className="vx-multiplayer-toolbar vx-panel">
          <p>{t("multiplayer:network.description")}</p>
          <div className="vx-action-row">
            <Button
              variant="primary"
              icon={<Activity />}
              loading={networkBusy}
              disabled={networkBusy}
              onClick={() => void runNetworkCheck()}
            >
              {t("multiplayer:network.rerunCheck")}
            </Button>
            <LumenHelpButton
              when={Boolean(needsNatHelp && report)}
              label={t("shell:assistant.wake.askNetwork")}
              reason={t("shell:assistant.wake.networkReason")}
              prompt={t("shell:assistant.wake.networkPrompt", { natType: report?.natType ?? "unknown" })}
            />
          </div>
        </div>
      ) : null}

      {!report ? (
        <div className="vx-network-empty">
          <EmptyState
            variant="panel"
            icon={<Wifi size={ICON.xl} />}
            title={t("multiplayer:network.emptyTitle")}
            description={t("multiplayer:network.emptyDescription")}
            action={
              <Button
                variant="primary"
                icon={<Activity />}
                loading={networkBusy}
                disabled={networkBusy}
                onClick={() => void runNetworkCheck()}
              >
                {t("multiplayer:network.runCheck")}
              </Button>
            }
          />
          <p className="vx-network-privacy">{t("multiplayer:network.privacyNote")}</p>
        </div>
      ) : (
        <div className="vx-network-results">
          <div
            className="vx-network-verdict"
            data-tone={
              report.natType === "openInternet"
                ? "good"
                : report.natType === "addressPortDependent" ||
                    report.natType === "unreachable" ||
                    report.natType === "proxied"
                  ? "warn"
                  : "info"
            }
          >
            <span className="vx-network-verdict__tag">
              {t("multiplayer:network.natTitle")}{labelSeparator}{t(`multiplayer:network.natType.${report.natType}`)}
            </span>
            <p>{t(`multiplayer:network.natSummary.${report.natType}`)}</p>
          </div>
          <div className="vx-network-grid">
            <article className="vx-network-card" data-tone={report.ipv4.available ? "good" : "warn"}>
              <header>
                <h3><Globe size={ICON.md} aria-hidden="true" />{t("multiplayer:network.ipv4Title")}</h3>
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
                <h3><Globe size={ICON.md} aria-hidden="true" />{t("multiplayer:network.ipv6Title")}</h3>
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
                  : report.natType === "addressPortDependent" ||
                      report.natType === "unreachable" ||
                      report.natType === "proxied"
                    ? "warn"
                    : "info"
              }
            >
              <header>
                <h3><Activity size={ICON.md} aria-hidden="true" />{t("multiplayer:network.natTitle")}</h3>
                <span
                  className="vx-network-badge"
                  data-tone={
                    report.natType === "openInternet"
                      ? "good"
                      : report.natType === "addressPortDependent" ||
                          report.natType === "unreachable" ||
                          report.natType === "proxied"
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
                    aria-invalid={!portValid}
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
                      disabled={!portValid}
                      icon={copiedTarget === "v6" ? <Check size={ICON.sm} /> : <Copy size={ICON.sm} />}
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
                      disabled={!portValid}
                      icon={copiedTarget === "v4" ? <Check size={ICON.sm} /> : <Copy size={ICON.sm} />}
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
                    <Icon size={ICON.md} aria-hidden="true" />
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
