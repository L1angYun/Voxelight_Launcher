// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { POINT_VERTEX } from "./shaders";

// Frozen from main@843e682 before the light-only ridge change. Reducing the
// new light term to zero must recover the entire original vertex program,
// including fog, opacity, clamp floor, crystal logic and point projection.
const ORIGINAL_DARK_POINT_SHA256 = "056e7636b0ae44f6b6bb9788ada151620091f39706ddcd86e41ea12d037bff4e";

describe("light horizon ridge isolation", () => {
  it("restricts ridge ink to light home horizon terrain at far crest heights", () => {
    expect(POINT_VERTEX).toMatch(/uniform float [^;]*uHome, uLight;/);
    const ridge = POINT_VERTEX.match(/float ridge = ([^;]+);/)?.[1];
    expect(ridge?.replace(/\s/g, "")).toBe(
      "uLight*uHome*(1.-uMask)*(1.-P.w)*smoothstep(6.,18.,h)*smoothstep(80.,130.,dist)",
    );
  });

  it("increases only ridge point size with the measured airy gain", () => {
    const size = POINT_VERTEX.match(/gl_PointSize = ([^;]+);/)?.[1];
    expect(size).toMatch(/\* \(1\. \+ 0\.75 \* ridge\)$/);
  });

  it("recovers the byte-identical original dark program when the light ridge is zero", () => {
    const dark = POINT_VERTEX
      .replace(", uHome, uLight;", ", uHome;")
      .replace(/^  float ridge = [^;]+;\n/m, "")
      .replace(" * (1. + 0.75 * ridge);", ";");
    expect(createHash("sha256").update(dark).digest("hex")).toBe(ORIGINAL_DARK_POINT_SHA256);
  });
});
