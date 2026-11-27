import { useTranslation } from "react-i18next";
import { ExternalLink } from "../../components/ui/ExternalLink";

/** The official OptiFine download page; the launcher never downloads OptiFine itself. */
export const OPTIFINE_DOWNLOADS_URL = "https://optifine.net/downloads";

/** Why OptiFine is imported from a JAR, and where the user gets that JAR. */
export function OptifineManualHint() {
  const { t } = useTranslation();
  return (
    <div>
      <p className="vx-muted">{t("library:optifineHint")}</p>
      <ExternalLink url={OPTIFINE_DOWNLOADS_URL}>{t("library:optifineSite")}</ExternalLink>
    </div>
  );
}
