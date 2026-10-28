import { useId } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  Ban,
  CheckCircle2,
  Clock3,
  Download,
  Pause,
  Play,
  RotateCcw,
  X,
} from "lucide-react";
import {
  downloadKindRegistry,
  downloadStageRegistry,
  type Registry,
} from "../../app/registry";
import { Button } from "../../components/ui/Button";
import { LatticeProgress } from "../../visual/lattice/LatticeProgress";
import type { LatticeStatus } from "../../visual/lattice/model";
import { formatBytes, formatDate, formatNumber } from "../../i18n/format";
import {
  taskActions,
  type DownloadTask,
  type DownloadTaskAction,
} from "./useDownloadTasks";

function registeredLabel(registry: Registry, id: string): string {
  return registry.get(registry.ids().includes(id) ? id : "unknown").labelKey;
}

function latticeStatus(status: string): LatticeStatus {
  if (status === "completed") return "done";
  if (status === "failed") return "error";
  if (status === "paused" || status === "interrupted") return "paused";
  if (status === "cancelled") return "unknown";
  return "active";
}

function StatusIcon({ status }: { status: string }) {
  const Icon =
    status === "completed"
      ? CheckCircle2
      : status === "failed" || status === "interrupted"
        ? AlertCircle
        : status === "cancelled"
          ? Ban
          : status === "queued" || status === "paused"
            ? Clock3
            : Download;
  return <Icon size={18} aria-hidden="true" />;
}

const actionIcons = {
  pause: Pause,
  resume: Play,
  cancel: X,
  retry: RotateCcw,
};

function TaskRow({
  task,
  rate,
  busyTaskId,
  onAction,
  animated,
}: {
  task: DownloadTask;
  rate?: number;
  busyTaskId: string | null;
  onAction: (task: DownloadTask, action: DownloadTaskAction) => void;
  animated: boolean;
}) {
  const { t, i18n } = useTranslation();
  const titleId = useId();
  const kind = t(registeredLabel(downloadKindRegistry, task.kind), {
    ns: "downloads",
  });
  const title = task.target
    ? t("downloads:taskTitle", { kind, target: task.target })
    : kind;
  const stage = t(registeredLabel(downloadStageRegistry, task.stage), {
    ns: "downloads",
  });
  const status = t(`downloads:status.${task.status}`, {
    defaultValue: t("downloads:status.unknown"),
  });
  const fileTotalKnown = Number.isFinite(task.total) && task.total > 0;
  const safeFilesCompleted = Math.max(
    0,
    Math.min(
      Number.isFinite(task.completed) ? task.completed : 0,
      fileTotalKnown ? task.total : Number.POSITIVE_INFINITY,
    ),
  );
  const filesCompleted = formatNumber(safeFilesCompleted, i18n.language);
  const filesTotal = fileTotalKnown
    ? formatNumber(task.total, i18n.language)
    : t("downloads:progress.unknownShort");
  const bytesTotalKnown =
    Number.isFinite(task.bytesTotal) && task.bytesTotal > 0;
  const safeBytesCompleted = bytesTotalKnown
    ? Math.max(
        0,
        Math.min(
          Number.isFinite(task.bytesCompleted) ? task.bytesCompleted : 0,
          task.bytesTotal,
        ),
      )
    : Math.max(
        0,
        Number.isFinite(task.bytesCompleted) ? task.bytesCompleted : 0,
      );
  const bytesCompleted = formatBytes(safeBytesCompleted, i18n.language);
  const bytesTotal = bytesTotalKnown
    ? formatBytes(task.bytesTotal, i18n.language)
    : t("downloads:progress.unknownShort");
  const progressBasis = bytesTotalKnown
    ? "bytes"
    : fileTotalKnown
      ? "items"
      : "unknown";
  const progressCompleted = bytesTotalKnown
    ? safeBytesCompleted
    : fileTotalKnown
      ? safeFilesCompleted
      : 0;
  const progressTotal = bytesTotalKnown
    ? task.bytesTotal
    : fileTotalKnown
      ? task.total
      : 0;
  const percent = bytesTotalKnown
    ? Math.round((safeBytesCompleted / task.bytesTotal) * 100)
    : fileTotalKnown
      ? Math.round((safeFilesCompleted / task.total) * 100)
      : null;
  const progressLabel = bytesTotalKnown
    ? t("downloads:progress.byteLabel", {
        completed: bytesCompleted,
        total: bytesTotal,
      })
    : fileTotalKnown
      ? t("downloads:progress.files", {
          completed: filesCompleted,
          total: filesTotal,
        })
      : t("downloads:progress.byteLabelUnknown", { completed: bytesCompleted });
  const actions = taskActions(task.status, task.kind);

  return (
    <article
      className="vx-task-row"
      data-task-id={task.id}
      data-status={task.status}
      data-stage={task.stage}
      data-bytes-completed={task.bytesCompleted}
      data-bytes-total={task.bytesTotal}
      data-progress-basis={progressBasis}
      data-visual-owner="lattice"
      aria-busy={busyTaskId === task.id || undefined}
      aria-labelledby={titleId}
    >
      <header className="vx-task-row__header">
        <div className="vx-task-row__identity">
          <h3 id={titleId} title={title}>
            {title}
          </h3>
          <p className="vx-task-row__stage" data-status={task.status}>
            <StatusIcon status={task.status} />
            {stage}
          </p>
        </div>
        <span className="sr-only">{status}</span>
      </header>

      <div className="vx-task-row__progress">
        <div className="vx-task-row__readout">
          <div className="vx-task-row__bytes-block">
            {bytesTotalKnown ? (
              <strong className="vx-task-row__bytes">
                {bytesCompleted} / {bytesTotal}
              </strong>
            ) : safeBytesCompleted > 0 ? (
              <strong className="vx-task-row__bytes">
                {t("downloads:progress.bytesCompleted", {
                  completed: bytesCompleted,
                })}
              </strong>
            ) : (
              <strong className="vx-task-row__bytes">
                {t("downloads:progress.sizePending")}
              </strong>
            )}
            <span className="vx-task-row__stage-copy">
              {fileTotalKnown
                ? t("downloads:progress.files", {
                    completed: filesCompleted,
                    total: filesTotal,
                  })
                : t("downloads:progress.completedUnknown", {
                    completed: filesCompleted,
                  })}
            </span>
          </div>
          {percent !== null ? (
            <strong className="vx-task-row__percent">
              {t("downloads:progress.percent", {
                percent: formatNumber(percent, i18n.language),
              })}
            </strong>
          ) : null}
        </div>
        <LatticeProgress
          completed={progressCompleted}
          total={progressTotal}
          status={latticeStatus(task.status)}
          label={progressLabel}
          unit={progressBasis === "bytes" ? "bytes" : "items"}
          animated={animated}
        />
        <div className="vx-task-row__meta">
          {rate !== undefined &&
          Number.isFinite(rate) &&
          rate > 0 &&
          task.status === "running" ? (
            <span className="vx-task-row__rate">
              {t("downloads:progress.rate", {
                rate: formatBytes(rate, i18n.language),
              })}
            </span>
          ) : null}
        </div>
      </div>

      {task.status === "failed" ? (
        <p className="vx-task-row__message">
          {t("downloads:errors.taskFailed")}
        </p>
      ) : null}
      {task.status === "interrupted" ? (
        <p className="vx-task-row__message">
          {t("downloads:interruptedDescription")}
        </p>
      ) : null}

      <footer className="vx-task-row__footer">
        <time dateTime={task.updatedAt}>
          {formatDate(task.updatedAt, i18n.language)}
        </time>
        {actions.length ? (
          <div className="vx-task-row__actions">
            {actions.map((action) => {
              const Icon = actionIcons[action];
              const label = t(`common:actions.${action}`);
              return (
                <Button
                  key={action}
                  variant="ghost"
                  icon={<Icon size={15} />}
                  loading={busyTaskId === task.id}
                  disabled={busyTaskId !== null}
                  aria-label={`${label}: ${title}`}
                  onClick={() => onAction(task, action)}
                >
                  {label}
                </Button>
              );
            })}
          </div>
        ) : (
          <span />
        )}
      </footer>
    </article>
  );
}

export function TaskList({
  tasks,
  rates,
  busyTaskId,
  onAction,
  animateFirst = false,
}: {
  tasks: DownloadTask[];
  rates: Record<string, number>;
  busyTaskId: string | null;
  onAction: (task: DownloadTask, action: DownloadTaskAction) => void;
  animateFirst?: boolean;
}) {
  return (
    <div className="vx-task-list">
      {tasks.map((task, index) => (
        <TaskRow
          key={task.id}
          task={task}
          rate={rates[task.id]}
          busyTaskId={busyTaskId}
          onAction={onAction}
          animated={animateFirst && index === 0}
        />
      ))}
    </div>
  );
}
