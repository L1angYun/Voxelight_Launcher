import { useTranslation } from "react-i18next";
import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useIsPresent } from "motion/react";
import { Button } from "../../components/ui/Button";
import { LatticeProgress } from "../../visual/lattice/LatticeProgress";
import type { Progress } from "../../lib/launcher";

export function LibraryLaunchStatus({
  busy,
  running,
  progress,
  onCancel,
}: {
  busy: string;
  running: boolean;
  progress: Progress | null;
  onCancel: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const present = useIsPresent();
  const [host, setHost] = useState<Element | null>(null);
  useLayoutEffect(() => { setHost(document.querySelector(".vx-glass-provider")); }, []);
  const preparing = busy === "game.prepare" || Boolean(progress && progress.total > progress.completed);
  if (!running && !preparing) return null;
  const percent = progress && progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : null;
  const content = (
    <div className="vx-launch-status" role="status" inert={!present} data-exiting={!present}>
      <div className="vx-launch-status__summary">
        <strong>{running ? t("home:running") : preparing ? t("home:preparing") : t("home:running")}</strong>
        {progress ? <LatticeProgress completed={progress.completed} total={progress.total} status="active" label={t("home:progress")} /> : null}
        {percent !== null ? <span>{percent}%</span> : null}
      </div>
      {!running && preparing ? <Button variant="secondary" onClick={onCancel}>{t("home:cancelPreparation")}</Button> : null}
    </div>
  );
  return host ? createPortal(content, host) : content;
}
