// SPDX-License-Identifier: GPL-3.0-only
type ReferenceEdge = { replacedCount: number; invalidReason?: string | null; maxBackgroundDelta?: number | null };

function stationReplacedCount(edges: readonly ReferenceEdge[]) {
  let total = 0;
  for (const edge of edges) {
    if (!Number.isInteger(edge.replacedCount) || edge.replacedCount < 0)
      throw new Error("Reference edge replacement count must be a finite non-negative integer");
    total += edge.replacedCount;
  }
  return total;
}

/** Retry once only when this station actually used an unstable reference. */
export async function referenceAttempts<T extends { edges: readonly ReferenceEdge[] }>(
  capture: (attempt: 0 | 1) => Promise<T>,
): Promise<{ result: T; attempts: T[] }> {
  const first = await capture(0);
  const attempts = [first];
  if (stationReplacedCount(first.edges) > 0
    && first.edges.some(edge => edge.invalidReason === "background-frame-drift" && (edge.maxBackgroundDelta ?? 0) > 8)) {
    const replacement = await capture(1);
    stationReplacedCount(replacement.edges);
    attempts.push(replacement);
  }
  return { result: attempts[attempts.length - 1], attempts };
}
