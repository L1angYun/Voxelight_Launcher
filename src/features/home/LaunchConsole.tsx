import { FolderOpen, LoaderCircle, Play, Square, X } from "lucide-react";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { useTranslation } from "react-i18next";
import type { Instance, InstalledVersion, Progress } from "../../lib/launcher";
import { Button, IconButton } from "../../components/ui/Button";
import { GlassSurface } from "../../visual/glass/GlassSystem";
import { LatticeProgress } from "../../visual/lattice/LatticeProgress";
import { useAppearance } from "../../app/AppearanceProvider";
import { useJellyControl } from "./useJellyControl";
import { InstancePicker } from "./InstancePicker";
import { MOTION, motionDuration, type MotionTier } from "../../design/motion";
import { useMotionTier } from "../../design/useMotionTier";

function ConsoleContent({ children, tier }: { children: ReactNode; tier: MotionTier }) {
  const present = useIsPresent();
  return <motion.div className="vx-launch-console__content" inert={!present} aria-hidden={!present || undefined}
    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
    transition={{ duration: motionDuration(tier, "content"), ease: MOTION.ease }}>
    {children}
  </motion.div>;
}

export function LaunchConsole({
  instance, instances, version, onSelectInstance, onLaunch, onStop, onCancel, onOpenFolder, busy, running, progress,
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
  const { effects, reducedMotion, reducedTransparency, highContrast } = useAppearance();
  const { tier } = useMotionTier();
  const staticMotion = reducedMotion || reducedTransparency || highContrast || effects === "lite";
  const selectorJelly = useJellyControl<HTMLDivElement>(staticMotion);
  const launchJelly = useJellyControl<HTMLDivElement>(staticMotion);
  const preparing = busy === "game.prepare";
  const state = preparing ? "preparing" : running ? "running" : "idle";
  const cancelAvailableAt = useRef(Infinity);
  useLayoutEffect(() => {
    cancelAvailableAt.current = preparing ? performance.now() + MOTION.delay.cancelGuardMs : Infinity;
  }, [preparing]);
  const useBytes = Boolean(progress && progress.bytesTotal > 0);
  const completed = (useBytes ? progress?.bytesCompleted : progress?.completed) ?? 0;
  const total = (useBytes ? progress?.bytesTotal : progress?.total) ?? 0;
  const percent = total > 0 ? Math.max(0, Math.min(1, completed / total)) : null;
  const number = new Intl.NumberFormat(i18n.resolvedLanguage);
  const stageKey = progress?.stage ?? "queued";
  const stage = i18n.exists(`home:stages.${stageKey}`) ? t(`home:stages.${stageKey}`) : t("home:preparing");
  return (
    <div className="vx-launch-console" data-state={state}>
      <motion.div className="vx-launch-console__context" layout={tier === "full" ? "position" : false}
        layoutDependency={state} transition={{ duration: motionDuration(tier, "content"), ease: MOTION.ease }}>
        <div className="vx-launch-console__instance">
          <div ref={selectorJelly.ref} className="vx-jelly-control vx-launch-console__selector-wrap" {...selectorJelly.handlers}>
            <GlassSurface variant="control" className="vx-launch-console__selector">
              <InstancePicker instance={instance} instances={instances} versionId={version?.id} onSelectInstance={onSelectInstance} />
            </GlassSurface>
          </div>
          <IconButton label={t("home:openFolder")} icon={<FolderOpen size={18} />} onClick={onOpenFolder} />
        </div>
      </motion.div>
      {preparing ? (
        <div className="vx-launch-console__status" aria-live="polite">
          <div className="vx-launch-console__progress-heading">
            <span><LoaderCircle className="spin" size={14} aria-hidden="true" />{stage}</span>
            <strong className="vx-launch-console__progress-text">{percent !== null
              ? new Intl.NumberFormat(i18n.resolvedLanguage, { style: "percent", maximumFractionDigits: 0 }).format(percent)
              : t("home:totalUnknown")}</strong>
          </div>
          <LatticeProgress completed={completed} total={total} status={percent === null ? "unknown" : percent >= 1 ? "done" : "active"}
            label={t("home:progress")} unit={useBytes ? "bytes" : "items"} />
          <span className="vx-launch-console__file-count">{progress && progress.total > 0 ? t("home:files", {
            completed: number.format(progress.completed), total: number.format(progress.total),
          }) : t("home:filesUnknown", { completed: number.format(progress?.completed ?? 0) })}</span>
        </div>
      ) : null}
      <div className="vx-launch-console__actions">
        <div ref={launchJelly.ref} className="vx-jelly-control vx-launch-console__launch-wrap" {...launchJelly.handlers}>
          <GlassSurface variant="control" className="vx-launch-console__launch">
            <AnimatePresence initial={false}>
              <ConsoleContent key={state} tier={tier}>
                {preparing ? <Button variant="ghost" size="lg" icon={<X size={16} />}
                  onClick={() => { if (performance.now() >= cancelAvailableAt.current) void onCancel(); }}>
                  {t("home:cancelPreparation")}
                </Button> : running ? <div className="vx-launch-console__running" role="status">
                  <span>{t("home:running")}</span>
                  <Button variant="ghost" size="sm" icon={<Square size={15} />} onClick={onStop} disabled={busy === "game.stop"}>{t("home:stop")}</Button>
                </div> : <Button variant="primary" size="lg" disabled={Boolean(busy)} data-launch-primary
                  icon={<Play size={19} fill="currentColor" />} onClick={onLaunch}>
                  {t("common:actions.launch")}
                </Button>}
              </ConsoleContent>
            </AnimatePresence>
          </GlassSurface>
        </div>
      </div>
      {busy && !preparing && !running ? <p className="vx-launch-console__busy" role="status">{t(`shell:operations.${busy}`, { defaultValue: t("common:status.loading") })}</p> : null}
    </div>
  );
}
