import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { motion } from "motion/react";
import { Plus, Upload, UserRound } from "lucide-react";
import { command } from "../../lib/launcher";
import { useDefaultSkin } from "../../lib/defaultSkin";
import { useLauncher } from "../../app/controller/LauncherProvider";
import { useAppearance } from "../../app/AppearanceProvider";
import { useOverture } from "../../visual/overture/OvertureProvider";
import { CharacterCanvas, type CharacterAnimation } from "../../visual/character/CharacterCanvas";
import { Button } from "../../components/ui/Button";
import { CreateInstanceDialog } from "../library/CreateInstanceDialog";
import { LaunchConsole } from "./LaunchConsole";
import { RecentInstances } from "./RecentInstances";
import { HomeAnimationSelector } from "./HomeAnimationSelector";
import { MOTION, motionDuration } from "../../design/motion";
import { useMotionTier } from "../../design/useMotionTier";
import "./home.css";

export function HomePage({ returning = false }: { returning?: boolean }) {
  const { t } = useTranslation();
  const {
    data,
    activeAccount,
    accountAppearance,
    selectedInstance,
    selectedVersion,
    selectedVersionId,
    selectedRunningGame,
    running: runningGames,
    progress,
    busy,
    gamePid,
    selectInstance,
    selectVersion,
    launch,
    stop,
    cancelPreparation,
    run,
    reload,
  } = useLauncher();
  const { effects } = useAppearance();
  const { tier, sceneStatic: staticScene } = useMotionTier();
  const { play } = useOverture();
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [useVersionDirectory, setUseVersionDirectory] = useState(false);
  const [launchRequested, setLaunchRequested] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [manualAnimation, setManualAnimation] = useState<CharacterAnimation | null>(null);
  const [charAreaHovered, setCharAreaHovered] = useState(false);
  const [headPointer, setHeadPointer] = useState<{ x: number; y: number } | null>(null);
  const characterAreaRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const preparing = busy === "game.prepare";
  const running = Boolean(selectedRunningGame || gamePid);
  const selectedLaunchPhase = preparing ? "preparing" : running ? "running" : "idle";
  const anyRunning = running || runningGames.length > 0;
  const launchPhase = anyRunning ? "running" : preparing ? "preparing" : "idle";
  const previousLaunchPhase = useRef(launchPhase);
  const [characterResting, setCharacterResting] = useState(anyRunning);

  useEffect(() => {
    if (previousLaunchPhase.current === "preparing" && launchPhase === "running") {
      const pid = gamePid ?? selectedRunningGame?.pid ?? runningGames[0]?.pid;
      if (pid) play({ id: `game-launched-${pid}`, kind: "game-launched" });
    }
    previousLaunchPhase.current = launchPhase;
  }, [gamePid, selectedRunningGame, runningGames, launchPhase, play]);

  useEffect(() => {
    if (!anyRunning) { setCharacterResting(false); return; }
    if (characterResting) return;
    const timer = setTimeout(() => setCharacterResting(true), MOTION.delay.characterIdleMs);
    return () => clearTimeout(timer);
  }, [anyRunning, characterResting]);

  useLayoutEffect(() => {
    let active = true;
    const publishAnchor = () => { if (active) window.dispatchEvent(new Event("vx:world-anchor")); };
    publishAnchor();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(publishAnchor);
    if (layoutRef.current) observer?.observe(layoutRef.current);
    if (!observer) window.addEventListener("resize", publishAnchor);
    return () => {
      active = false;
      observer?.disconnect();
      window.removeEventListener("resize", publishAnchor);
    };
  }, [data.instances.length > 1, activeAccount?.type]);

  const currentInstance = useMemo(
    () =>
      useVersionDirectory
        ? undefined
        : (selectedInstance ??
          data.instances.find((i) => i.versionId === selectedVersionId) ??
          data.instances[0]),
    [data.instances, selectedInstance, selectedVersionId, useVersionDirectory],
  );

  const onlineAccount =
    activeAccount?.type === "microsoft" || activeAccount?.type === "authlib";
  const {
    skin: defaultSkin,
    loading: defaultLoading,
    error: defaultError,
    refresh: refreshDefault,
  } = useDefaultSkin(
    data.config.defaultSkin,
    selectedVersionId,
    !onlineAccount,
  );

  const previewUnavailable = onlineAccount
    ? !accountAppearance.skinUrl
    : !defaultSkin.dataUrl;
  const previewLoading = onlineAccount
    ? accountAppearance.loading
    : defaultLoading;
  const previewError = onlineAccount
    ? Boolean(accountAppearance.error || accountAppearance.errorCode)
    : Boolean(defaultError);
  const retryPreview = onlineAccount
    ? accountAppearance.refresh
    : refreshDefault;

  useEffect(() => {
    if (currentInstance && !selectedInstance)
      selectInstance(currentInstance.id);
  }, [currentInstance, selectInstance, selectedInstance]);

  const versionLabel = currentInstance?.versionId ?? selectedVersionId;
  const javaLabel = selectedVersion?.javaMajor
    ? t("home:javaVersion", { major: selectedVersion.javaMajor })
    : t("home:javaUnknown");

  const previewLabel = onlineAccount
    ? t("home:accountPreview", { username: activeAccount?.username })
    : t("home:defaultPreview");

  const currentProgress =
    preparing && progress?.versionId === selectedVersionId ? progress : null;

  // Animation: running/preparing take priority; then manual choice; then idle
  const currentAnimation: CharacterAnimation =
    anyRunning ? characterResting ? "idle" : "run" :
    preparing || launchRequested ? "walk" :
    manualAnimation ?? "idle";

  function onCharPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (staticScene || characterResting) return;
    const rect = characterAreaRef.current?.getBoundingClientRect();
    if (!rect) return;
    setHeadPointer({
      x: ((e.clientX - rect.left) / rect.width)  * 2 - 1,
      y: ((e.clientY - rect.top)  / rect.height) * 2 - 1,
    });
  }

  function chooseInstance(id?: string) {
    setUseVersionDirectory(!id);
    selectInstance(id);
  }

  async function installed(versionId: string, instanceId?: string) {
    await reload();
    setUseVersionDirectory(!instanceId);
    if (instanceId) selectInstance(instanceId);
    else selectVersion(versionId);
    play({
      id: `instance-installed-${instanceId ?? versionId}-${Date.now()}`,
      kind: "instance-installed",
    });
  }

  async function beginLaunch() {
    setLaunchRequested(true);
    try {
      await launch();
    } finally {
      setLaunchRequested(false);
    }
  }

  const characterFallback = previewUnavailable ? (
    <div className="vx-character-placeholder">
      <UserRound size={40} strokeWidth={1.3} />
      <strong role="status">
        {previewLoading
          ? t("home:previewLoading")
          : previewError
            ? onlineAccount
              ? t("home:previewUnavailable")
              : t("home:defaultPreviewUnavailable")
            : onlineAccount
              ? t("home:previewEmpty")
              : t("home:defaultPreviewEmpty")}
      </strong>
      {!previewLoading ? (
        <Button variant="secondary" size="md" onClick={retryPreview}>
          {onlineAccount
            ? t("home:retryAppearance")
            : t("home:retryDefaultPreview")}
        </Button>
      ) : null}
    </div>
  ) : undefined;

  const stageTitle = currentInstance?.name ?? (versionLabel || t("home:title"));
  const stageState = running
    ? "running"
    : preparing
      ? "preparing"
      : currentInstance || useVersionDirectory
        ? "ready"
        : "empty";

  return (
    <div
      className="vx-home"
      data-effects={effects}
      data-motion={staticScene ? "reduced" : "full"}
      data-motion-tier={tier}
      data-returning={returning}
      data-state={stageState}
    >
      <div className="vx-home__layout" ref={layoutRef}>
        <section className="vx-home__stage" aria-labelledby="home-instance-title">
          <motion.div className="vx-home__identity" data-picker-open={pickerOpen}
            layout={tier === "full" ? "position" : false} layoutDependency={selectedLaunchPhase}
            transition={{ duration: motionDuration(tier, "content"), ease: MOTION.ease }}>
            <h1 id="home-instance-title" className="vx-home__console-name" title={stageTitle}>
              {currentInstance || useVersionDirectory ? stageTitle : t("home:noInstance")}
            </h1>
            {(currentInstance || useVersionDirectory) && versionLabel ? (
              <ul className="vx-home__meta" aria-label={`${t("home:instance")} ${stageTitle}`}>
                <li>{javaLabel}</li>
              </ul>
            ) : null}
          </motion.div>
          <div className="vx-home__console-wrap">
            {currentInstance || useVersionDirectory ? (
              <LaunchConsole
                instance={currentInstance}
                instances={data.instances}
                version={selectedVersion}
                onSelectInstance={chooseInstance}
                pickerOpen={pickerOpen}
                onPickerOpenChange={setPickerOpen}
                onLaunch={beginLaunch}
                onStop={stop}
                onCancel={cancelPreparation}
                onOpenFolder={() => void run("folder.open", () => command("open_folder", { kind: "game" }))}
                busy={busy}
                running={running}
                progress={currentProgress}
              />
            ) : (
              <div className="vx-home__empty vx-empty">
                <p>{t("home:noInstanceDescription")}</p>
                <div className="vx-empty__actions">
                  <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreateOpen(true)}>
                    {t("home:createInstance")}
                  </Button>
                  <Button variant="secondary" icon={<Upload size={16} />} onClick={() => setImportOpen(true)}>
                    {t("home:importPack")}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </section>

        <div
          className="vx-home__char-col"
          ref={characterAreaRef}
          onPointerEnter={() => setCharAreaHovered(true)}
          onPointerLeave={() => { setCharAreaHovered(false); setHeadPointer(null); }}
          onPointerMove={onCharPointerMove}
        >
          <section className="vx-home__character-panel" aria-label={previewLabel}
            data-character-reveal={returning && tier !== "none" && !previewUnavailable ? "on" : "off"}>
            <div className="vx-home__character-orbit" aria-hidden="true">
              <span className="vx-home__character-floor" />
            </div>
            <span className="vx-home__feet" data-world-anchor aria-hidden="true" />
            {!previewUnavailable ? (
              <CharacterCanvas
                className="vx-home__character"
                skinUrl={onlineAccount ? accountAppearance.skinUrl : defaultSkin.dataUrl}
                capeUrl={onlineAccount ? accountAppearance.capeUrl : null}
                model={onlineAccount ? accountAppearance.model : defaultSkin.model}
                deferMs={returning && tier !== "none" ? MOTION.delay.characterMs : 0}
                paused={staticScene || (anyRunning && characterResting)}
                animation={currentAnimation}
                headPointer={anyRunning ? null : headPointer}
                label={previewLabel}
              />
            ) : characterFallback}
          </section>
          {!onlineAccount ? <p className="vx-home__preview-source">
            <UserRound size={14} aria-hidden="true" />
            {previewLabel}
          </p> : null}
        </div>

        {data.instances.length > 1 ? <div className="vx-home__recent">
          <RecentInstances
            instances={data.instances}
            selectedId={currentInstance?.id}
            onSelect={chooseInstance}
          />
        </div> : null}
        <div className="vx-home__animation-controls"
          onPointerEnter={() => setCharAreaHovered(true)} onPointerLeave={() => setCharAreaHovered(false)}>
          <HomeAnimationSelector value={currentAnimation === "none" ? "idle" : currentAnimation}
            onChange={setManualAnimation} visible={charAreaHovered} disabled={anyRunning || preparing || staticScene} />
        </div>
      </div>

      <CreateInstanceDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onInstalled={installed}
      />
      <CreateInstanceDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onInstalled={installed}
        initialMode="import"
      />
    </div>
  );
}
