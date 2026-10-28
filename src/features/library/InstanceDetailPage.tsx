import { useEffect, useState } from "react";
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
  const { run } = useLauncher();
  const [tab, setTab] = useState<InstanceTab>("overview");
  useEffect(() => setTab("overview"), [instance.id]);
  const tabs = instanceTabRegistry.enabled({});
  const select = (next: InstanceTab) => setTab(next);
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
    <div className="vx-detail-page">
      <header className="vx-detail-header">
        <IconButton
          label={t("common:actions.back")}
          icon={<ArrowLeft size={18} />}
          onClick={onBack}
        />
        <div className="vx-detail-header__identity">
          <InstanceIdentity
            name={instance.name}
            identity={instance.id}
            iconPath={instance.iconPath}
          />
          <div>
            <h1 title={instance.name}>{instance.name}</h1>
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
        <details className="vx-detail-manage">
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
      </header>
      <div className="vx-detail-layout">
        <aside className="vx-detail-context">
          <div
            className="vx-detail-tabs"
            role="tablist"
            aria-orientation="horizontal"
            aria-label={t("library:detailTabs")}
          >
            {tabs.map((item, index) => {
              const id = item.id as InstanceTab;
              const Icon = tabIcons[id];
              return (
                <button
                  key={item.id}
                  role="tab"
                  id={`instance-tab-${id}`}
                  data-tab={id}
                  aria-selected={tab === id}
                  aria-controls="instance-detail-panel"
                  tabIndex={tab === id ? 0 : -1}
                  className={tab === id ? "is-selected" : ""}
                  onClick={() => select(id)}
                  onKeyDown={(event) => {
                    let nextIndex: number | undefined;
                    if (event.key === "ArrowDown" || event.key === "ArrowRight")
                      nextIndex = (index + 1) % tabs.length;
                    else if (
                      event.key === "ArrowUp" ||
                      event.key === "ArrowLeft"
                    )
                      nextIndex = (index - 1 + tabs.length) % tabs.length;
                    else if (event.key === "Home") nextIndex = 0;
                    else if (event.key === "End") nextIndex = tabs.length - 1;
                    if (nextIndex !== undefined) {
                      event.preventDefault();
                      select(tabs[nextIndex].id as InstanceTab);
                      document
                        .getElementById(`instance-tab-${tabs[nextIndex].id}`)
                        ?.focus();
                    }
                  }}
                >
                  <Icon size={16} aria-hidden="true" />
                  {t(`library:${item.labelKey}`)}
                </button>
              );
            })}
          </div>
        </aside>
        <div
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
        </div>
      </div>
    </div>
  );
}
