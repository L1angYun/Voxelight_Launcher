import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Upload, UserRound } from "lucide-react";
import { command } from "../../lib/launcher";
import { useDefaultSkin } from "../../lib/defaultSkin";
import { useLauncher } from "../../app/controller/LauncherProvider";
import { useAppearance } from "../../app/AppearanceProvider";
import { useOverture } from "../../visual/overture/OvertureProvider";
import { CharacterCanvas, type CharacterAnimation } from "../../visual/character/CharacterCanvas";
import { ToastRegion } from "../../components/ui/Feedback";
import { Button } from "../../components/ui/Button";
import { CreateInstanceDialog } from "../library/CreateInstanceDialog";
import { LaunchConsole } from "./LaunchConsole";
import { RecentInstances } from "./RecentInstances";
import { HomeAnimationSelector } from "./HomeAnimationSelector";
import { MOTION } from "../../design/motion";
import { useMotionTier } from "../../design/useMotionTier";
import "./home.css";

export function HomePage({ returning = false }: { returning?: boolean }) {
  const { t, i18n } = useTranslation();
  const {
    data,
    activeAccount,
    accountAppearance,
    selectedInstance,
    selectedVersion,
    selectedVersionId,
    selectedRunningGame,
    progress,
    busy,
    notice,
    gamePid,
    selectInstance,
    selectVersion,
    launch,
    stop,
    cancelPreparation,
    run,
    reload,
    dismissNotice,
  } = useLauncher();
  const { effects } = useAppearance();
  const { tier, sceneStatic: staticScene } = useMotionTier();
  const { play } = useOverture();
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [useVersionDirectory, setUseVersionDirectory] = useState(false);
  const [launchRequested, setLaunchRequested] = useState(false);
  const [manualAnimation, setManualAnimation] = useState<CharacterAnimation | null>(null);
  const [charAreaHovered, setCharAreaHovered] = useState(false);
  const [headPointer, setHeadPointer] = useState<{ x: number; y: number } | null>(null);
  const characterAreaRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<HTMLDivElement>(null);

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
  }, []);

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

  useEffect(() => {
    if (gamePid)
      play({ id: `game-launched-${gamePid}`, kind: "game-launched" });
  }, [gamePid, play]);

  const versionLabel = currentInstance?.versionId ?? selectedVersionId;
  const loaderLabel =
    currentInstance?.loader && currentInstance.loader !== "vanilla"
      ? currentInstance.loader
      : t("home:vanilla");
  const javaLabel = selectedVersion?.javaMajor
    ? t("home:javaVersion", { major: selectedVersion.javaMajor })
    : t("home:javaUnknown");

  const noticeText = notice
    ? i18n.exists(`shell:notifications.${notice.code}`)
      ? t(`shell:notifications.${notice.code}`, notice.params)
      : i18n.exists(`shell:errors.${notice.code}`)
        ? t(`shell:errors.${notice.code}`, notice.params)
        : t("common:errors.internalUnexpected")
    : "";

  const previewLabel = onlineAccount
    ? t("home:accountPreview", { username: activeAccount?.username })
    : t("home:defaultPreview");

  const preparing = busy === "game.prepare";
  const running = Boolean(selectedRunningGame || gamePid);
  const currentProgress =
    preparing && progress?.versionId === selectedVersionId ? progress : null;

  // Animation: running/preparing take priority; then manual choice; then idle
  const currentAnimation: CharacterAnimation =
    running ? "run" :
    preparing || launchRequested ? "walk" :
    manualAnimation ?? "idle";

  function onCharPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (staticScene) return;
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
    <div className="vx-character-placeholder" role="status">
      <UserRound size={40} strokeWidth={1.3} />
      <strong>
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
        <Button variant="ghost" onClick={retryPreview}>
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
          <div className="vx-home__identity">
            <h1 id="home-instance-title" className="vx-home__console-name" title={stageTitle}>
              {currentInstance || useVersionDirectory ? stageTitle : t("home:noInstance")}
            </h1>
            {(currentInstance || useVersionDirectory) && versionLabel ? (
              <ul className="vx-home__meta" aria-label={t("home:instance")}>
                <li>{versionLabel}</li>
                <li>{loaderLabel}</li>
                <li>{javaLabel}</li>
              </ul>
            ) : null}
          </div>
          <div className="vx-home__console-wrap">
            {currentInstance || useVersionDirectory ? (
              <LaunchConsole
                instance={currentInstance}
                instances={data.instances}
                version={selectedVersion}
                onSelectInstance={chooseInstance}
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
                  <Button variant="ghost" icon={<Upload size={16} />} onClick={() => setImportOpen(true)}>
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
          data-world-anchor
          onPointerEnter={() => setCharAreaHovered(true)}
          onPointerLeave={() => { setCharAreaHovered(false); setHeadPointer(null); }}
          onPointerMove={onCharPointerMove}
        >
          <div
            className="vx-home__animation-controls"
            role="group"
            aria-label={t("home:animationMode")}
          >
            <HomeAnimationSelector value={currentAnimation === "none" ? "idle" : currentAnimation}
              onChange={setManualAnimation} visible={charAreaHovered} disabled={running || preparing || staticScene} />
          </div>
          <section className="vx-home__character-panel" aria-label={previewLabel}
            data-character-reveal={returning && tier !== "none" && !previewUnavailable ? "on" : "off"}>
            <div className="vx-home__character-orbit" aria-hidden="true">
              <span className="vx-home__character-floor" />
            </div>
            {!previewUnavailable ? (
              <CharacterCanvas
                className="vx-home__character"
                skinUrl={onlineAccount ? accountAppearance.skinUrl : defaultSkin.dataUrl}
                capeUrl={onlineAccount ? accountAppearance.capeUrl : null}
                model={onlineAccount ? accountAppearance.model : defaultSkin.model}
                deferMs={returning && tier !== "none" ? MOTION.delay.characterMs : 0}
                paused={staticScene}
                animation={currentAnimation}
                headPointer={headPointer}
                label={previewLabel}
              />
            ) : characterFallback}
          </section>
          <p className="vx-home__preview-source">
            <UserRound size={14} aria-hidden="true" />
            {previewLabel}
          </p>
        </div>

        <div className="vx-home__recent">
          <RecentInstances
            instances={data.instances}
            selectedId={currentInstance?.id}
            onSelect={chooseInstance}
          />
        </div>
      </div>

      {notice ? (
        <ToastRegion
          message={noticeText}
          kind={notice.kind}
          onDismiss={dismissNotice}
          closeLabel={t("common:actions.close")}
        />
      ) : null}
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
