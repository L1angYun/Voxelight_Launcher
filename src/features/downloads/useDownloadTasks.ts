import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { command, events } from "../../lib/launcher";
import { normalizeError, type LauncherError } from "../../lib/errors";

export interface DownloadTask {
  id: string;
  kind: string;
  target: string;
  label: string;
  displayTarget?: string | null;
  status: string;
  stage: string;
  completed: number;
  total: number;
  bytesCompleted: number;
  bytesTotal: number;
  message: string;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DownloadTaskSnapshot {
  revision: number;
  tasks: DownloadTask[];
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
  const mounted = useRef(false);
  const lifecycle = useRef(0);
  const appliedRevision = useRef(-1);
  const refreshRequest = useRef(0);
  const refreshing = useRef(false);
  const busy = useRef(false);

  const applyTasks = useCallback(({ revision, tasks: next }: DownloadTaskSnapshot) => {
    if (!mounted.current || revision <= appliedRevision.current) return;
    appliedRevision.current = revision;
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
    if (!mounted.current || refreshing.current) return;
    const request = ++refreshRequest.current;
    const session = lifecycle.current;
    const current = () => lifecycle.current === session && request === refreshRequest.current;
    const baseline = appliedRevision.current;
    refreshing.current = true;
    setLoading(true);
    try {
      const result = await command<DownloadTaskSnapshot>("list_download_tasks");
      if (!current()) return;
      applyTasks(result);
      setError(null);
    } catch (cause) {
      if (current() && appliedRevision.current === baseline) setError(normalizeError(cause));
    } finally {
      if (current()) {
        refreshing.current = false;
        setLoading(false);
      }
    }
  }, [applyTasks]);

  useEffect(() => {
    const session = ++lifecycle.current;
    mounted.current = true;
    const disposer = events<DownloadTaskSnapshot>("launcher://tasks", (next) => {
      if (lifecycle.current === session) applyTasks(next);
    });
    // An event may land before this snapshot returns; only a later revision can replace it.
    void disposer.then(() => {
      if (lifecycle.current === session) void refresh();
    }).catch(cause => {
      if (lifecycle.current !== session) return;
      setError(normalizeError(cause));
      setLoading(false);
    });
    return () => {
      ++lifecycle.current;
      mounted.current = false;
      refreshing.current = false;
      busy.current = false;
      void disposer.then(dispose => dispose()).catch(() => {});
    };
  }, [applyTasks, refresh]);

  const act = useCallback(async (task: DownloadTask, action: DownloadTaskAction) => {
    const current = previousTasks.current.find(item => item.id === task.id);
    if (!mounted.current || busy.current || !current || !taskActions(current.status, current.kind).includes(action)) return;
    const session = lifecycle.current;
    busy.current = true;
    setBusyTaskId(task.id);
    setError(null);
    try {
      if (action === "pause" || action === "resume") {
        const result = await command<DownloadTaskSnapshot>("set_download_paused", { taskId: task.id, paused: action === "pause" });
        if (lifecycle.current === session) applyTasks(result);
      } else if (action === "cancel") {
        const result = await command<DownloadTaskSnapshot>("cancel_download_task", { taskId: task.id });
        if (lifecycle.current === session) applyTasks(result);
      } else {
        await command<string>("retry_download_task", { taskId: task.id });
        if (lifecycle.current === session) await refresh();
      }
    } catch (cause) {
      if (lifecycle.current === session) setError(normalizeError(cause));
    } finally {
      if (lifecycle.current === session) {
        busy.current = false;
        setBusyTaskId(null);
      }
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
