import { getCurrentWindow } from "@tauri-apps/api/window";
import { desktop } from "./launcher";

export function getLauncherWindow(): ReturnType<typeof getCurrentWindow> | null {
  if (!desktop) return null;
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}
