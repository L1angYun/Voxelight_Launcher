import { ChevronDown, FolderOpen, LoaderCircle, Play, Square, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Instance, InstalledVersion, Progress } from "../../lib/launcher";
import { Button, IconButton } from "../../components/ui/Button";
import { GlassSurface } from "../../visual/glass/GlassSystem";
import { LatticeProgress } from "../../visual/lattice/LatticeProgress";
import { useAppearance } from "../../app/AppearanceProvider";
import { useJellyControl } from "./useJellyControl";

export function LaunchConsole({
  instance, instances, onSelectInstance, onLaunch, onStop, onCancel, onOpenFolder, busy, running, progress,
}: {
  instance?: Instance;
  instances: Instance[];
  version?: InstalledVersion;
  onSelectInstance: (id?: string) => void;
  onLaunch: () => Promise<void>;
  onStop: () => Promise<void>;
  onCancel: () => Promise<void>;
  onOpenFolder: () => void;
  busy: string;
  running: boolean;
  progress: Progress | null;
}) {
  const { t, i18n } = useTranslation();
  const { effects, reducedMotion } = useAppearance();
  const staticMotion = reducedMotion || effects === "lite";
  const selectorJelly = useJellyControl<HTMLDivElement>(staticMotion);
  const launchJelly = useJellyControl<HTMLDivElement>(staticMotion);
  const preparing = busy === "game.prepare";
  const percent = progress && progress.total > 0
    ? Math.max(0, Math.min(1, progress.completed / progress.total)) : null;
  const number = new Intl.NumberFormat(i18n.resolvedLanguage);
  const stageKey = progress?.stage ?? "queued";
  const stage = i18n.exists(`home:stages.${stageKey}`) ? t(`home:stages.${stageKey}`) : t("home:preparing");
  return (
    <div className="vx-launch-console" data-state={running ? "running" : preparing ? "preparing" : "idle"}>
      <div className="vx-launch-console__context">
        <label htmlFor="home-instance">{t("home:instance")}</label>
        <div className="vx-launch-console__instance">
          <div ref={selectorJelly.ref} className="vx-jelly-control vx-launch-console__selector-wrap" {...selectorJelly.handlers}>
            <GlassSurface variant="control" className="vx-launch-console__selector">
              <select id="home-instance" className="vx-launch-console__select"
                aria-label={t("home:instance")} value={instance?.id ?? ""}
                onChange={(event) => onSelectInstance(event.target.value || undefined)}>
                <option value="">{t("home:versionDirectory")}</option>
                {instances.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
              <ChevronDown size={16} aria-hidden="true" />
            </GlassSurface>
          </div>
          <IconButton label={t("home:openFolder")} icon={<FolderOpen size={18} />} onClick={onOpenFolder} />
        </div>
      </div>
      {preparing ? (
        <div className="vx-launch-console__status" aria-live="polite">
          <div className="vx-launch-console__progress-heading">
            <span><LoaderCircle className="spin" size={14} aria-hidden="true" />{stage}</span>
            <strong className="vx-launch-console__progress-text">{percent !== null
              ? new Intl.NumberFormat(i18n.resolvedLanguage, { style: "percent", maximumFractionDigits: 0 }).format(percent)
              : t("home:totalUnknown")}</strong>
          </div>
          <LatticeProgress completed={progress?.completed ?? 0} total={progress?.total ?? 0} status="active" label={t("home:progress")} unit="items" />
          <span className="vx-launch-console__file-count">{progress && progress.total > 0 ? t("home:files", {
            completed: number.format(progress.completed), total: number.format(progress.total),
          }) : t("home:filesUnknown", { completed: number.format(progress?.completed ?? 0) })}</span>
        </div>
      ) : null}
      {running ? (
        <div className="vx-launch-console__running" role="status">
          <span><i aria-hidden="true" />{t("home:running")}</span>
          <Button variant="secondary" tone="danger" icon={<Square size={15} />} onClick={onStop} disabled={busy === "game.stop"}>{t("home:stop")}</Button>
        </div>
      ) : preparing ? (
        <div className="vx-launch-console__actions">
          <Button variant="secondary" icon={<X size={16} />} onClick={onCancel}>{t("home:cancelPreparation")}</Button>
        </div>
      ) : (
        <div className="vx-launch-console__actions">
          <div ref={launchJelly.ref} className="vx-jelly-control vx-launch-console__launch-wrap" {...launchJelly.handlers}>
            <GlassSurface variant="control" className="vx-launch-console__launch">
              <Button variant="primary" disabled={Boolean(busy)} data-launch-primary
                icon={<Play size={19} fill="currentColor" />}
                onClick={onLaunch}>
                {t("common:actions.launch")}
              </Button>
            </GlassSurface>
          </div>
        </div>
      )}
      {busy && !preparing && !running ? <p className="vx-launch-console__busy" role="status">{t(`shell:operations.${busy}`, { defaultValue: t("common:status.loading") })}</p> : null}
    </div>
  );
}
