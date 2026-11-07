import { describe, expect, it } from "vitest";
import { createLauncherI18n } from "../i18n";
import {
  createRegistry,
  downloadKindRegistry,
  downloadStageRegistry,
  instanceTabRegistry,
  navigationRegistry,
  resourceTypeRegistry,
  settingsSectionRegistry,
  type Registry,
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

  const combinedStages = [
    ["resource-preflight", "Checking required dependencies", "检查必需前置"],
    ["resource-loader", "Installing Minecraft and loader", "安装 Minecraft 和加载器"],
    ["resource-create", "Creating instance", "创建实例"],
    ["resource-plan", "Planning resource installation", "规划资源安装"],
    ["resource-download", "Downloading content", "下载资源"],
    ["resource-commit", "Installing verified content", "安装已校验资源"],
    ["metadata", "Reading version metadata", "读取版本元数据"],
    ["loader-libraries", "Verifying loader libraries", "校验加载器依赖"],
    ["loader-installer", "Running loader installer", "运行加载器安装器"],
    ["java-runtime", "Installing Java runtime", "安装 Java 运行时"],
  ] as const;

  it.each(combinedStages)("labels the combined resource stage %s in both supported languages", async (stage, english, chinese) => {
    const stages: Registry = downloadStageRegistry;
    expect(stages.ids()).toContain(stage);
    for (const [language, expected] of [["en-US", english], ["zh-CN", chinese]] as const) {
      const i18n = createLauncherI18n(language, language);
      await i18n.initPromise;
      expect(i18n.t(stages.get(stage).labelKey, { ns: "downloads" })).toBe(expected);
    }
  });
});
