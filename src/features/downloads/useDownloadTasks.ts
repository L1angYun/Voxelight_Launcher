import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { command, events } from "../../lib/launcher";
import { normalizeError, type LauncherError } from "../../lib/errors";

export interface DownloadTask {
  id: string;
  kind: string;
  target: string;
  label: string;
  status: string;
  stage: string;
  completed: number;
  total: number;
  bytesCompleted: number;
  bytesTotal: number;
  message: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export type DownloadTaskAction = "pause" | "resume" | "cancel" | "retry";

export interface DownloadTasksModel {
  tasks: DownloadTask[];
  active: DownloadTask[];
  history: DownloadTask[];
  rates: Record<string, number>;
  activeCount: number;
  busyTaskId: string | null;
  loading: boolean;
  error: LauncherError | null;
  act(task: DownloadTask, action: DownloadTaskAction): Promise<void>;
  refresh(): Promise<void>;
}

const liveStatuses = new Set(["queued", "running", "paused"]);
const activeOrder: Record<string, number> = { running: 0, queued: 1, paused: 2 };

export function taskActions(status: string, kind = "install"): DownloadTaskAction[] {
  if (["failed", "interrupted", "cancelled"].includes(status)) {
    return kind === "install" ? ["retry"] : [];
  }
  if (status === "running") return ["pause", "cancel"];
  if (status === "paused") return ["resume", "cancel"];
  if (status === "queued") return ["cancel"];
  return [];
}

export function useDownloadTasks(): DownloadTasksModel {
  const [tasks, setTasks] = useState<DownloadTask[]>([]);
  const [rates, setRates] = useState<Record<string, number>>({});
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LauncherError | null>(null);
  const previousTasks = useRef<DownloadTask[]>([]);
  const mounted = useRef(true);
  const busy = useRef(false);

  const applyTasks = useCallback((next: DownloadTask[]) => {
    if (!mounted.current) return;
    const previous = new Map(previousTasks.current.map((task) => [task.id, task]));
    const nextRates: Record<string, number> = {};
    for (const task of next) {
      const before = previous.get(task.id);
      if (!before || task.status !== "running" || before.status !== "running") continue;
      const elapsed = (Date.parse(task.updatedAt) - Date.parse(before.updatedAt)) / 1000;
      const bytes = task.bytesCompleted - before.bytesCompleted;
      if (elapsed > 0 && bytes > 0) nextRates[task.id] = bytes / elapsed;
    }
    previousTasks.current = next;
    setTasks(next);
    setRates(nextRates);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const result = await command<DownloadTask[]>("list_download_tasks");
      applyTasks(result);
      if (mounted.current) setError(null);
    } catch (cause) {
      if (mounted.current) setError(normalizeError(cause));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [applyTasks]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const disposer = events<DownloadTask[]>("launcher://tasks", applyTasks);
    return () => {
      mounted.current = false;
      void disposer.then((dispose) => dispose());
    };
  }, [applyTasks, refresh]);

  const act = useCallback(async (task: DownloadTask, action: DownloadTaskAction) => {
    if (busy.current || !taskActions(task.status, task.kind).includes(action)) return;
    busy.current = true;
    setBusyTaskId(task.id);
    setError(null);
    try {
      if (action === "pause" || action === "resume") {
        const result = await command<DownloadTask[]>("set_download_paused", { paused: action === "pause" });
        applyTasks(result);
      } else if (action === "cancel") {
        const result = await command<DownloadTask[]>("cancel_download_task", { taskId: task.id });
        applyTasks(result);
      } else {
        await command<string>("retry_download_task", { taskId: task.id });
        await refresh();
      }
    } catch (cause) {
      if (mounted.current) setError(normalizeError(cause));
    } finally {
      busy.current = false;
      if (mounted.current) setBusyTaskId(null);
    }
  }, [applyTasks, refresh]);

  // This model outlives the Downloads page, so returning to it reuses prepared groups.
  const { active, history } = useMemo(() => {
    const active: DownloadTask[] = [], history: DownloadTask[] = [];
    const updated = new Map<string, number>();
    for (const task of tasks) {
      (liveStatuses.has(task.status) ? active : history).push(task);
      updated.set(task.id, Date.parse(task.updatedAt) || 0);
    }
    const newest = (a: DownloadTask, b: DownloadTask) => updated.get(b.id)! - updated.get(a.id)!;
    active.sort((a, b) => (activeOrder[a.status] ?? 3) - (activeOrder[b.status] ?? 3) || newest(a, b));
    history.sort(newest);
    return { active, history };
  }, [tasks]);

  return { tasks, active, history, rates, activeCount: active.length, busyTaskId, loading, error, act, refresh };
}
