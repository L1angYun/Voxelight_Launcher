import { useTranslation } from "react-i18next";
import type { Bootstrap } from "../lib/launcher";

export function StorageRecoveryNotice({ storage }: { storage: NonNullable<Bootstrap["storage"]> }) {
  const { t } = useTranslation();
  const recovery = storage.recovery;
  if (!recovery) return null;
  return (
    <aside className="vx-bootstrap-error vx-panel" role="alert">
      <strong>{t("shell:storage.fallbackTitle")}</strong>
      <p>{t(`shell:storage.reason.${recovery.reason}`)}</p>
      <p className="vx-path">{t("shell:storage.activeDirectory", { path: storage.activeDirectory })}</p>
      {recovery.primaryStatePath ? <p className="vx-path">{t(
        recovery.primaryStateRetained ? "shell:storage.primaryRetained" : "shell:storage.primaryState",
        { path: recovery.primaryStatePath },
      )}</p> : recovery.primaryDirectory ? (
        <p className="vx-path">{t("shell:storage.primaryDirectory", { path: recovery.primaryDirectory })}</p>
      ) : null}
      <p>{t("shell:storage.recoveryHelp")}</p>
    </aside>
  );
}
