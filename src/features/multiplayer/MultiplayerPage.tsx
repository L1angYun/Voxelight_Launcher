import { useTranslation } from "react-i18next";
import { useMultiplayer } from "./useMultiplayer";
import { ServerList } from "./ServerList";
import { ManagedServerPanel } from "./ManagedServerPanel";
import { PageHeader, PageShell } from "../../components/ui/PageShell";
import { Segmented } from "../../components/ui/Segmented";
import { SectionPanel } from "../../components/ui/SectionPanel";
import "./multiplayer.css";

export function MultiplayerPage() {
  const { t, i18n } = useTranslation();
  const model = useMultiplayer();
  const { tab, setTab, error, notice } = model;
  const errorText = error
    ? i18n.exists(`multiplayer:errors.${error.code}`)
      ? t(`multiplayer:errors.${error.code}`, error.params)
      : t("common:errors.internalUnexpected")
    : "";

  return (
    <PageShell className="vx-multiplayer-page">
      <PageHeader className="vx-page-heading" title={t("multiplayer:title")} description={t("multiplayer:subtitle")} />
      <Segmented className="vx-multiplayer-tabs" semantic="tabs" label={t("multiplayer:views")} value={tab} onChange={setTab}
        idPrefix="multiplayer-tab" panelId={(id) => `multiplayer-panel-${id}`}
        options={(["servers", "managed"] as const).map((value) => ({ value, label: t(`multiplayer:tab.${value}`) }))} />
      {errorText ? <p className="vx-multiplayer-error" role="alert">{errorText}</p> : null}
      {notice ? <p className="vx-multiplayer-notice" role="status">{t(`multiplayer:notice.${notice}`)}</p> : null}
      <SectionPanel selectionKey={tab} role="tabpanel" id={`multiplayer-panel-${tab}`} aria-labelledby={`multiplayer-tab-${tab}`}>
        {tab === "servers" ? <ServerList model={model} /> : <ManagedServerPanel model={model} />}
      </SectionPanel>
    </PageShell>
  );
}
