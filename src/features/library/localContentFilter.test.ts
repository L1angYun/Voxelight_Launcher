// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import type { LocalModMetadata, LocalResource } from "./types";
import { displayName, resourceCounts, visibleResources, type LocalContentFilter } from "./localContentFilter";

type ResourceOptions = Omit<Partial<LocalResource>, "metadata"> & { metadata?: Partial<LocalModMetadata> };

function resource(name: string, options: ResourceOptions = {}): LocalResource {
  const { metadata, ...rest } = options;
  const fileName = rest.fileName ?? `${name}.jar`;
  const defaults: LocalModMetadata = {
    loader: "fabric",
    modId: name.toLocaleLowerCase(),
    name,
    version: "1.0.0",
    description: "",
    authors: [],
    hasIcon: false,
    dependencies: [],
    additionalMods: 0,
  };
  return {
    name,
    fileName,
    path: `mods/${fileName}`,
    enabled: true,
    size: 0,
    ...rest,
    metadata: metadata ? { ...defaults, ...metadata } : undefined,
  };
}

function names(files: readonly LocalResource[], filter: Partial<LocalContentFilter> = {}): string[] {
  return visibleResources(files, { query: "", state: "all", sort: "name", ...filter }).map((file) => file.fileName);
}

describe("visibleResources", () => {
  it("matches the displayed metadata name and falls back to the file name", () => {
    const files = [
      resource("A.jar", { fileName: "a.jar", metadata: { name: "Copper Lantern" } }),
      resource("Fallback Display", { fileName: "fallback.jar" }),
      resource("Other.jar", { fileName: "other.jar", metadata: { name: "Something Else" } }),
    ];
    expect(names(files, { query: "copper" })).toEqual(["a.jar"]);
    expect(names(files, { query: "fallback disp" })).toEqual(["fallback.jar"]);
    expect(displayName(files[0])).toBe("Copper Lantern");
  });

  it("matches the file name, mod id, version, authors and dependency ids case-insensitively", () => {
    const files = [
      resource("Example Mod", {
        fileName: "example-mod-4.5.6.jar",
        metadata: {
          modId: "example_core",
          version: "4.5.6",
          authors: ["Alice", "Bob"],
          dependencies: [{ id: "fabric_api", kind: "required", range: ">=0.1" }],
        },
      }),
      resource("Unrelated", { fileName: "unrelated.jar", metadata: { modId: "other_core", version: "1.0.0", authors: ["Carol"] } }),
    ];
    expect(names(files, { query: "EXAMPLE-MOD" })).toEqual(["example-mod-4.5.6.jar"]);
    expect(names(files, { query: "example_core" })).toEqual(["example-mod-4.5.6.jar"]);
    expect(names(files, { query: "4.5.6" })).toEqual(["example-mod-4.5.6.jar"]);
    expect(names(files, { query: "alice" })).toEqual(["example-mod-4.5.6.jar"]);
    expect(names(files, { query: "FABRIC_API" })).toEqual(["example-mod-4.5.6.jar"]);
  });

  it("trims the query and treats a blank query as no filter", () => {
    const files = [resource("Alpha"), resource("Beta")];
    expect(names(files, { query: "  BETA  " })).toEqual(["Beta.jar"]);
    expect(names(files, { query: "   " })).toEqual(["Alpha.jar", "Beta.jar"]);
    expect(visibleResources(files, { query: "", state: "all", sort: "name" })).toHaveLength(2);
  });

  it("filters by enabled state", () => {
    const files = [resource("Alpha", { enabled: true }), resource("Beta", { enabled: false }), resource("Gamma", { enabled: false })];
    expect(names(files, { state: "all" })).toEqual(["Alpha.jar", "Beta.jar", "Gamma.jar"]);
    expect(names(files, { state: "enabled" })).toEqual(["Alpha.jar"]);
    expect(names(files, { state: "disabled" })).toEqual(["Beta.jar", "Gamma.jar"]);
  });

  it("combines the search with the state filter", () => {
    const files = [
      resource("Alpha", { enabled: true, metadata: { authors: ["Alice"] } }),
      resource("Beta", { enabled: false, metadata: { authors: ["Alice"] } }),
      resource("Gamma", { enabled: true }),
    ];
    expect(names(files, { query: "alice", state: "disabled" })).toEqual(["Beta.jar"]);
  });

  it("sorts names A to Z with a locale-aware comparison and breaks name ties by file name", () => {
    const files = [resource("Zeta"), resource("alpha"), resource("Beta"), resource("Same", { fileName: "z.jar" }), resource("Same", { fileName: "a.jar" })];
    expect(names(files)).toEqual(["alpha.jar", "Beta.jar", "a.jar", "z.jar", "Zeta.jar"]);
  });

  it("sorts by size, largest first, with equal sizes in name order", () => {
    const files = [
      resource("Zeta", { size: 100 }),
      resource("Alpha", { size: 100 }),
      resource("Beta", { size: 50 }),
      resource("Gamma", { size: 0 }),
    ];
    expect(names(files, { sort: "size" })).toEqual(["Alpha.jar", "Zeta.jar", "Beta.jar", "Gamma.jar"]);
  });

  it("sorts by modified time, newest first, with equal times in name order and missing times last", () => {
    const files = [
      resource("Zeta", { modifiedMs: 100 }),
      resource("Beta", { modifiedMs: 300 }),
      resource("Alpha", { modifiedMs: 300 }),
      resource("Gamma"),
    ];
    expect(names(files, { sort: "modified" })).toEqual(["Alpha.jar", "Beta.jar", "Zeta.jar", "Gamma.jar"]);
  });

  it("does not mutate the input array", () => {
    const files = [resource("Zeta"), resource("Alpha")];
    const before = [...files];
    visibleResources(files, { query: "", state: "all", sort: "name" });
    expect(files).toEqual(before);
  });
});

describe("resourceCounts", () => {
  const files = [
    resource("Alpha", { enabled: true }),
    resource("Beta", { enabled: true, metadata: { authors: ["Alice"] } }),
    resource("Gamma", { enabled: false }),
  ];

  it("counts every state after the search, before the state filter", () => {
    expect(resourceCounts(files, "")).toEqual({ all: 3, enabled: 2, disabled: 1 });
    expect(resourceCounts(files, "  alpha ")).toEqual({ all: 1, enabled: 1, disabled: 0 });
    expect(resourceCounts(files, "ALICE")).toEqual({ all: 1, enabled: 1, disabled: 0 });
    expect(resourceCounts(files, "gamma")).toEqual({ all: 1, enabled: 0, disabled: 1 });
    expect(resourceCounts(files, "nothing")).toEqual({ all: 0, enabled: 0, disabled: 0 });
  });
});
