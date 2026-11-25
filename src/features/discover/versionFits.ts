import type { ResourceVersion } from "./types";

/**
 * An instance with its game version and loader resolved through the backend's
 * `get_resource_context` command. `versionId` is only kept for diagnostics: it
 * is a version profile id (for example `fabric-loader-0.16.9-1.21.1`) and must
 * never be compared with a game version directly.
 */
export interface FittableInstance {
  id: string;
  name: string;
  versionId?: string;
  /** The vanilla game version the profile inherits from; absent if unresolved. */
  gameVersion?: string;
  /** The detected loader; absent, empty or `vanilla` means a vanilla profile. */
  loader?: string | null;
}

const normalized = (value: string) => value.trim().toLowerCase();

/**
 * Mirrors the target planner in `src-tauri/src/resource_targets.rs`: a version
 * fits when its game versions contain the instance's resolved game version
 * and, for mods, the instance's resolved loader is declared by the version.
 * Quilt is not aliased to Fabric there, so it is not aliased here either.
 * Resource packs, shaders and data packs ignore the loader. A modpack always
 * creates a new instance, so it never fits an existing one.
 */
export function instancesFitting(
  version: Pick<ResourceVersion, "gameVersions" | "loaders">,
  instances: readonly FittableInstance[],
  resourceType: string,
): FittableInstance[] {
  if (normalized(resourceType) === "modpack") return [];
  const isMod = normalized(resourceType) === "mod";
  const games = new Set(version.gameVersions.map(normalized));
  const loaders = new Set(version.loaders.map(normalized));
  return instances.filter((instance) => {
    // An unresolved context cannot be matched, like the backend's metadataMissing.
    const game = instance.gameVersion ? normalized(instance.gameVersion) : "";
    if (!game || !games.has(game)) return false;
    if (!isMod) return true;
    const loader = normalized(instance.loader ?? "");
    if (!loader || loader === "vanilla") return false;
    return loaders.has(loader);
  });
}
