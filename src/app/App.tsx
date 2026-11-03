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
import { deriveWorldState } from "../components/world/deriveWorldState";
import { useLauncher } from "./controller/LauncherProvider";
import { useAppearance } from "./AppearanceProvider";
import { ToastProvider, useToast } from "../components/ui/ToastProvider";
import { LoadingStatus } from "../components/ui/LoadingStatus";
import { Button } from "../components/ui/Button";
import { PageErrorBoundary } from "./PageErrorBoundary";
import { pageVariants } from "../design/motion";
import { useMotionTier } from "../design/useMotionTier";
import { navigationRegistry } from "./registry";
import "../design/global.css";
import "./shell.css";
import "../design/surfaces.css";

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

function AppShell() {
  const { t } = useTranslation();
  const [page, setPage] = useState<NavigationPage>("home");
  const [direction, setDirection] = useState(1);
  const [navResetTick, setNavResetTick] = useState(0);
  const hasLeftHome = useRef(false);
  const mainRef = useRef<HTMLElement>(null);
  const downloadTasks = useDownloadTasks();
  const { bootstrapped, bootstrapFailed, reload, run, activeAccount, accountAppearance, config, busy, progress, running, gamePid } = useLauncher();
  const world = useMemo(() => deriveWorldState({ busy, progress, running, gamePid }), [busy, progress, running, gamePid]);
  const { effects, reducedMotion, highContrast } = useAppearance();
  return (
    <>
      <LauncherNoticeBridge />
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
        /> : <div className="world-scene vx-global-scene" aria-hidden="true" data-world-tier="css"
          data-world-bootstrap="pending" data-world-frames="0" data-world-material="solid" data-world-phase={world.phase}
          data-world-front="0" data-motion="reduced" data-paused="true" />}
        <FloatingNav
          page={page}
          onNavigate={(nextPage) => {
            if (nextPage === page) {
              setNavResetTick(tick => tick + 1);
              mainRef.current?.scrollTo({ top: 0, behavior: "auto" });
              return;
            }
            const order = navigationRegistry.ids();
            setDirection(order.indexOf(nextPage) >= order.indexOf(page) ? 1 : -1);
            if (nextPage !== "home") hasLeftHome.current = true;
            setPage(nextPage);
          }}
          implemented={implementedPages}
          activeTaskCount={downloadTasks.activeCount}
          accountName={activeAccount?.username}
          accountSkinUrl={accountAppearance.skinUrl}
        />
        <main ref={mainRef} id="main-content" className="vx-app-main" data-current-page={page} tabIndex={-1}>
          {bootstrapFailed ? <div className="vx-bootstrap-error vx-panel" role="alert"><p>{t("common:errors.bootstrapFailed")}</p>
            <Button onClick={() => void run("bootstrap", reload)}>{t("common:actions.retry")}</Button></div> : null}
          <AnimatePresence mode="wait" initial={false} custom={direction}
            onExitComplete={() => mainRef.current?.scrollTo({ top: 0, behavior: "auto" })}>
          {!bootstrapped && !bootstrapFailed ? <motion.div key="boot" className="vx-bootstrap-state" exit={{ opacity: 0 }} transition={{ duration: 0 }}>
            <LoadingStatus active>{t("common:status.loading")}</LoadingStatus>
          </motion.div> : <PageStage key={page} page={page} direction={direction} firstHome={page === "home" && !hasLeftHome.current}>
          <PageErrorBoundary
            page={page}
            title={t("common:errors.internalUnexpected")}
            description={t("common:errors.missing")}
            retryLabel={t("common:actions.retry")}
          >
            {page === "home" ? <HomePage returning={hasLeftHome.current} /> : null}
            {page === "library" ? <LibraryPage navResetTick={navResetTick} /> : null}
            {page === "discover" ? <DiscoverPage /> : null}
            {page === "multiplayer" ? <MultiplayerPage /> : null}
            {page === "downloads" ? <DownloadsPage model={downloadTasks} /> : null}
            {page === "accounts" ? <AccountsPage /> : null}
            {page === "settings" ? <SettingsPage /> : null}
          </PageErrorBoundary>
          </PageStage>}
          </AnimatePresence>
        </main>
      </div>
    </>
  );
}

export function App() {
  return (
    <AppProviders>
      <ToastProvider><AppShell /></ToastProvider>
    </AppProviders>
  );
}
