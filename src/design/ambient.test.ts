import { describe, expect, it } from "vitest";
import { ACCENT_PRESETS } from "./accentPresets";
import { AMBIENT_PRESETS } from "./ambientPresets";
import { deriveAmbientPalette, resolveAmbientPalette } from "./ambient";

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/;

describe("ambient presets", () => {
  it("aligns 1:1 with all 11 accent preset IDs", () => {
    const accentIds = ACCENT_PRESETS.map((preset) => preset.id).sort();
    const ambientIds = Object.keys(AMBIENT_PRESETS).sort();
    expect(ambientIds).toHaveLength(11);
    expect(ambientIds).toEqual(accentIds);
  });

  it("provides 4 valid #rrggbb colors for both dark and light themes on every preset", () => {
    for (const [id, palettes] of Object.entries(AMBIENT_PRESETS)) {
      for (const theme of ["dark", "light"] as const) {
        expect(palettes[theme], `${id}.${theme}`).toHaveLength(4);
        for (const color of palettes[theme]) {
          expect(color, `${id}.${theme}`).toMatch(HEX_COLOR_RE);
        }
      }
    }
  });
});

describe("deriveAmbientPalette", () => {
  it("matches the spec samples for default Windows blue (#0078d4)", () => {
    expect(deriveAmbientPalette("#0078d4", "dark")).toEqual([
      "#149ac2",
      "#6969be",
      "#90502b",
      "#8c5895",
    ]);
    expect(deriveAmbientPalette("#0078d4", "light")).toEqual([
      "#71cbee",
      "#a4a8e6",
      "#c9987e",
      "#cca4d3",
    ]);
  });

  it("derives valid 4-color palettes for neutral inputs", () => {
    for (const neutral of ["#808080", "#000000", "#ffffff"]) {
      for (const theme of ["dark", "light"] as const) {
        const palette = deriveAmbientPalette(neutral, theme);
        expect(palette).toHaveLength(4);
        for (const color of palette) {
          expect(color).toMatch(HEX_COLOR_RE);
        }
      }
    }
  });

  it("falls back to DEFAULT_ACCENT (#0078d4) for invalid hex inputs", () => {
    expect(deriveAmbientPalette("not-a-color", "dark")).toEqual(
      deriveAmbientPalette("#0078d4", "dark"),
    );
    expect(deriveAmbientPalette("", "light")).toEqual(
      deriveAmbientPalette("#0078d4", "light"),
    );
  });
});

describe("resolveAmbientPalette", () => {
  it("uses curated preset palettes when accentSource is custom and hex matches a preset", () => {
    const dianqing = ACCENT_PRESETS.find((preset) => preset.id === "dianqing")!;
    expect(
      resolveAmbientPalette({
        accentSource: "custom",
        accentColor: dianqing.hex.toUpperCase(),
        theme: "dark",
      }),
    ).toEqual(AMBIENT_PRESETS.dianqing.dark);
    expect(
      resolveAmbientPalette({
        accentSource: "custom",
        accentColor: dianqing.hex,
        theme: "light",
      }),
    ).toEqual(AMBIENT_PRESETS.dianqing.light);
  });

  it("derives dynamically when accentSource is not custom or hex is not a preset", () => {
    const dianqing = ACCENT_PRESETS.find((preset) => preset.id === "dianqing")!;
    expect(
      resolveAmbientPalette({
        accentSource: "system",
        accentColor: dianqing.hex,
        theme: "dark",
      }),
    ).toEqual(deriveAmbientPalette(dianqing.hex, "dark"));
    expect(
      resolveAmbientPalette({
        accentSource: "custom",
        accentColor: "#336699",
        theme: "light",
      }),
    ).toEqual(deriveAmbientPalette("#336699", "light"));
  });
});
