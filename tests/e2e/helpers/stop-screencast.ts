// SPDX-License-Identifier: GPL-3.0-only
type CleanupStage = "stop" | "acknowledgement" | "detach";
type ScreencastCleanup = {
  stop?: () => Promise<unknown>;
  removeFrameListener: () => void;
  acknowledgements: Promise<unknown>[];
  detach: () => Promise<unknown>;
  recordError: (stage: CleanupStage, error: unknown) => void;
};

/** Complete the capture transport without discarding any cleanup errors. */
export async function stopScreencast(options: ScreencastCleanup): Promise<void> {
  try { await options.stop?.(); }
  catch (error) { options.recordError("stop", error); }
  // Stopping the producer does not remove an already queued frame event. Freeze
  // the ACK set synchronously before awaiting it; otherwise a late handler can
  // append an ACK after Promise.allSettled takes its snapshot and race detach.
  options.removeFrameListener();
  const results = await Promise.allSettled(options.acknowledgements);
  for (const result of results) if (result.status === "rejected") options.recordError("acknowledgement", result.reason);
  try { await options.detach(); }
  catch (error) { options.recordError("detach", error); }
}
