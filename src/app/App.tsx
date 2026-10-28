import { useRef, useState } from "react";
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
import { useLauncher } from "./controller/LauncherProvider";
import "../design/global.css";
import "./shell.css";

const implementedPages = new Set<NavigationPage>(["home", "library", "discover", "multiplayer", "downloads", "accounts", "settings"]);

function AppShell() {
  const { t } = useTranslation();
  const [page, setPage] = useState<NavigationPage>("home");
  const mainRef = useRef<HTMLElement>(null);
  const downloadTasks = useDownloadTasks();
  const { activeAccount, accountAppearance } = useLauncher();
  return (
    <>
      <a className="vx-skip-link" href="#main-content">{t("shell:a11y.skipToContent")}</a>
      <div className="vx-app-body" data-current-page={page}>
        {/* Global WorldScene background — runs on all pages for glass refraction */}
        <WorldScene
          className="vx-global-scene"
          state="idle"
          paused={false}
        />
        <FloatingNav
          page={page}
          onNavigate={(nextPage) => {
            setPage(nextPage);
            mainRef.current?.scrollTo({ top: 0, behavior: "instant" });
          }}
          implemented={implementedPages}
          activeTaskCount={downloadTasks.activeCount}
          accountName={activeAccount?.username}
          accountSkinUrl={accountAppearance.skinUrl}
        />
        <main ref={mainRef} id="main-content" className="vx-app-main" data-current-page={page} tabIndex={-1}>
          {page === "home" ? <HomePage /> : null}
          {page === "library" ? <LibraryPage /> : null}
          {page === "discover" ? <DiscoverPage /> : null}
          {page === "multiplayer" ? <MultiplayerPage /> : null}
          {page === "downloads" ? <DownloadsPage model={downloadTasks} /> : null}
          {page === "accounts" ? <AccountsPage /> : null}
          {page === "settings" ? <SettingsPage /> : null}
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
