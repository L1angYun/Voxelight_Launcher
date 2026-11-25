import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { useTranslation } from "react-i18next";
import { AppProviders } from "./AppProviders";
import { FloatingNav, type NavigationPage } from "./FloatingNav";
import { HomePage } from "../features/home/HomePage";
import { LibraryPage } from "../features/library/LibraryPage";
import { DiscoverPage } from "../features/discover/DiscoverPage";
import { DownloadsPage } from "../features/downloads/DownloadsPage";
import { useDownloadTasks } from "../features/downloads/useDownloadTasks";
import { AccountsPage } from "../features/accounts/AccountsPage";
import { MultiplayerPage } from "../features/multiplayer/MultiplayerPage";
import { SettingsPage } from "../features/settings/SettingsPage";
import { WorldScene } from "../components/WorldScene";
import { HomeBackground } from "./HomeBackground";
import { deriveWorldState } from "../components/world/deriveWorldState";
import { useLauncher } from "./controller/LauncherProvider";
import { useAppearance } from "./AppearanceProvider";
import { ToastProvider, useToast } from "../components/ui/ToastProvider";
import { LauncherUpdateProvider, UpdateNoticeBridge } from "../features/updates/LauncherUpdates";
import { LoadingStatus } from "../components/ui/LoadingStatus";
import { Button } from "../components/ui/Button";
import { StorageRecoveryNotice } from "./StorageRecoveryNotice";
import { PageErrorBoundary } from "./PageErrorBoundary";
import { pageVariants } from "../design/motion";
import { useMotionTier } from "../design/useMotionTier";
import { navigationRegistry } from "./registry";
import { useShortcuts } from "./useShortcuts";
import { ShortcutHelp } from "./ShortcutHelp";
import { FirstRunTour } from "./FirstRunTour";
import { FileDropProvider, useFileDrop, type DroppedFiles } from "./FileDropContext";
import { CreateInstanceDialog } from "../features/library/CreateInstanceDialog";
import "./shell.css";

const implementedPages = new Set<NavigationPage>(["home", "library", "discover", "multiplayer", "downloads", "accounts", "settings"]);

function LauncherNoticeBridge() {
  const { notice, dismissNotice } = useLauncher();
  const { t, i18n } = useTranslation();
  const { notify, dismiss } = useToast();
  useEffect(() => {
    if (!notice) { dismiss("launcher"); return; }
    const key = [`shell:notifications.${notice.code}`, `shell:errors.${notice.code}`, `settings:errors.${notice.code}`].find(key => i18n.exists(key));
    notify({ id: "launcher", message: key ? t(key, notice.params) : t("common:errors.internalUnexpected"), kind: notice.kind, onDismiss: dismissNotice });
  }, [notice, dismissNotice, t, i18n, notify, dismiss]);
  return null;
}

function PageStage({ page, direction, firstHome = false, children }: { page: NavigationPage; direction: number; firstHome?: boolean; children: ReactNode }) {
  const present = useIsPresent();
  const { tier } = useMotionTier();
  return <motion.div className="vx-page-stage" data-page-stage={page} data-motion-tier={tier} data-exiting={!present}
    inert={!present} custom={direction} variants={pageVariants(tier, page === "home")}
    initial={firstHome ? false : "enter"} animate="ready" exit="exit">
    {children}
  </motion.div>;
}

export function AppShell() {
  const { t } = useTranslation();
  const [{ page, direction, visit }, setNavigation] = useState<{
    page: NavigationPage; direction: number; visit: number;
  }>({ page: "home", direction: 1, visit: 0 });
  const [navResetTick, setNavResetTick] = useState(0);
  // "View update" opens Settings → About for that one visit only.
  const [updateReview, setUpdateReview] = useState<{ tick: number; visit: number } | null>(null);
  const [tourRequested, setTourRequested] = useState(false);
  const [homeImageShown, setHomeImageShown] = useState(false);
  const [droppedPackPath, setDroppedPackPath] = useState<string | null>(null);
  const hasLeftHome = useRef(false);
  const mainRef = useRef<HTMLElement>(null);
  const downloadTasks = useDownloadTasks();
  const { bootstrapped, bootstrapFailed, data, reload, run, selectInstance, selectVersion, activeAccount, accountAppearance, config, preparing, progress, running, gamePid } = useLauncher();
  const world = useMemo(() => deriveWorldState({ preparing, progress, running, gamePid }), [preparing, progress, running, gamePid]);
  const { effects, reducedMotion, highContrast } = useAppearance();
  const { notify } = useToast();

  function navigate(nextPage: NavigationPage, fixedDirection?: number) {
    if (nextPage === page) {
      setNavResetTick(tick => tick + 1);
      mainRef.current?.scrollTo({ top: 0, behavior: "auto" });
      return;
    }
    if (nextPage !== "home") hasLeftHome.current = true;
    const order = navigationRegistry.ids();
    // Key each visit, not just each route: in wait mode an outgoing stage
    // must finish its exit even when the route is requested again meanwhile.
    setNavigation(current => current.page === nextPage ? current : {
      page: nextPage,
      direction: fixedDirection ?? (order.indexOf(nextPage) >= order.indexOf(current.page) ? 1 : -1),
      visit: current.visit + 1,
    });
  }

  const shortcuts = useShortcuts({ navigate, implemented: implementedPages });

  const handleUnhandledDrop = (files: DroppedFiles) => {
    const key = files.mods.length > 0
      ? "shell:drop.openInstanceForMods"
      : files.skins.length > 0
        ? "shell:drop.openAccountsForSkins"
        : "shell:drop.unsupported";
    notify({ id: "file-drop", message: t(key), kind: "info" });
  };

  return (
    <FileDropProvider onUnhandled={handleUnhandledDrop}>
      <GlobalPackDropHandler
        page={page}
        onModpack={(path) => setDroppedPackPath(path)}
      />
      <LauncherNoticeBridge />
      <UpdateNoticeBridge onReview={() => {
        setUpdateReview(current => ({ tick: (current?.tick ?? 0) + 1, visit: page === "settings" ? visit : visit + 1 }));
        navigate("settings");
      }} />
      <a className="vx-skip-link" href="#main-content">{t("shell:a11y.skipToContent")}</a>
      <div className="vx-app-body" data-current-page={page}>
        {/* Global WorldScene background — runs on all pages for glass refraction */}
        {bootstrapped ? <WorldScene
          className="vx-global-scene"
          phase={world.phase}
          fraction={world.fraction}
          page={page === "home" ? "home" : "content"}
          scene={config.worldScene}
          material={config.worldMaterial}
          effects={effects}
          reducedMotion={reducedMotion || highContrast}
          paused={page === "home" && homeImageShown}
        /> : <div className="world-scene vx-global-scene" aria-hidden="true" data-world-tier="css"
          data-world-bootstrap="pending" data-world-frames="0" data-world-material="solid" data-world-phase={world.phase}
          data-world-front="0" data-motion="reduced" data-paused="true" />}
        <HomeBackground page={page} onImageShownChange={setHomeImageShown} />
        <FloatingNav
          page={page}
          onNavigate={navigate}
          implemented={implementedPages}
          activeTaskCount={downloadTasks.activeCount}
          accountName={activeAccount?.username}
          accountSkinUrl={accountAppearance.skinUrl}
        />
        <main ref={mainRef} id="main-content" className="vx-app-main" data-current-page={page} tabIndex={-1}>
          {data.storage?.recovery ? <StorageRecoveryNotice storage={data.storage} /> : null}
          {bootstrapFailed ? <div className="vx-bootstrap-error vx-panel" role="alert"><p>{t("common:errors.bootstrapFailed")}</p>
            <Button onClick={() => void run("bootstrap", reload)}>{t("common:actions.retry")}</Button></div> : null}
          <AnimatePresence mode="wait" initial={false} custom={direction}
            onExitComplete={() => mainRef.current?.scrollTo({ top: 0, behavior: "auto" })}>
          {!bootstrapped && !bootstrapFailed ? <motion.div key="boot" className="vx-bootstrap-state" exit={{ opacity: 0 }} transition={{ duration: 0 }}>
            <LoadingStatus active>{t("common:status.loading")}</LoadingStatus>
          </motion.div> : <PageStage key={visit} page={page} direction={direction} firstHome={page === "home" && !hasLeftHome.current}>
          <PageErrorBoundary
            page={page}
            title={t("common:errors.internalUnexpected")}
            description={t("common:errors.missing")}
            retryLabel={t("common:actions.retry")}
          >
            {page === "home" ? <HomePage returning={hasLeftHome.current} /> : null}
            {page === "library" ? <LibraryPage navResetTick={navResetTick} /> : null}
            {page === "discover" ? <DiscoverPage onDownloads={() => navigate("downloads", 1)} /> : null}
            {page === "multiplayer" ? <MultiplayerPage /> : null}
            {page === "downloads" ? <DownloadsPage model={downloadTasks} /> : null}
            {page === "accounts" ? <AccountsPage /> : null}
            {page === "settings" ? <SettingsPage reviewUpdates={updateReview?.visit === visit ? updateReview.tick : 0} /> : null}
          </PageErrorBoundary>
          </PageStage>}
          </AnimatePresence>
        </main>
      </div>
      <ShortcutHelp
        open={shortcuts.helpOpen}
        onOpenChange={shortcuts.setHelpOpen}
        onShowTour={() => setTourRequested(true)}
        implemented={implementedPages}
        canShowTour={bootstrapped}
      />
      <FirstRunTour reopen={tourRequested} onDismissed={() => setTourRequested(false)} />
      {droppedPackPath ? (
        <CreateInstanceDialog
          open
          onOpenChange={(open) => { if (!open) setDroppedPackPath(null); }}
          initialMode="import"
          initialPackPath={droppedPackPath}
          onInstalled={async (versionId, instanceId) => {
            await reload();
            if (instanceId) selectInstance(instanceId);
            else selectVersion(versionId);
            setDroppedPackPath(null);
          }}
        />
      ) : null}
    </FileDropProvider>
  );
}

function GlobalPackDropHandler({
  page,
  onModpack,
}: {
  page: NavigationPage;
  onModpack: (path: string) => void;
}) {
  const hintKey = page === "home" || page === "library"
    ? "shell:drop.hintModpack"
    : "shell:drop.hintGeneral";
  useFileDrop((dropped) => {
    if (dropped.modpacks.length > 0) {
      onModpack(dropped.modpacks[0]);
      return true;
    }
    if (dropped.zips.length === 1 && (page === "home" || page === "library")) {
      onModpack(dropped.zips[0]);
      return true;
    }
    return false;
  }, { priority: 0, hintKey });
  return null;
}

export function App() {
  return (
    <AppProviders>
      <ToastProvider><LauncherUpdateProvider><AppShell /></LauncherUpdateProvider></ToastProvider>
    </AppProviders>
  );
}
