import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { command, type Account } from "../../lib/launcher";
import { normalizeError } from "../../lib/errors";
import type { useAccountSkin } from "../../lib/accountSkin";
import { PlayerAvatar } from "../../components/PlayerAvatar";
import { Button, IconButton } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/Feedback";
import { accountErrorText } from "./utils";

const SESSION_NEUTRAL_FAILURES = new Set(["auth.rateLimited", "auth.sessionChanged"]);

export function AccountList({
  accounts,
  activeAccount,
  accountAppearance,
  unverified,
  onSessionChecked,
  onChanged,
  onAdd,
}: {
  accounts: Account[];
  activeAccount?: Account;
  accountAppearance: ReturnType<typeof useAccountSkin>;
  /** Accounts whose last session refresh failed; the page owns it so a new sign-in can clear it. */
  unverified: ReadonlySet<string>;
  onSessionChecked: (accountId: string, failed: boolean) => void;
  onChanged: () => Promise<void>;
  onAdd: () => void;
}) {
  const { t } = useTranslation();
  const listId = useId();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  function rowStatus(account: Account, selected: boolean): "sessionUnverified" | "profileUnavailable" | undefined {
    if (unverified.has(account.id)) return "sessionUnverified";
    const online = account.type === "microsoft" || account.type === "authlib";
    if (selected && online && !accountAppearance.loading && accountAppearance.error) return "profileUnavailable";
    return undefined;
  }

  async function perform(account: Account, action: "select" | "refresh" | "remove") {
    if (busy) return;
    setBusy(`${action}-${account.id}`);
    setError("");
    setNotice("");
    try {
      const commandName = action === "select"
        ? "select_account"
        : action === "refresh"
          ? "refresh_account"
          : "remove_account";
      await command(commandName, { accountId: account.id });
      if (action !== "select") onSessionChecked(account.id, false);
      await onChanged();
      if (action === "refresh") setNotice(t("accounts:notice.sessionRefreshed", { name: account.username }));
    } catch (cause) {
      const failure = normalizeError(cause);
      // A rate limit or a replaced session says nothing about this account's credentials.
      if (action === "refresh" && !SESSION_NEUTRAL_FAILURES.has(failure.code)) onSessionChecked(account.id, true);
      if (action === "remove" && failure.code === "auth.credentialCleanupPending") {
        // The profile is already gone; keep the cleanup warning visible after refreshing.
        await onChanged().catch(() => {});
      }
      setError(accountErrorText(cause, t));
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="vx-account-list" aria-labelledby="account-list-title">
      <header className="vx-account-section-heading">
        <h2 id="account-list-title">{t("accounts:listTitle")}</h2>
        {accounts.length ? (
          <IconButton variant="secondary" size="sm" label={t("accounts:addAccount")} icon={<Plus size={14} />} onClick={onAdd} />
        ) : null}
      </header>
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {accounts.length ? (
        <ul className="vx-account-list__items">
          {accounts.map((account) => {
            const selected = activeAccount?.id === account.id;
            const online = account.type !== "offline";
            const status = rowStatus(account, selected);
            const warningId = status ? `${listId}-status-${account.id}` : undefined;
            return (
              <li className="vx-account-row" key={account.id} data-selected={selected || undefined} data-status={status}>
                <button className="vx-account-choice" type="button" aria-current={selected || undefined} aria-label={t(selected ? "accounts:actions.current" : "accounts:actions.select", { name: account.username })} aria-describedby={warningId} disabled={Boolean(busy)} onClick={() => { if (!selected) void perform(account, "select"); }}>
                  <PlayerAvatar skinUrl={selected ? accountAppearance.skinUrl : account.skinUrl} username={account.username} label={t("accounts:avatar", { name: account.username })} size={36} />
                  <span className="vx-account-row__identity">
                    <strong title={account.username}>{account.username}</strong>
                    {status ? (
                      <small className="vx-account-row__warning" id={warningId}>
                        <TriangleAlert size={12} aria-hidden="true" />
                        <span>{t(`accounts:status.${status}`)}</span>
                      </small>
                    ) : (
                      <small>{t(`accounts:type.${account.type}`, { defaultValue: t("accounts:type.unknown") })}</small>
                    )}
                  </span>
                </button>
                <div className="vx-account-row__actions">
                  {online ? (
                    <IconButton
                      size="sm"
                      label={t("accounts:actions.refresh", { name: account.username })}
                      icon={<RefreshCw size={15} />}
                      disabled={Boolean(busy)}
                      onClick={() => void perform(account, "refresh")}
                    />
                  ) : null}
                  <IconButton
                    size="sm"
                    label={t("accounts:actions.remove", { name: account.username })}
                    icon={<Trash2 size={15} />}
                    disabled={Boolean(busy)}
                    onClick={() => void perform(account, "remove")}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState
          title={t("accounts:empty.title")}
          description={t("accounts:empty.description")}
          action={<Button variant="primary" icon={<Plus size={16} />} onClick={onAdd}>{t("accounts:addAccount")}</Button>}
        />
      )}
    </section>
  );
}
