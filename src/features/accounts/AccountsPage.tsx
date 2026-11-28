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
  // Accounts whose last session refresh failed in this visit. The launcher does not persist a
  // session health flag, so a failed refresh is the signal; a later successful refresh, removal
  // or a new sign-in to the same account clears it.
  const [unverified, setUnverified] = useState<ReadonlySet<string>>(() => new Set());

  function markUnverified(accountId: string, failed: boolean) {
    setUnverified((current) => {
      if (current.has(accountId) === failed) return current;
      const next = new Set(current);
      if (failed) next.add(accountId);
      else next.delete(accountId);
      return next;
    });
  }

  return (
    <PageShell className="vx-accounts-page">
      <PageHeader title={t("accounts:title")} description={t("accounts:subtitle")} />
      <div className="vx-accounts-layout vx-workspace">
        <AccountList
          accounts={data.accounts}
          activeAccount={activeAccount}
          accountAppearance={accountAppearance}
          unverified={unverified}
          onSessionChecked={markUnverified}
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
      <LoginDialog open={loginOpen} onOpenChange={setLoginOpen} config={config}
        builtinClientId={data.capabilities.microsoftBuiltinClientId === true} onChanged={reload}
        onSignedIn={(accountId) => markUnverified(accountId, false)} />
    </PageShell>
  );
}
