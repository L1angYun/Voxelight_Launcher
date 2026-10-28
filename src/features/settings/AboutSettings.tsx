import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import packageJson from "../../../package.json";
import type { SettingsSectionProps } from "./types";

export function AboutSettings({ onError }: Pick<SettingsSectionProps, "onError">) {
  const { t } = useTranslation();
  return (
    <div className="vx-settings-section">
      <header><h2>{t("settings:section.about")}</h2><p>{t("settings:aboutDescription")}</p></header>
      <section className="vx-settings-group vx-settings-about">
        <h3>{packageJson.name === "voxelight-launcher" ? "Voxelight" : packageJson.name}</h3>
        <dl>
          <dt>{t("settings:about.version")}</dt><dd>{packageJson.version}</dd>
          <dt>{t("settings:about.license")}</dt><dd>{packageJson.license}</dd>
          <dt>{t("settings:about.typeface")}</dt><dd>{t("settings:about.typefaceCredit")}</dd>
          <dt>{t("settings:about.source")}</dt>
          <dd><a href={packageJson.homepage} onClick={(event) => { event.preventDefault(); void openUrl(packageJson.homepage).catch(onError); }}>{packageJson.homepage}</a></dd>
        </dl>
        <p>{t("settings:about.dataNotice")}</p>
        <p>{t("settings:about.secretNotice")}</p>
      </section>
    </div>
  );
}
