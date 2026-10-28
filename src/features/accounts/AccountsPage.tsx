import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useLauncher } from "../../app/controller/LauncherProvider";
import { AccountList } from "./AccountList";
import { AppearancePanel } from "./AppearancePanel";
import { LoginDialog } from "./LoginDialog";
import "./accounts.css";

export function AccountsPage() {
  const { t } = useTranslation();
  const {
    data,
    config,
    activeAccount,
    accountAppearance,
    selectedVersionId,
    reload,
  } = useLauncher();
  const [loginOpen, setLoginOpen] = useState(false);

  return (
    <div className="vx-accounts-page">
      <header className="vx-accounts-heading"><h1>{t("accounts:title")}</h1></header>
      <div className="vx-accounts-layout">
        <AccountList
          accounts={data.accounts}
          activeAccount={activeAccount}
          accountAppearance={accountAppearance}
          onChanged={reload}
          onAdd={() => setLoginOpen(true)}
        />
        <AppearancePanel
          account={activeAccount}
          appearance={accountAppearance}
          config={config}
          versionId={selectedVersionId || undefined}
          onChanged={reload}
        />
      </div>
      <LoginDialog open={loginOpen} onOpenChange={setLoginOpen} config={config} onChanged={reload} />
    </div>
  );
}
