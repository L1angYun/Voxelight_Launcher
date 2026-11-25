import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "../../components/ui/ExternalLink";
import type { SettingsSectionProps } from "./types";
import { Select } from "../../components/ui/Select";

import { ProxySettings } from "./ProxySettings";
import { command, type Config } from "../../lib/launcher";

/** The session's reachability verdict for the saved "auto" source (read-only). */
export type SourceVerdict = {
  preferred: "official" | "mirror";
  officialMs: number | null;
  mirrorMs: number | null;
  conclusive: boolean;
};

function useSourceVerdict(active: boolean) {
  const [verdict, setVerdict] = useState<SourceVerdict | null>(null);
  useEffect(() => {
    if (!active) return;
    let current = true;
    command<SourceVerdict | null>("get_download_source_verdict")
      .then((value) => { if (current) setVerdict(value); })
      .catch(() => { if (current) setVerdict(null); });
    return () => { current = false; };
  }, [active]);
  return active ? verdict : null;
}

export function DownloadSettings({ savedConfig, ...props }: SettingsSectionProps & { savedConfig: Config }) {
  const { t } = useTranslation();
  const { config, onChange } = props;
  // The verdict belongs to the saved choice; an unsaved switch to auto has none yet.
  const auto = savedConfig.downloadSource === "auto" && config.downloadSource === "auto";
  const verdict = useSourceVerdict(auto);
  const latency = (ms: number | null) =>
    ms === null ? t("settings:downloadSource.verdictUnreachable") : t("settings:downloadSource.verdictMs", { ms });
  return (
    <div className="vx-settings-section">
      <header><h2>{t("settings:section.downloads")}</h2><p>{t("settings:downloadDescription")}</p></header>
      <section className="vx-settings-group">
        <label data-settings-target="downloads-source">
          {t("settings:fields.downloadSource")}
          <Select aria-label={t("settings:fields.downloadSource")} value={config.downloadSource}
            onChange={(downloadSource) => onChange({ ...config, downloadSource })}
            options={["official", "auto", "bmclapi"].map((value) => ({ value, label: t(`settings:downloadSource.${value}`) }))} />
        </label>
        <p>{t(`settings:downloadSource.${config.downloadSource}Description`)}</p>
        {auto ? (
          <p data-testid="download-source-verdict">
            {!verdict
              ? t("settings:downloadSource.verdictPending")
              : !verdict.conclusive
                ? t("settings:downloadSource.verdictInconclusive")
                : t(verdict.preferred === "mirror" ? "settings:downloadSource.verdictMirror" : "settings:downloadSource.verdictOfficial", {
                  official: latency(verdict.officialMs),
                  mirror: latency(verdict.mirrorMs),
                })}
          </p>
        ) : null}
        {config.downloadSource !== "official" ? (
          <p>
            {t("settings:downloadSource.mirrorNotice")}{" "}
            <ExternalLink url="https://bmclapi2.bangbang93.com/">{t("settings:downloadSource.mirrorLink")}</ExternalLink>
          </p>
        ) : null}
        <div className="vx-settings-fields">
          <label data-settings-target="downloads-concurrency">
            {t("settings:fields.downloadConcurrency")}
            <input aria-label={t("settings:fields.downloadConcurrency")} type="number" min={1} max={16} value={config.downloadConcurrency} onChange={(event) => onChange({ ...config, downloadConcurrency: Number(event.target.value) })} />
          </label>
          <label data-settings-target="downloads-limit">
            {t("settings:fields.downloadLimit")}
            <input aria-label={t("settings:fields.downloadLimit")} type="number" min={0} max={1048576} value={config.downloadLimitKib} onChange={(event) => onChange({ ...config, downloadLimitKib: Number(event.target.value) })} />
          </label>
        </div>
        <p>{t("settings:downloadSource.scopeNotice")}</p>
      </section>
      <ProxySettings {...props} savedConfig={savedConfig} />
    </div>
  );
}
