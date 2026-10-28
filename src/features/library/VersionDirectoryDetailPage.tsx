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
    <div className="vx-detail-page">
      <header className="vx-detail-header">
        <IconButton
          label={t("common:actions.back")}
          icon={<ArrowLeft size={18} />}
          onClick={onBack}
        />
        <div className="vx-detail-header__identity">
          <InstanceIdentity
            name={t("library:minecraft")}
            identity={version.id}
          />
          <div>
            <h1>{t("library:minecraftVersion", { version: version.id })}</h1>
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
      </header>
      <div className="vx-detail-layout">
        <aside className="vx-detail-context">
          <div
            className="vx-detail-tabs vx-detail-tabs--versions"
            role="tablist"
            aria-orientation="horizontal"
            aria-label={t("library:detailTabs")}
          >
            {tabs.map((item, index) => {
              const id = item.id as typeof tab;
              const Icon = tabIcons[id];
              return (
                <button
                  key={item.id}
                  role="tab"
                  id={`version-tab-${id}`}
                  data-tab={id}
                  aria-selected={tab === id}
                  aria-controls="version-detail-panel"
                  tabIndex={tab === id ? 0 : -1}
                  className={tab === id ? "is-selected" : ""}
                  onClick={() => setTab(id)}
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
                      setTab(tabs[nextIndex].id as typeof tab);
                      document
                        .getElementById(`version-tab-${tabs[nextIndex].id}`)
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
        </div>
      </div>
    </div>
  );
}
