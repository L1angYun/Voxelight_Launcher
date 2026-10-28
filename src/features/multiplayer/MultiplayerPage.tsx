import { useTranslation } from "react-i18next";
import { useMultiplayer } from "./useMultiplayer";
import { ServerList } from "./ServerList";
import { ManagedServerPanel } from "./ManagedServerPanel";
import { ToastRegion } from "../../components/ui/Feedback";
import "./multiplayer.css";

export function MultiplayerPage() {
  const { t, i18n } = useTranslation();
  const model = useMultiplayer();
  const { tab, setTab, error, notice, launchNotice, dismissNotice } = model;
  const errorText = error
    ? i18n.exists(`multiplayer:errors.${error.code}`)
      ? t(`multiplayer:errors.${error.code}`, error.params)
      : t("common:errors.internalUnexpected")
    : "";
  const launchText = launchNotice
    ? i18n.exists(`shell:notifications.${launchNotice.code}`)
      ? t(`shell:notifications.${launchNotice.code}`, launchNotice.params)
      : i18n.exists(`shell:errors.${launchNotice.code}`)
        ? t(`shell:errors.${launchNotice.code}`, launchNotice.params)
        : t("common:errors.internalUnexpected")
    : "";

  function selectTab(next: "servers" | "managed") {
    setTab(next);
    requestAnimationFrame(() => document.getElementById(`multiplayer-tab-${next}`)?.focus());
  }

  return (
    <div className="vx-multiplayer-page">
      <header className="vx-page-heading">
        <div><h1>{t("multiplayer:title")}</h1><p>{t("multiplayer:subtitle")}</p></div>
      </header>
      <div className="vx-multiplayer-tabs" role="tablist" aria-label={t("multiplayer:views")}>
        {(["servers", "managed"] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`multiplayer-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`multiplayer-panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => setTab(id)}
            onKeyDown={(event) => {
              let next: "servers" | "managed" | undefined;
              if (event.key === "ArrowLeft" || event.key === "ArrowRight") next = tab === "servers" ? "managed" : "servers";
              else if (event.key === "Home") next = "servers";
              else if (event.key === "End") next = "managed";
              if (next) {
                event.preventDefault();
                selectTab(next);
              }
            }}
          >
            {t(`multiplayer:tab.${id}`)}
          </button>
        ))}
      </div>
      {errorText ? <p className="vx-multiplayer-error" role="alert">{errorText}</p> : null}
      {notice ? <p className="vx-multiplayer-notice" role="status">{t(`multiplayer:notice.${notice}`)}</p> : null}
      <div role="tabpanel" id={`multiplayer-panel-${tab}`} aria-labelledby={`multiplayer-tab-${tab}`}>
        {tab === "servers" ? <ServerList model={model} /> : <ManagedServerPanel model={model} />}
      </div>
      {launchNotice ? <ToastRegion message={launchText} kind={launchNotice.kind} onDismiss={dismissNotice} closeLabel={t("common:actions.close")} /> : null}
    </div>
  );
}
