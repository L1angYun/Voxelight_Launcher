import { useTranslation } from "react-i18next";
import { ExternalLink } from "../../components/ui/ExternalLink";
import type { SettingsSectionProps } from "./types";
import { Select } from "../../components/ui/Select";

export function DownloadSettings({ config, onChange, onError }: SettingsSectionProps) {
  const { t } = useTranslation();
  return (
    <div className="vx-settings-section">
      <header><h2>{t("settings:section.downloads")}</h2><p>{t("settings:downloadDescription")}</p></header>
      <section className="vx-settings-group">
        <label>
          {t("settings:fields.downloadSource")}
          <Select aria-label={t("settings:fields.downloadSource")} value={config.downloadSource}
            onChange={(downloadSource) => onChange({ ...config, downloadSource })}
            options={["official", "auto", "bmclapi"].map((value) => ({ value, label: t(`settings:downloadSource.${value}`) }))} />
        </label>
        <p>{t(`settings:downloadSource.${config.downloadSource}Description`)}</p>
        {config.downloadSource !== "official" ? (
          <p>
            {t("settings:downloadSource.mirrorNotice")}{" "}
            <ExternalLink url="https://bmclapi2.bangbang93.com/">{t("settings:downloadSource.mirrorLink")}</ExternalLink>
          </p>
        ) : null}
        <div className="vx-settings-fields">
          <label>
            {t("settings:fields.downloadConcurrency")}
            <input aria-label={t("settings:fields.downloadConcurrency")} type="number" min={1} max={16} value={config.downloadConcurrency} onChange={(event) => onChange({ ...config, downloadConcurrency: Number(event.target.value) })} />
          </label>
          <label>
            {t("settings:fields.downloadLimit")}
            <input aria-label={t("settings:fields.downloadLimit")} type="number" min={0} max={1048576} value={config.downloadLimitKib} onChange={(event) => onChange({ ...config, downloadLimitKib: Number(event.target.value) })} />
          </label>
        </div>
        <p>{t("settings:downloadSource.scopeNotice")}</p>
      </section>
    </div>
  );
}
