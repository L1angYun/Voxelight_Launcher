import { FolderOpen, LoaderCircle, Play, Square, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
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
  instance, instances, version, onSelectInstance, pickerOpen, onPickerOpenChange, onLaunch, onStop, onCancel, onOpenFolder, busy, running, progress,
}: {
  instance?: Instance;
  instances: Instance[];
  version?: InstalledVersion;
  onSelectInstance: (id?: string) => void;
  pickerOpen: boolean;
  onPickerOpenChange: (open: boolean) => void;
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
  const actionsRef = useRef<HTMLDivElement>(null);
  const ownsFocus = useRef(false);
  const cancelAvailableAt = useRef(Infinity);
  const [cancelReady, setCancelReady] = useState(false);
  useLayoutEffect(() => {
    setCancelReady(false);
    cancelAvailableAt.current = Infinity;
    if (!preparing) return;
    cancelAvailableAt.current = performance.now() + MOTION.delay.cancelGuardMs;
    let timer: ReturnType<typeof setTimeout>;
    const unlock = () => {
      const remaining = cancelAvailableAt.current - performance.now();
      if (remaining > 0) timer = setTimeout(unlock, Math.max(1, remaining));
      else setCancelReady(true);
    };
    timer = setTimeout(unlock, MOTION.delay.cancelGuardMs);
    return () => { clearTimeout(timer); cancelAvailableAt.current = Infinity; };
  }, [preparing]);
  useLayoutEffect(() => {
    if (!ownsFocus.current || !actionsRef.current) return;
    const active = document.activeElement;
    // A pending operation can finish after the user has moved to another control.
    if (active && active !== document.body && !actionsRef.current.contains(active)) {
      ownsFocus.current = false; return;
    }
    const next = actionsRef.current.querySelector<HTMLButtonElement>(`[data-launch-action="${state}"]`);
    if (next && !next.closest("[inert]")) next.focus({ preventScroll: true });
  }, [state]);
  const activate = (event: MouseEvent<HTMLButtonElement>, blocked: boolean, action: () => Promise<void>) => {
    if (blocked || event.currentTarget.closest("[inert]")) return;
    ownsFocus.current = Boolean(actionsRef.current?.contains(document.activeElement));
    void action();
  };
  const useBytes = Boolean(progress && progress.bytesTotal > 0);
  const completed = (useBytes ? progress?.bytesCompleted : progress?.completed) ?? 0;
  const total = (useBytes ? progress?.bytesTotal : progress?.total) ?? 0;
  const percent = total > 0 ? Math.max(0, Math.min(1, completed / total)) : null;
  const number = new Intl.NumberFormat(i18n.resolvedLanguage);
  const stageKey = progress?.stage ?? "queued";
  const stage = i18n.exists(`home:stages.${stageKey}`) ? t(`home:stages.${stageKey}`) : t("home:preparing");
  const [announcement, setAnnouncement] = useState("");
  const lastAnnouncement = useRef<{ stage: string; bucket: number; language?: string } | null>(null);
  const bucket = percent === null ? -1 : Math.floor(percent * 4) * 25;
  useEffect(() => {
    if (!preparing) { lastAnnouncement.current = null; setAnnouncement(""); return; }
    const previous = lastAnnouncement.current;
    if (previous?.stage === stageKey && previous.language === i18n.resolvedLanguage && bucket <= previous.bucket) return;
    lastAnnouncement.current = { stage: stageKey, bucket, language: i18n.resolvedLanguage };
    setAnnouncement(bucket > 0 ? t("home:progressMilestone", { stage,
      percent: new Intl.NumberFormat(i18n.resolvedLanguage, { style: "percent", maximumFractionDigits: 0 }).format(bucket / 100) }) : stage);
  }, [preparing, stageKey, stage, bucket, t, i18n.resolvedLanguage]);
  return (
    <div className="vx-launch-console" data-state={state} data-picker-open={pickerOpen}>
      <span className="sr-only" role="status" aria-atomic="true" data-launch-announcement>{announcement}</span>
      <motion.div className="vx-launch-console__context" layout={tier === "full" ? "position" : false}
        layoutDependency={state} transition={{ duration: motionDuration(tier, "content"), ease: MOTION.ease }}>
        <div className="vx-launch-console__instance">
          <div ref={selectorJelly.ref} className="vx-jelly-control vx-launch-console__selector-wrap" {...selectorJelly.handlers}>
            <GlassSurface variant="control" className="vx-launch-console__selector">
              <InstancePicker instance={instance} instances={instances} versionId={version?.id}
                onSelectInstance={onSelectInstance} onOpenChange={onPickerOpenChange} />
            </GlassSurface>
          </div>
          <IconButton size="sm" label={t("home:openFolder")} icon={<FolderOpen size={14} />} onClick={onOpenFolder} />
        </div>
      </motion.div>
      {preparing ? (
        <motion.div className="vx-launch-console__status"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }}
          transition={{ duration: motionDuration(tier, "content"), ease: MOTION.ease }}>
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
        </motion.div>
      ) : null}
      <div ref={actionsRef} className="vx-launch-console__actions"
        onFocusCapture={() => { ownsFocus.current = true; }}
        onBlurCapture={event => {
          if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) ownsFocus.current = false;
        }}>
        <div ref={launchJelly.ref} className="vx-jelly-control vx-launch-console__launch-wrap" data-visual-owner="lens" {...launchJelly.handlers}>
          <GlassSurface variant="control" className="vx-launch-console__launch" />
            <AnimatePresence initial={false}>
              <ConsoleContent key={state} tier={tier}>
                {preparing ? <Button variant="ghost" size="lg" icon={<X size={16} />} aria-disabled={!cancelReady} data-launch-action="preparing"
                  onClick={event => activate(event, !cancelReady || performance.now() < cancelAvailableAt.current, onCancel)}>
                  {t("home:cancelPreparation")}
                </Button> : running ? <div className="vx-launch-console__running" role="status">
                  <span>{t("home:running")}</span>
                  <Button variant="ghost" size="sm" icon={<Square size={15} />} aria-disabled={Boolean(busy)} data-launch-action="running"
                    onClick={event => activate(event, Boolean(busy), onStop)}>{t("home:stop")}</Button>
                </div> : <Button variant="primary" size="lg" aria-disabled={Boolean(busy)} data-launch-primary data-launch-action="idle"
                  icon={<Play size={19} fill="currentColor" />} onClick={event => activate(event, Boolean(busy), onLaunch)}>
                  {t("common:actions.launch")}
                </Button>}
              </ConsoleContent>
            </AnimatePresence>
        </div>
      </div>
      {busy && !preparing && !running ? <p className="vx-launch-console__busy" role="status">{t(`shell:operations.${busy}`, { defaultValue: t("common:status.loading") })}</p> : null}
    </div>
  );
}
