export type CapabilityMap = Record<string, unknown>;
export type NavigationPlacement = "primary" | "utility" | "contextual";

export interface RegistryItem<Id extends string = string> {
  id: Id;
  labelKey: string;
  placement?: NavigationPlacement;
  capability?: string;
  when?: (capabilities: CapabilityMap) => boolean;
}

export interface Registry<Id extends string = string> {
  ids(): Id[];
  get(id: Id): RegistryItem<Id>;
  enabled(capabilities: CapabilityMap): RegistryItem<Id>[];
}

export function createRegistry<Id extends string>(
  definitions: readonly RegistryItem<Id>[],
): Registry<Id> {
  const seen = new Set<string>();
  for (const definition of definitions) {
    if (seen.has(definition.id)) throw new Error(`Duplicate registry id: ${definition.id}`);
    seen.add(definition.id);
  }
  const items = [...definitions];
  return {
    ids: () => items.map((item) => item.id),
    get: (id) => {
      const item = items.find((candidate) => candidate.id === id);
      if (!item) throw new Error(`Unknown registry id: ${id}`);
      return item;
    },
    enabled: (capabilities) =>
      items.filter((item) => {
        if (item.capability && capabilities[item.capability] === false) return false;
        return item.when ? item.when(capabilities) : true;
      }),
  };
}

export const navigationRegistry = createRegistry([
  { id: "home", labelKey: "navigation.home", placement: "primary" },
  { id: "library", labelKey: "navigation.library", placement: "primary" },
  { id: "discover", labelKey: "navigation.discover", placement: "primary" },
  { id: "multiplayer", labelKey: "navigation.multiplayer", placement: "primary", capability: "multiplayer" },
  { id: "downloads", labelKey: "navigation.downloads", placement: "utility" },
  { id: "accounts", labelKey: "navigation.accounts", placement: "utility" },
  { id: "settings", labelKey: "navigation.settings", placement: "utility" },
] as const);

export const instanceTabRegistry = createRegistry([
  { id: "overview", labelKey: "instance.tab.overview", placement: "contextual" },
  { id: "content", labelKey: "instance.tab.content", placement: "contextual" },
  { id: "worlds", labelKey: "instance.tab.worlds", placement: "contextual" },
  { id: "logs", labelKey: "instance.tab.logs", placement: "contextual" },
  { id: "settings", labelKey: "instance.tab.settings", placement: "contextual" },
] as const);

export const settingsSectionRegistry = createRegistry([
  { id: "general", labelKey: "settings.section.general" },
  { id: "appearance", labelKey: "settings.section.appearance" },
  { id: "game", labelKey: "settings.section.game" },
  { id: "java", labelKey: "settings.section.java" },
  { id: "downloads", labelKey: "settings.section.downloads" },
  { id: "about", labelKey: "settings.section.about" },
] as const);

export const resourceTypeRegistry = createRegistry([
  { id: "mod", labelKey: "discover.type.mod" },
  { id: "resourcepack", labelKey: "discover.type.resourcepack" },
  { id: "shader", labelKey: "discover.type.shader" },
  { id: "modpack", labelKey: "discover.type.modpack" },
] as const);

export const downloadKindRegistry = createRegistry([
  { id: "install", labelKey: "tasks.kind.install" },
  { id: "resource", labelKey: "tasks.kind.resource" },
  { id: "modpack", labelKey: "tasks.kind.modpack" },
  { id: "java", labelKey: "tasks.kind.java" },
  { id: "server", labelKey: "tasks.kind.server" },
  { id: "unknown", labelKey: "tasks.kind.unknown" },
] as const);

export const downloadStageRegistry = createRegistry([
  { id: "queued", labelKey: "tasks.stage.queued" },
  { id: "download", labelKey: "tasks.stage.download" },
  { id: "verify", labelKey: "tasks.stage.verify" },
  { id: "install", labelKey: "tasks.stage.install" },
  { id: "metadata", labelKey: "tasks.stage.metadata" },
  { id: "loader-libraries", labelKey: "tasks.stage.loader-libraries" },
  { id: "loader-installer", labelKey: "tasks.stage.loader-installer" },
  { id: "java-runtime", labelKey: "tasks.stage.java-runtime" },
  { id: "resource-preflight", labelKey: "tasks.stage.resource-preflight" },
  { id: "resource-loader", labelKey: "tasks.stage.resource-loader" },
  { id: "resource-create", labelKey: "tasks.stage.resource-create" },
  { id: "resource-plan", labelKey: "tasks.stage.resource-plan" },
  { id: "resource-download", labelKey: "tasks.stage.resource-download" },
  { id: "resource-commit", labelKey: "tasks.stage.resource-commit" },
  { id: "complete", labelKey: "tasks.stage.complete" },
  { id: "paused", labelKey: "tasks.stage.paused" },
  { id: "failed", labelKey: "tasks.stage.failed" },
  { id: "cancelled", labelKey: "tasks.stage.cancelled" },
  { id: "interrupted", labelKey: "tasks.stage.interrupted" },
  { id: "unknown", labelKey: "tasks.stage.unknown" },
] as const);
