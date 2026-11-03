import { useTranslation } from "react-i18next";
import { Activity, Download, History } from "lucide-react";
import { EmptyState } from "../../components/ui/Feedback";
import { PageHeader, PageShell } from "../../components/ui/PageShell";
import { LoadingStatus } from "../../components/ui/LoadingStatus";
import { TaskList } from "./TaskList";
import type { DownloadTasksModel } from "./useDownloadTasks";
import "./downloads.css";

export function DownloadsPage({ model }: { model: DownloadTasksModel }) {
  const { t, i18n } = useTranslation();
  const { tasks, active, history, rates, busyTaskId, loading, error, act } = model;
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
      <PageHeader className="vx-page-heading" title={t("downloads:title")} />

      {errorText ? (
        <p className="vx-downloads-error" role="alert">
          {errorText}
        </p>
      ) : null}
      <LoadingStatus active={loading && tasks.length === 0}>{t("common:status.loading")}</LoadingStatus>
      {!loading && tasks.length === 0 && !errorText ? (
        <EmptyState
          className="vx-downloads-empty"
          icon={<Download size={24} />}
          title={t("downloads:empty.title")}
          description={t("downloads:empty.description")}
        />
      ) : null}

      {tasks.length > 0 ? (
        <div className="vx-task-center">
          <section
            className="vx-task-section vx-task-section--active"
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
              <span
                aria-label={t("downloads:historyCount", {
                  count: history.length,
                })}
              >
                {history.length}
              </span>
            </header>
            {history.length ? (
              <TaskList tasks={history} {...listProps} />
            ) : (
              <TaskSectionEmpty
                kind="history"
                title={t("downloads:empty.historyTitle")}
                description={t("downloads:empty.historyDescription")}
              />
            )}
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
