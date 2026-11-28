import { useCallback, useState, type Dispatch, type SetStateAction } from "react";

/**
 * In-memory only: values live for as long as this module instance (one app
 * session). Nothing is written to disk or to browser storage.
 */
const viewState = new Map<string, unknown>();

/** Clear every remembered view. A fresh app session starts with an empty map. */
export function resetViewState(): void {
  viewState.clear();
}

export function useViewState<T>(
  key: string,
  initial: T | (() => T),
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    if (viewState.has(key)) return viewState.get(key) as T;
    const next = typeof initial === "function" ? (initial as () => T)() : initial;
    viewState.set(key, next);
    return next;
  });

  const update = useCallback<Dispatch<SetStateAction<T>>>((next) => {
    setValue((previous) => {
      const resolved = typeof next === "function" ? (next as (current: T) => T)(previous) : next;
      viewState.set(key, resolved);
      return resolved;
    });
  }, [key]);

  return [value, update];
}
