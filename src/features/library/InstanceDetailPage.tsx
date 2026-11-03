import { useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  Box,
  FileText,
  Globe2,
  MoreHorizontal,
  Play,
  Settings2,
  SlidersHorizontal,
} from "lucide-react";
import { command, type Instance } from "../../lib/launcher";
import { useLauncher } from "../../app/controller/LauncherProvider";
import { instanceTabRegistry } from "../../app/registry";
import { Button, IconButton } from "../../components/ui/Button";
import { InstanceOverview } from "./InstanceOverview";
import { InstanceContent } from "./InstanceContent";
import { InstanceWorlds } from "./InstanceWorlds";
import { InstanceLogs } from "./InstanceLogs";
import { InstanceSettings } from "./InstanceSettings";
import type { InstanceTab } from "./types";
import { InstanceIdentity } from "./InstanceIdentity";
import { PageHeader, PageShell } from "../../components/ui/PageShell";
import { Segmented } from "../../components/ui/Segmented";
import { SectionPanel } from "../../components/ui/SectionPanel";
import "./detail-sections.css";
import { motionDuration } from "../../design/motion";
import { useMotionTier } from "../../design/useMotionTier";
import { loaderText } from "./utils";

const tabIcons = {
  overview: Box,
  content: SlidersHorizontal,
  worlds: Globe2,
  logs: FileText,
  settings: Settings2,
};

export function InstanceDetailPage({
  instance,
  onBack,
  onChanged,
  onLaunch,
}: {
  instance: Instance;
  onBack: () => void;
  onChanged: () => Promise<void>;
  onLaunch: () => void;
}) {
  const { t } = useTranslation();
  const { tier } = useMotionTier();
  const { run } = useLauncher();
  const [tab, setTab] = useState<InstanceTab>("overview");
  useEffect(() => setTab("overview"), [instance.id]);
  const tabs = instanceTabRegistry.enabled({});
  const remove = () => {
    if (!window.confirm(t("library:removeConfirm", { name: instance.name })))
      return;
    void run("instance.remove", async () => {
      await command("remove_instance", { instanceId: instance.id });
      await onChanged();
      onBack();
    });
  };
  return (
    <PageShell className="vx-detail-page">
      <PageHeader className="vx-detail-header">
        <IconButton
          label={t("common:actions.back")}
          icon={<ArrowLeft size={18} />}
          onClick={onBack}
        />
        <div className="vx-detail-header__identity">
          <InstanceIdentity
            placement="detail"
            name={instance.name}
            identity={instance.id}
            iconPath={instance.iconPath}
          />
          <div>
            <h1 tabIndex={-1} title={instance.name}>{instance.name}</h1>
            <p>
              {instance.versionId}
              <span aria-hidden="true"> · </span>
              {loaderText(instance, t)}
            </p>
          </div>
        </div>
        <Button variant="primary" icon={<Play size={15} />} onClick={onLaunch}>
          {t("common:actions.launch")}
        </Button>
        <details className="vx-detail-manage" style={{ "--menu-enter": `${motionDuration(tier, "menuEnter")}s`, "--menu-exit": `${motionDuration(tier, "menuExit")}s` } as CSSProperties}>
          <summary
            aria-label={t("library:manageInstance", { name: instance.name })}
            title={t("common:actions.manage")}
          >
            <MoreHorizontal size={18} aria-hidden="true" />
          </summary>
          <div className="vx-detail-manage__menu">
            <button type="button" onClick={remove}>
              {t("library:remove")}
            </button>
          </div>
        </details>
      </PageHeader>
      <div className="vx-detail-layout vx-workspace">
        <aside className="vx-detail-context">
          <Segmented className="vx-detail-selection" semantic="tabs" orientation="vertical"
            label={t("library:detailTabs")} value={tab} onChange={setTab}
            idPrefix="instance-tab" panelId="instance-detail-panel"
            options={tabs.map((item) => {
              const id = item.id as typeof tab;
              const Icon = tabIcons[id];
              return { value: id, icon: <Icon size={16} aria-hidden="true" />, label: t(`library:${item.labelKey}`) };
            })} />
        </aside>
        <SectionPanel selectionKey={tab}
          id="instance-detail-panel"
          role="tabpanel"
          aria-labelledby={`instance-tab-${tab}`}
          className="vx-detail-workspace"
        >
          {tab === "overview" ? (
            <InstanceOverview instance={instance} onChanged={onChanged} />
          ) : null}
          {tab === "content" ? (
            <InstanceContent
              versionId={instance.versionId}
              instanceId={instance.id}
            />
          ) : null}
          {tab === "worlds" ? (
            <InstanceWorlds
              versionId={instance.versionId}
              instanceId={instance.id}
            />
          ) : null}
          {tab === "logs" ? (
            <InstanceLogs
              versionId={instance.versionId}
              instanceId={instance.id}
            />
          ) : null}
          {tab === "settings" ? (
            <InstanceSettings instance={instance} onChanged={onChanged} />
          ) : null}
        </SectionPanel>
      </div>
    </PageShell>
  );
}
