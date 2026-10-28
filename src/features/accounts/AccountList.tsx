import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Plus, RefreshCw, Trash2 } from "lucide-react";
import { command, type Account } from "../../lib/launcher";
import type { useAccountSkin } from "../../lib/accountSkin";
import { PlayerAvatar } from "../../components/PlayerAvatar";
import { Button, IconButton } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/Feedback";
import { accountErrorText } from "./utils";

export function AccountList({
  accounts,
  activeAccount,
  accountAppearance,
  onChanged,
  onAdd,
}: {
  accounts: Account[];
  activeAccount?: Account;
  accountAppearance: ReturnType<typeof useAccountSkin>;
  onChanged: () => Promise<void>;
  onAdd: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

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
      await onChanged();
      if (action === "refresh") setNotice(t("accounts:notice.sessionRefreshed", { name: account.username }));
    } catch (cause) {
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
          <Button variant="secondary" icon={<Plus size={15} />} onClick={onAdd}>{t("accounts:addAccount")}</Button>
        ) : null}
      </header>
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {accounts.length ? (
        <ul className="vx-account-list__items">
          {accounts.map((account) => {
            const selected = activeAccount?.id === account.id;
            const online = account.type !== "offline";
            return (
              <li className="vx-account-row" key={account.id} data-selected={selected || undefined}>
                <button className="vx-account-choice" type="button" aria-current={selected || undefined} aria-label={t(selected ? "accounts:actions.current" : "accounts:actions.select", { name: account.username })} disabled={Boolean(busy) || selected} onClick={() => void perform(account, "select")}>
                  <PlayerAvatar skinUrl={selected ? accountAppearance.skinUrl : account.skinUrl} username={account.username} label={t("accounts:avatar", { name: account.username })} size={36} />
                  <span className="vx-account-row__identity"><strong>{account.username}</strong><small>{t(`accounts:type.${account.type}`, { defaultValue: t("accounts:type.unknown") })}</small></span>
                  {selected ? <Check size={14} aria-hidden="true" /> : null}
                </button>
                <div className="vx-account-row__actions">
                  {online ? (
                    <IconButton
                      label={t("accounts:actions.refresh", { name: account.username })}
                      icon={<RefreshCw size={15} />}
                      disabled={Boolean(busy)}
                      onClick={() => void perform(account, "refresh")}
                    />
                  ) : null}
                  <IconButton
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
