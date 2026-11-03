import { useMemo, useRef, useState, type ReactNode } from "react";
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
import { useOverture } from "../visual/overture/OvertureProvider";
import { PageErrorBoundary } from "./PageErrorBoundary";
import { pageVariants } from "../design/motion";
import { useMotionTier } from "../design/useMotionTier";
import { navigationRegistry } from "./registry";
import "../design/global.css";
import "./shell.css";

const implementedPages = new Set<NavigationPage>(["home", "library", "discover", "multiplayer", "downloads", "accounts", "settings"]);

function PageStage({ page, direction, children }: { page: NavigationPage; direction: number; children: ReactNode }) {
  const present = useIsPresent();
  const { tier } = useMotionTier();
  return <motion.div className="vx-page-stage" data-page-stage={page} data-motion-tier={tier} data-exiting={!present}
    inert={!present} custom={direction} variants={pageVariants(tier, page === "home")}
    initial="enter" animate="ready" exit="exit">
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
  const { bootstrapped, activeAccount, accountAppearance, config, busy, progress, running, gamePid } = useLauncher();
  const world = useMemo(() => deriveWorldState({ busy, progress, running, gamePid }), [busy, progress, running, gamePid]);
  const { effects, reducedMotion, highContrast } = useAppearance();
  const { playing } = useOverture();
  return (
    <>
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
          paused={playing}
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
          <AnimatePresence mode="wait" initial={false} custom={direction}
            onExitComplete={() => mainRef.current?.scrollTo({ top: 0, behavior: "auto" })}>
          <PageStage key={page} page={page} direction={direction}>
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
          </PageStage>
          </AnimatePresence>
        </main>
      </div>
    </>
  );
}

export function App() {
  return (
    <AppProviders>
      <AppShell />
    </AppProviders>
  );
}
