import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, Globe, Library, RefreshCw } from "lucide-react";
import { useViewState } from "../../app/viewState";
import { EmptyState } from "../../components/ui/Feedback";
import { PageHeader, PageShell } from "../../components/ui/PageShell";
import { LoadingStatus } from "../../components/ui/LoadingStatus";
import { Button, IconButton } from "../../components/ui/Button";
import { useConfirm } from "../../components/ui/ConfirmDialog";
import { Segmented } from "../../components/ui/Segmented";
import { ICON } from "../../design/icons";
import { formatBytes } from "../../i18n/format";
import { LumenHelpButton } from "../assistant/LumenHelpButton";
import { TaskList } from "./TaskList";
import { visibleDownloadTasks, type DownloadTasksModel } from "./useDownloadTasks";
import "./downloads.css";

export function DownloadsPage({ model, onNavigate }: {
  model: DownloadTasksModel;
  onNavigate?: (page: "discover" | "library") => void;
}) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const {
    active: modelActive, history: modelHistory, rates, busyTaskId, bulkBusy, loading, error,
    act, retryFailed, clearUnfinished, refresh,
  } = model;
  // Defense in depth: a snapshot from an older backend may still carry empty
  // character-preview rows. They never render, count, filter or clear.
  const active = visibleDownloadTasks(modelActive);
  const history = visibleDownloadTasks(modelHistory);
  const totalTasks = visibleDownloadTasks(model.tasks).length;
  const [historyFilter, setHistoryFilter] = useViewState<"all" | "failed" | "completed">("downloads.historyFilter", "all");
  const [historyLimit, setHistoryLimit] = useViewState("downloads.historyLimit", 30);
  const [notice, setNotice] = useState("");
  const filteredHistory = historyFilter === "all" ? history : history.filter(task => task.status === historyFilter);
  const failedCount = history.filter(task => task.status === "failed").length;
  const retryableFailed = history.filter(task => task.status === "failed" && task.retryable).length;
  const clearable = history.filter(task => task.status === "failed" || task.status === "cancelled").length;
  const busy = loading || busyTaskId !== null || bulkBusy;
  const errorText = error
    ? i18n.exists(`downloads:errors.${error.code}`)
      ? t(`downloads:errors.${error.code}`, error.params)
      : t("common:errors.internalUnexpected")
    : "";

  async function retryAllFailed() {
    setNotice("");
    const result = await retryFailed();
    if (result) {
      setNotice(t("downloads:retryFailedNotice", {
        count: result.queued,
        skipped: result.skipped,
      }));
    }
  }

  async function clearFailedAndCancelled() {
    if (!await confirm(t("downloads:clearConfirm", { count: clearable }), { tone: "danger" })) return;
    setNotice("");
    const result = await clearUnfinished();
    if (result) {
      setNotice(t("downloads:clearNotice", {
        count: result.tasks,
        bytes: formatBytes(result.bytes, i18n.language),
      }));
    }
  }

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
      <PageHeader title={t("downloads:title")} description={t("downloads:subtitle")}
        actions={<IconButton label={t("downloads:refresh")} icon={<RefreshCw />}
          disabled={busy} onClick={() => void refresh()} />} />

      {errorText ? (
        <p className="vx-downloads-error" role="alert">
          {errorText}
        </p>
      ) : null}
      {notice ? (
        <p className="vx-downloads-notice vx-inline-notice" role="status">
          {notice}
        </p>
      ) : null}
      <LoadingStatus active={loading && totalTasks === 0}>{t("common:status.loading")}</LoadingStatus>
      {!loading && totalTasks === 0 && !errorText ? (
        <EmptyState
          className="vx-downloads-empty"
          variant="panel"
          icon={<Download size={ICON.xl} />}
          title={t("downloads:empty.title")}
          description={t("downloads:empty.description")}
          action={
            <div className="vx-action-row">
              {/* The same icons as the Discover and Library entries in the navigation. */}
              <Button variant="primary" icon={<Globe />} onClick={() => onNavigate?.("discover")}>
                {t("downloads:empty.discover")}
              </Button>
              <Button variant="ghost" icon={<Library />} onClick={() => onNavigate?.("library")}>
                {t("downloads:empty.installGame")}
              </Button>
            </div>
          }
        />
      ) : null}

      {totalTasks > 0 ? (
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
              <EmptyState
                variant="inline"
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
              <div className="vx-task-history-actions">
                {retryableFailed > 0 ? <Button size="sm" variant="secondary" disabled={busy}
                  onClick={() => void retryAllFailed()}>{t("downloads:retryFailed")}</Button> : null}
                {clearable > 0 ? <Button size="sm" variant="secondary" disabled={busy}
                  onClick={() => void clearFailedAndCancelled()}>{t("downloads:clearUnfinished")}</Button> : null}
                <LumenHelpButton
                  size="sm"
                  when={failedCount > 0}
                  label={t("shell:assistant.wake.askDownloads")}
                  reason={t("shell:assistant.wake.downloadsReason", { count: failedCount })}
                  prompt={t("shell:assistant.wake.downloadsPrompt", { count: failedCount })}
                />
              </div>
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
              <EmptyState
                variant="inline"
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
