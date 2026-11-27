import { describe, expect, it } from "vitest";
import { createLauncherI18n } from "../../i18n";
import { loaderDisplayName } from "./utils";

describe("loaderDisplayName", () => {
  it("translates vanilla and a missing loader, and keeps product names", async () => {
    const i18n = createLauncherI18n("zh-CN", "zh-CN");
    await i18n.initPromise;
    const t = i18n.t.bind(i18n);
    expect(loaderDisplayName(undefined, t)).toBe("原版");
    expect(loaderDisplayName(null, t)).toBe("原版");
    expect(loaderDisplayName("", t)).toBe("原版");
    expect(loaderDisplayName("vanilla", t)).toBe("原版");
    expect(loaderDisplayName("Vanilla", t)).toBe("原版");
    expect(loaderDisplayName("fabric", t)).toBe("Fabric");
    expect(loaderDisplayName("neoforge", t)).toBe("NeoForge");
    expect(loaderDisplayName("optifine", t)).toBe("OptiFine");
    expect(loaderDisplayName("someloader", t)).toBe("someloader");
  });

  it("uses the English name in English", async () => {
    const i18n = createLauncherI18n("en-US", "en-US");
    await i18n.initPromise;
    expect(loaderDisplayName("vanilla", i18n.t.bind(i18n))).toBe("Vanilla");
  });
});
