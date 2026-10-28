import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Box, Plus, Upload, UserRound } from "lucide-react";
import { command } from "../../lib/launcher";
import { useDefaultSkin } from "../../lib/defaultSkin";
import { useLauncher } from "../../app/controller/LauncherProvider";
import { useAppearance } from "../../app/AppearanceProvider";
import { useOverture } from "../../visual/overture/OvertureProvider";
import { OvertureScene } from "../../visual/overture/OvertureScene";
import { EmptyState, ToastRegion } from "../../components/ui/Feedback";
import { Button } from "../../components/ui/Button";
import { GlassSurface } from "../../visual/glass/GlassSystem";
import { CreateInstanceDialog } from "../library/CreateInstanceDialog";
import { LaunchConsole } from "./LaunchConsole";
import { RecentInstances } from "./RecentInstances";
import "./home.css";

export function HomePage() {
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
  const { effects, reducedMotion } = useAppearance();
  const { play } = useOverture();
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [useVersionDirectory, setUseVersionDirectory] = useState(false);
  const [launchRequested, setLaunchRequested] = useState(false);

  const currentInstance = useMemo(
    () =>
      useVersionDirectory
        ? undefined
        : selectedInstance ??
          data.instances.find((i) => i.versionId === selectedVersionId) ??
          data.instances[0],
    [data.instances, selectedInstance, selectedVersionId, useVersionDirectory],
  );

  const onlineAccount = activeAccount?.type === "microsoft" || activeAccount?.type === "authlib";
  const { skin: defaultSkin, loading: defaultLoading, error: defaultError, refresh: refreshDefault } =
    useDefaultSkin(data.config.defaultSkin, selectedVersionId, !onlineAccount);

  const previewUnavailable = onlineAccount ? !accountAppearance.skinUrl : !defaultSkin.dataUrl;
  const previewLoading = onlineAccount ? accountAppearance.loading : defaultLoading;
  const previewError = onlineAccount
    ? Boolean(accountAppearance.error || accountAppearance.errorCode)
    : Boolean(defaultError);
  const retryPreview = onlineAccount ? accountAppearance.refresh : refreshDefault;

  useEffect(() => {
    if (currentInstance && !selectedInstance) selectInstance(currentInstance.id);
  }, [currentInstance, selectInstance, selectedInstance]);

  useEffect(() => {
    play({ id: "home-first-entry", kind: "first-run" });
  }, [play]);

  useEffect(() => {
    if (gamePid) play({ id: `game-launched-${gamePid}`, kind: "game-launched" });
  }, [gamePid, play]);

  const versionLabel = currentInstance?.versionId ?? selectedVersionId;
  const loaderLabel =
    currentInstance?.loader && currentInstance.loader !== "vanilla"
      ? currentInstance.loader
      : t("home:vanilla");
  const javaLabel = selectedVersion?.javaMajor
    ? `Java ${selectedVersion.javaMajor}`
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

  const staticScene = reducedMotion || effects === "lite";
  const preparing = busy === "game.prepare";
  const running = Boolean(selectedRunningGame || gamePid);
  const currentProgress =
    preparing && progress?.versionId === selectedVersionId ? progress : null;

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
          {onlineAccount ? t("home:retryAppearance") : t("home:retryDefaultPreview")}
        </Button>
      ) : null}
    </div>
  ) : undefined;

  return (
    <div className="vx-home" data-effects={effects}>
      {/* OvertureScene — renders WorldScene + CharacterCanvas for test contracts;
          the global scene in AppShell already covers the background, so we hide
          the local WorldScene and only show the character frame */}
      <div className="vx-home__character-panel">
        <OvertureScene
          skinUrl={onlineAccount ? accountAppearance.skinUrl : defaultSkin.dataUrl}
          capeUrl={onlineAccount ? accountAppearance.capeUrl : null}
          model={onlineAccount ? accountAppearance.model : defaultSkin.model}
          paused={staticScene}
          sceneId={currentInstance?.id ?? selectedVersionId ?? "empty"}
          label={previewLabel}
          characterFallback={characterFallback}
          className="vx-home__scene"
          state={running ? "running" : preparing || launchRequested ? "preparing" : "idle"}
          progress={
            currentProgress && currentProgress.total > 0
              ? (currentProgress.completed / currentProgress.total) * 100
              : 0
          }
        >
          <p className="vx-home__preview-source">
            <UserRound size={12} aria-hidden="true" />
            {previewLabel}
          </p>
        </OvertureScene>
      </div>

      {/* Main instrument panel — bottom-left */}
      <section className="vx-home__stage" aria-labelledby="vx-home-instance-title">
        <GlassSurface className="vx-home__glass-panel" variant="dialog">
          {/* Identity */}
          <div className="vx-home__identity">
            <h1 id="vx-home-instance-title" className="vx-home__title">
              {currentInstance?.name ?? (versionLabel || t("home:title"))}
            </h1>
            {versionLabel ? (
              <ul className="vx-home__meta" aria-label={t("home:instance")}>
                {currentInstance ? (
                  <li>
                    <Box size={11} aria-hidden="true" />
                    <span>{versionLabel}</span>
                  </li>
                ) : null}
                <li>
                  <span className="vx-home__meta-dot" />
                  <span>{loaderLabel}</span>
                </li>
                <li>
                  <span className="vx-home__meta-dot" />
                  <span>{javaLabel}</span>
                </li>
              </ul>
            ) : null}
          </div>

          {/* Launch console or empty state */}
          {currentInstance || useVersionDirectory ? (
            <LaunchConsole
              instance={currentInstance}
              instances={data.instances}
              version={selectedVersion}
              onSelectInstance={chooseInstance}
              onLaunch={beginLaunch}
              onStop={stop}
              onCancel={cancelPreparation}
              onOpenFolder={() =>
                void run("folder.open", () => command("open_folder", { kind: "game" }))
              }
              busy={busy}
              running={running}
              progress={currentProgress}
            />
          ) : (
            <EmptyState
              title={t("home:noInstance")}
              description={t("home:noInstanceDescription")}
              action={
                <div className="vx-empty__actions">
                  <Button
                    variant="primary"
                    icon={<Plus size={16} />}
                    onClick={() => setCreateOpen(true)}
                  >
                    {t("home:createInstance")}
                  </Button>
                  <Button
                    variant="ghost"
                    icon={<Upload size={16} />}
                    onClick={() => setImportOpen(true)}
                  >
                    {t("home:importPack")}
                  </Button>
                </div>
              }
            />
          )}
        </GlassSurface>

        {/* Recent instances strip */}
        <div className="vx-home__recent">
          <RecentInstances
            instances={data.instances}
            selectedId={currentInstance?.id}
            onSelect={chooseInstance}
          />
        </div>
      </section>

      {notice ? (
        <ToastRegion
          message={noticeText}
          kind={notice.kind}
          onDismiss={dismissNotice}
          closeLabel={t("common:actions.close")}
        />
      ) : null}
      <CreateInstanceDialog open={createOpen} onOpenChange={setCreateOpen} onInstalled={installed} />
      <CreateInstanceDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onInstalled={installed}
        initialMode="import"
      />
    </div>
  );
}
