import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Activity, Download, History } from "lucide-react";
import { EmptyState } from "../../components/ui/Feedback";
import { PageHeader, PageShell } from "../../components/ui/PageShell";
import { LoadingStatus } from "../../components/ui/LoadingStatus";
import { Button } from "../../components/ui/Button";
import { Segmented } from "../../components/ui/Segmented";
import { TaskList } from "./TaskList";
import type { DownloadTasksModel } from "./useDownloadTasks";
import "./downloads.css";

export function DownloadsPage({ model }: { model: DownloadTasksModel }) {
  const { t, i18n } = useTranslation();
  const { tasks, active, history, rates, busyTaskId, loading, error, act } = model;
  const [historyFilter, setHistoryFilter] = useState<"all" | "failed" | "completed">("all");
  const [historyLimit, setHistoryLimit] = useState(30);
  const filteredHistory = historyFilter === "all" ? history : history.filter(task => task.status === historyFilter);
  const errorText = error
    ? i18n.exists(`downloads:errors.${error.code}`)
      ? t(`downloads:errors.${error.code}`, error.params)
      : t("common:errors.internalUnexpected")
    : "";
  const listProps = {
    rates,
    busyTaskId,
    onAction: (
      task: Parameters<typeof act>[0],
      action: Parameters<typeof act>[1],
    ) => void act(task, action),
  };

  return (
    <PageShell className="vx-downloads-page">
      <PageHeader title={t("downloads:title")} description={t("downloads:subtitle")} />

      {errorText ? (
        <p className="vx-downloads-error" role="alert">
          {errorText}
        </p>
      ) : null}
      <LoadingStatus active={loading && tasks.length === 0}>{t("common:status.loading")}</LoadingStatus>
      {!loading && tasks.length === 0 && !errorText ? (
        <EmptyState
          className="vx-downloads-empty vx-panel"
          icon={<Download size={24} />}
          title={t("downloads:empty.title")}
          description={t("downloads:empty.description")}
        />
      ) : null}

      {tasks.length > 0 ? (
        <div className="vx-task-center">
          <section
            className="vx-task-section vx-task-section--active vx-panel"
            aria-labelledby="downloads-active"
          >
            <header className="vx-task-section__heading">
              <h2 id="downloads-active">{t("downloads:active")}</h2>
              <span
                aria-label={t("downloads:activeCount", {
                  count: active.length,
                })}
              >
                {active.length}
              </span>
            </header>
            {active.length ? (
              <TaskList tasks={active} {...listProps} animateFirst />
            ) : (
              <TaskSectionEmpty
                kind="active"
                title={t("downloads:empty.activeTitle")}
                description={t("downloads:empty.activeDescription")}
              />
            )}
          </section>
          <section
            className="vx-task-section vx-task-section--history vx-panel"
            aria-labelledby="downloads-history"
          >
            <header className="vx-task-section__heading">
              <h2 id="downloads-history">{t("downloads:history")}</h2>
              {history.length > 0 ? <Segmented className="vx-task-history-filters" semantic="toggle"
                label={t("downloads:historyFilter")} value={historyFilter}
                onChange={value => { setHistoryFilter(value); setHistoryLimit(30); }}
                options={(["all", "failed", "completed"] as const).map(value => ({ value, label: t(`downloads:historyFilters.${value}`) }))} /> : null}
              <span
                aria-label={t("downloads:historyCount", {
                  count: history.length,
                })}
              >
                {history.length}
              </span>
            </header>
            {filteredHistory.length ? (
              <TaskList tasks={filteredHistory.slice(0, historyLimit)} {...listProps} compact />
            ) : (
              <TaskSectionEmpty
                kind="history"
                title={t(history.length ? "downloads:empty.filteredTitle" : "downloads:empty.historyTitle")}
                description={t(history.length ? "downloads:empty.filteredDescription" : "downloads:empty.historyDescription")}
              />
            )}
            {filteredHistory.length > historyLimit ? <Button className="vx-task-history-more" size="sm" variant="secondary"
              onClick={() => setHistoryLimit(limit => limit + 30)}>{t("downloads:showMore")}</Button> : null}
          </section>
        </div>
      ) : null}
    </PageShell>
  );
}

function TaskSectionEmpty({
  kind,
  title,
  description,
}: {
  kind: "active" | "history";
  title: string;
  description: string;
}) {
  const Icon = kind === "active" ? Activity : History;
  return (
    <div className="vx-task-section__empty" data-kind={kind}>
      <span className="vx-task-section__empty-mark" aria-hidden="true">
        <Icon size={17} strokeWidth={1.35} />
        <i />
        <i />
        <i />
      </span>
      <span className="vx-task-section__empty-copy">
        <strong>{title}</strong>
        <span>{description}</span>
      </span>
    </div>
  );
}
