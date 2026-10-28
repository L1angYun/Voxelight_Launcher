import { describe, expect, it } from "vitest";
import {
  createRegistry,
  downloadKindRegistry,
  downloadStageRegistry,
  instanceTabRegistry,
  navigationRegistry,
  resourceTypeRegistry,
  settingsSectionRegistry,
} from "./registry";

describe("feature registries", () => {
  it("keeps feature IDs stable and hides unavailable capabilities", () => {
    expect(instanceTabRegistry.ids()).toEqual([
      "overview",
      "content",
      "worlds",
      "logs",
      "settings",
    ]);
    expect(navigationRegistry.ids()).not.toContain("comingSoon");
    expect(navigationRegistry.enabled({ multiplayer: false }).map((item) => item.id)).not.toContain(
      "multiplayer",
    );
    expect(downloadKindRegistry.get("resource").labelKey).toBe("tasks.kind.resource");
    expect(downloadStageRegistry.get("download").labelKey).toBe("tasks.stage.download");
    expect(resourceTypeRegistry.get("modpack").labelKey).toBe("discover.type.modpack");
    expect(settingsSectionRegistry.get("appearance").labelKey).toBe("settings.section.appearance");
  });

  it("rejects duplicate IDs before a page can register them", () => {
    expect(() =>
      createRegistry([
        { id: "duplicate", labelKey: "one" },
        { id: "duplicate", labelKey: "two" },
      ]),
    ).toThrow("Duplicate registry id: duplicate");
  });
});
