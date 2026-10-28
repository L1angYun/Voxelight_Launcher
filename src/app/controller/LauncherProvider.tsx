import { createContext, useContext, type ReactNode } from "react";
import { useLauncherController } from "./useLauncherController";
import type { LauncherContextValue } from "./types";

const LauncherContext = createContext<LauncherContextValue | null>(null);

export function LauncherProvider({ children }: { children?: ReactNode }) {
  const value = useLauncherController();
  return <LauncherContext.Provider value={value}>{children}</LauncherContext.Provider>;
}

export function useLauncher(): LauncherContextValue {
  const value = useContext(LauncherContext);
  if (!value) throw new Error("useLauncher must be used inside LauncherProvider");
  return value;
}
