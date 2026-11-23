import { command } from "./launcher";

export type LauncherPathUse =
  | "gameDirectory" | "java" | "instanceIcon" | "skin" | "background"
  | "presetRead" | "presetWrite" | "localResources" | "worldRead" | "worldWrite"
  | "packRead" | "packWrite" | "instanceArchive" | "diagnostics"
  | "serverJar" | "serverFolder";

export function pickLauncherPaths(purpose: LauncherPathUse, suggestedName?: string) {
  return command<string[] | null>("choose_launcher_path", { purpose, suggestedName });
}

export async function pickLauncherPath(purpose: LauncherPathUse, suggestedName?: string) {
  return (await pickLauncherPaths(purpose, suggestedName))?.[0] ?? null;
}
