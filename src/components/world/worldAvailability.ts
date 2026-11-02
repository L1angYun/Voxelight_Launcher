// SPDX-License-Identifier: GPL-3.0-only
import { useSyncExternalStore } from "react";

export type WorldAvailability = "unknown" | "available" | "solid-only" | "css";
let availability: WorldAvailability = "unknown";
const listeners = new Set<() => void>();
export function publishWorldAvailability(next: WorldAvailability) {
  if (availability === next) return;
  availability = next; listeners.forEach(listener => listener());
}
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function useWorldAvailability(): WorldAvailability {
  return useSyncExternalStore(subscribe, () => availability, () => "unknown");
}
