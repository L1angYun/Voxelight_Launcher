import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  FileText,
  Globe2,
  Play,
  SlidersHorizontal,
} from "lucide-react";
import { instanceTabRegistry } from "../../app/registry";
import { Button, IconButton } from "../../components/ui/Button";
import { InstanceContent } from "./InstanceContent";
import { InstanceWorlds } from "./InstanceWorlds";
import { InstanceLogs } from "./InstanceLogs";
import type { InstalledVersion } from "../../lib/launcher";
import { InstanceIdentity } from "./InstanceIdentity";
import { PageHeader, PageShell } from "../../components/ui/PageShell";
import { Segmented } from "../../components/ui/Segmented";
import { SectionPanel } from "../../components/ui/SectionPanel";
import "./detail-sections.css";

const tabIcons = { content: SlidersHorizontal, worlds: Globe2, logs: FileText };

export function VersionDirectoryDetailPage({
  version,
  onBack,
  onLaunch,
}: {
  version: InstalledVersion;
  onBack: () => void;
  onLaunch: () => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"content" | "worlds" | "logs">("content");
  const tabs = instanceTabRegistry
    .enabled({})
    .filter((item) => ["content", "worlds", "logs"].includes(item.id));
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
            kind="version-directory"
            placement="detail"
            name={t("library:minecraft")}
            identity={version.id}
          />
          <div>
            <h1 tabIndex={-1}>{t("library:minecraftVersion", { version: version.id })}</h1>
            <p>
              {t("library:versionDirectory")}
              {version.javaMajor ? (
                <>
                  <span aria-hidden="true"> · </span>
                  {t("library:javaVersion", { version: version.javaMajor })}
                </>
              ) : null}
            </p>
          </div>
        </div>
        <Button variant="primary" icon={<Play size={15} />} onClick={onLaunch}>
          {t("common:actions.launch")}
        </Button>
      </PageHeader>
      <div className="vx-detail-layout vx-workspace">
        <aside className="vx-detail-context">
          <Segmented className="vx-detail-selection" semantic="tabs" orientation="vertical"
            label={t("library:detailTabs")} value={tab} onChange={setTab}
            idPrefix="version-tab" panelId="version-detail-panel"
            options={tabs.map((item) => {
              const id = item.id as typeof tab;
              const Icon = tabIcons[id];
              return { value: id, icon: <Icon size={16} aria-hidden="true" />, label: t(`library:${item.labelKey}`) };
            })} />
        </aside>
        <SectionPanel selectionKey={tab}
          id="version-detail-panel"
          role="tabpanel"
          aria-labelledby={`version-tab-${tab}`}
          className="vx-detail-workspace"
        >
          {tab === "content" ? (
            <InstanceContent versionId={version.id} />
          ) : null}
          {tab === "worlds" ? <InstanceWorlds versionId={version.id} /> : null}
          {tab === "logs" ? <InstanceLogs versionId={version.id} /> : null}
        </SectionPanel>
      </div>
    </PageShell>
  );
}
