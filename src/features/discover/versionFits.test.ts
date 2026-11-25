import { describe, expect, it } from "vitest";
import { instancesFitting, type FittableInstance } from "./versionFits";
import type { ResourceVersion } from "./types";

const fabricProfile = "fabric-loader-0.16.9-1.21.1";
const forgeProfile = "1.20.1-forge-47.2.0";
const neoforgeProfile = "neoforge-21.1.77";
const quiltProfile = "quilt-loader-0.27.0-1.21.1";

function instance(
  id: string,
  versionId: string,
  gameVersion: string | undefined,
  loader: string | null | undefined,
  name = `Instance ${id}`,
): FittableInstance {
  return { id, name, versionId, gameVersion, loader };
}

function version(gameVersions: string[], loaders: string[]): ResourceVersion {
  return {
    id: "version-fixture",
    name: "Version fixture",
    versionNumber: "1.0",
    datePublished: "2026-01-01T00:00:00Z",
    gameVersions,
    loaders,
    compatible: true,
  };
}

describe("instancesFitting", () => {
  it("matches loader profiles by their resolved game version, not their profile id", () => {
    const fabric = instance("fabric", fabricProfile, "1.21.1", "fabric");
    const forge = instance("forge", forgeProfile, "1.20.1", "forge");
    const neo = instance("neo", neoforgeProfile, "1.21.1", "neoforge");
    expect(instancesFitting(version(["1.21.1"], ["fabric"]), [fabric, forge, neo], "mod")).toEqual([fabric]);
    expect(instancesFitting(version(["1.20.1"], ["forge"]), [fabric, forge, neo], "mod")).toEqual([forge]);
    expect(instancesFitting(version(["1.21.1"], ["neoforge"]), [fabric, forge, neo], "mod")).toEqual([neo]);
  });

  it("never uses the stored profile id as the game version", () => {
    const profileIdLooksLikeGame = instance("plain", "1.21.1", "1.20.1", "fabric");
    const resolvedLegacy = instance("legacy", fabricProfile, "1.21.1", "fabric");
    expect(instancesFitting(version(["1.21.1"], ["fabric"]), [profileIdLooksLikeGame], "mod")).toEqual([]);
    expect(instancesFitting(version(["1.21.1"], ["fabric"]), [resolvedLegacy], "mod")).toEqual([resolvedLegacy]);
  });

  it("does not fit an instance whose context could not be resolved", () => {
    const missing = instance("missing", "1.21.1", undefined, undefined);
    expect(instancesFitting(version(["1.21.1"], ["fabric"]), [missing], "mod")).toEqual([]);
    expect(instancesFitting(version(["1.21.1"], ["fabric"]), [missing], "resourcepack")).toEqual([]);
  });

  it("matches mod loaders case-insensitively", () => {
    const lower = instance("lower", fabricProfile, "1.21.1", "fabric");
    const upper = instance("upper", fabricProfile, "1.21.1", "FABRIC");
    const mixed = instance("mixed", quiltProfile, "1.21.1", "QuIlT");
    const otherLoader = instance("other-loader", forgeProfile, "1.21.1", "forge");
    expect(instancesFitting(version(["1.21.1"], ["FaBrIc"]), [lower, upper, otherLoader], "mod"))
      .toEqual([lower, upper]);
    expect(instancesFitting(version(["1.21.1"], ["quilt"]), [mixed], "mod"))
      .toEqual([mixed]);
  });

  it("ignores the loader for resource packs and shaders", () => {
    const vanilla = instance("vanilla", "1.21.1", "1.21.1", null);
    const forge = instance("forge", forgeProfile, "1.21.1", "forge");
    const pack = version(["1.21.1"], ["fabric"]);
    expect(instancesFitting(pack, [vanilla, forge], "resourcepack")).toEqual([vanilla, forge]);
    expect(instancesFitting(pack, [vanilla, forge], "shader")).toEqual([vanilla, forge]);
  });

  it("ignores the loader for data packs", () => {
    const vanilla = instance("vanilla", "1.21.1", "1.21.1", null);
    const quilt = instance("quilt", quiltProfile, "1.21.1", "quilt");
    expect(instancesFitting(version(["1.21.1"], ["fabric"]), [vanilla, quilt], "datapack"))
      .toEqual([vanilla, quilt]);
  });

  it("never fits a vanilla instance to a mod", () => {
    const vanilla = instance("vanilla", "1.21.1", "1.21.1", null);
    const emptyLoader = instance("empty", "1.21.1", "1.21.1", "");
    const fabric = instance("fabric", fabricProfile, "1.21.1", "fabric");
    expect(instancesFitting(version(["1.21.1"], ["fabric", "vanilla"]), [vanilla, emptyLoader, fabric], "mod"))
      .toEqual([fabric]);
    expect(instancesFitting(version(["1.21.1"], ["vanilla"]), [vanilla], "mod")).toEqual([]);
  });

  it("keeps Quilt and Fabric separate like the existing target planner", () => {
    const quilt = instance("quilt", quiltProfile, "1.21.1", "quilt");
    const fabric = instance("fabric", fabricProfile, "1.21.1", "fabric");
    expect(instancesFitting(version(["1.21.1"], ["fabric"]), [quilt, fabric], "mod")).toEqual([fabric]);
    expect(instancesFitting(version(["1.21.1"], ["quilt"]), [quilt, fabric], "mod")).toEqual([quilt]);
  });

  it("never fits a modpack to an existing instance", () => {
    const fabric = instance("fabric", fabricProfile, "1.21.1", "fabric");
    const vanilla = instance("vanilla", "1.21.1", "1.21.1", null);
    expect(instancesFitting(version(["1.21.1"], ["fabric"]), [fabric, vanilla], "modpack")).toEqual([]);
  });

  it("returns no instance when the launcher has none", () => {
    expect(instancesFitting(version(["1.21.1"], ["fabric"]), [], "mod")).toEqual([]);
  });
});
