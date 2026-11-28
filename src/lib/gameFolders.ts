import type { Config, Instance } from "./launcher";

/** Compare configured game-folder paths the way the backend stores them. */
export function sameGameFolderPath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    value.trim().replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
  return normalize(left) === normalize(right);
}

/**
 * The library shows one game folder. Version folders carry their owning game
 * folder; legacy managed records have none and stay visible everywhere so no
 * existing instance disappears.
 */
export function instancesInGameFolder(instances: Instance[], gameDirectory: string): Instance[] {
  return instances.filter(
    (instance) => !instance.gameFolder || sameGameFolderPath(instance.gameFolder, gameDirectory),
  );
}

export interface GameFolderChoice {
  path: string;
  label: string;
}

/** Configured folders for the selector, with a readable label and no duplicates. */
export function gameFolderChoices(config: Config): GameFolderChoice[] {
  const choices: GameFolderChoice[] = [];
  for (const folder of config.gameFolders ?? []) {
    if (!folder.path || choices.some((choice) => sameGameFolderPath(choice.path, folder.path))) continue;
    const label =
      folder.label.trim() ||
      folder.path.split(/[\\/]/).filter(Boolean).pop() ||
      folder.path;
    choices.push({ path: folder.path, label });
  }
  if (config.gameDirectory && !choices.some((choice) => sameGameFolderPath(choice.path, config.gameDirectory))) {
    choices.push({ path: config.gameDirectory, label: config.gameDirectory });
  }
  return choices;
}

export function isLegacyManagedInstance(instance: Instance): boolean {
  return instance.kind !== "version";
}

/**
 * Launch preparation downloads a missing official base or client jar, so these
 * stored scan states repair themselves. Everything else needs a reinstall.
 */
export function instanceIssueBlocksLaunch(issue: string | null | undefined): boolean {
  return Boolean(issue) && issue !== "baseMissing" && issue !== "clientJarMissing";
}
