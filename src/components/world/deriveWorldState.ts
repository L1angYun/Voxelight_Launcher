// SPDX-License-Identifier: GPL-3.0-only
import type { Progress, RunningGame } from "../../lib/launcher";
import type { WorldStatus } from "./types";

export interface WorldStateInput {
  busy: string;
  progress: Progress | null;
  running: readonly RunningGame[];
  gamePid?: number;
}

function fraction(completed: number, total: number): number | null {
  if (!Number.isFinite(completed) || !Number.isFinite(total) || total <= 0) return null;
  return Math.max(0, Math.min(1, completed / total));
}

/** Derives current business state; preparation history belongs to the director. */
export function deriveWorldState({ busy, progress, running, gamePid }: WorldStateInput): WorldStatus {
  if (running.length > 0 || (Number.isFinite(gamePid) && (gamePid ?? 0) > 0)) {
    return { phase: "running", fraction: null };
  }
  if (busy !== "game.prepare") return { phase: "idle", fraction: null };
  return {
    phase: "preparing",
    fraction: progress
      ? fraction(progress.bytesCompleted, progress.bytesTotal) ?? fraction(progress.completed, progress.total)
      : null,
  };
}
