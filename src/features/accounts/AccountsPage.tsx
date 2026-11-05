import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useLauncher } from "../../app/controller/LauncherProvider";
import { AccountList } from "./AccountList";
import { AppearancePanel } from "./AppearancePanel";
import { LoginDialog } from "./LoginDialog";
import { PageShell, PageHeader } from "../../components/ui/PageShell";
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
    <PageShell className="vx-accounts-page">
      <PageHeader title={t("accounts:title")} description={t("accounts:subtitle")} />
      <div className="vx-accounts-layout vx-workspace">
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
    </PageShell>
  );
}
