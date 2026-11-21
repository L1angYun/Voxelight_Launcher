import { useTranslation } from "react-i18next";
import { ExternalLink } from "../../components/ui/ExternalLink";
import packageJson from "../../../package.json";
import type { SettingsSectionProps } from "./types";
import { UpdateSettings } from "./UpdateSettings";

export function AboutSettings({ focusUpdates, onFocusHandled, ...props }: Pick<SettingsSectionProps, "config" | "onPersistedPatch" | "onError"> & {
  focusUpdates?: number;
  onFocusHandled?: () => void;
}) {
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
          <dd><ExternalLink url={packageJson.homepage}>{packageJson.homepage}</ExternalLink></dd>
        </dl>
        <p>{t("settings:about.dataNotice")}</p>
        <p>{t("settings:about.secretNotice")}</p>
      </section>
      <UpdateSettings {...props} focusRequest={focusUpdates} onFocusHandled={onFocusHandled} />
    </div>
  );
}
