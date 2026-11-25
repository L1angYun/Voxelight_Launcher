// SPDX-License-Identifier: GPL-3.0-only
import { APRIL_FOOLS_IDS } from "./versionCatalog";

export type GlyphLoader = "vanilla" | "fabric" | "quilt" | "forge" | "neoforge" | "unknown";
export type GlyphVersion = "release" | "snapshot" | "old";

/** Loader families, independent of their display casing and version suffix. */
export function glyphLoader(loader: string | null | undefined): GlyphLoader {
  switch (loader?.trim().toLowerCase()) {
    case undefined:
    case "":
    case "vanilla":
    case "none":
      return "vanilla";
    case "fabric":
      return "fabric";
    case "quilt":
      return "quilt";
    case "forge":
      return "forge";
    case "neoforge":
      return "neoforge";
    default:
      return "unknown";
  }
}

/**
 * The version-directory listing also contains loader profiles. Their ids follow
 * the same naming rules as the backend's `known_loader_profile`.
 */
export function glyphLoaderForVersionDirectory(versionId: string): GlyphLoader {
  const id = versionId.trim().toLowerCase();
  if (id.startsWith("fabric-loader-")) return "fabric";
  if (id.startsWith("quilt-loader-")) return "quilt";
  if (id.startsWith("neoforge-") || id.includes("-neoforge-")) return "neoforge";
  if (id.startsWith("forge-") || id.includes("-forge-")) return "forge";
  return "vanilla";
}

/** Weekly ids may sit behind a loader prefix or carry a multi-letter suffix. */
const WEEKLY_SNAPSHOT = /(?:^|-)\d{2}w\d{2}[a-z]/i;
const PREVIEW = /(?:^|[-\s])(?:pre|rc)(?:[-\d]|$)|[-\s](?:pre-release|snapshot)(?:[-\d]|$)/i;
const OLD_ERA = /^(?:b1\.|a1\.|c0\.|inf-|rd-)/i;
const APRIL_FOOLS = [...APRIL_FOOLS_IDS].map(id => id.toLowerCase());

/** April Fools ids count as snapshots, including behind a loader profile prefix. */
function isAprilFools(id: string) {
  const lower = id.toLowerCase();
  return APRIL_FOOLS.some(value => lower === value || lower.endsWith(`-${value}`));
}

/** A manifest type is authoritative; a bare id is classified by its naming scheme. */
export function glyphVersion(versionId: string, type?: string | null): GlyphVersion {
  switch (type?.trim().toLowerCase()) {
    case "release": return "release";
    case "snapshot": return "snapshot";
    case "old_beta":
    case "old_alpha": return "old";
  }
  const id = versionId.trim();
  if (WEEKLY_SNAPSHOT.test(id) || PREVIEW.test(id) || isAprilFools(id)) return "snapshot";
  if (OLD_ERA.test(id)) return "old";
  return "release";
}

/** Pixel keys: ink, base, shade, light, accent, cold, green, warm. */
const PALETTE: Record<string, string> = {
  k: "var(--vx-glyph-ink)",
  b: "var(--vx-glyph-base)",
  s: "var(--vx-glyph-shade)",
  l: "var(--vx-glyph-light)",
  a: "var(--vx-glyph-accent)",
  c: "var(--vx-glyph-cold)",
  g: "var(--vx-glyph-green)",
  w: "var(--vx-glyph-warm)",
};

type GlyphRect = { x: number; y: number; w: number; h: number; fill: string };

/** Original 16x16 motifs; rows 0-3, columns 12-15 stay clear for a version mark. */
const MOTIFS: Record<GlyphLoader, readonly string[]> = {
  vanilla: [
    "................",
    "................",
    "................",
    "................",
    "..kkkkkkkkkkkk..",
    "..kggggggggggk..",
    "..kggggggggggk..",
    "..kggggggggggk..",
    "..kkkkkkkkkkkk..",
    "..kwbbbbbbbbwk..",
    "..kwbbbbbbbbwk..",
    "..kwbbbbssbbwk..",
    "..kwbbbbbssbwk..",
    "..kwbbbbbbbbwk..",
    "..kwbbbbbbbbwk..",
    "..kkkkkkkkkkkk..",
  ],
  fabric: [
    "................",
    "................",
    "................",
    "................",
    "...kkkkkkkkkk...",
    "..kbbbbbbbbbbk..",
    "..kabababababk..",
    "..kbbbbbbbbbbk..",
    "..kabababababk..",
    "..kbbbbbbbbbbk..",
    "..kabababababk..",
    "..kkkkkkkkkkkk..",
    "....kbbbbbbk....",
    "....kabababk....",
    "....kkkkkkkk....",
    "...w..w..w..w...",
  ],
  quilt: [
    "................",
    "................",
    "................",
    "................",
    "..kkkkkkkkkkkk..",
    "..kaaaakccccck..",
    "..kaaaalccccck..",
    "..kaaaakccccck..",
    "..kaaaalccccck..",
    "..kaaaakccccck..",
    "..kkkkkkkkkkkk..",
    "..kggggkwwwwwk..",
    "..kgggglwwwwwk..",
    "..kggggkwwwwwk..",
    "..kgggglwwwwwk..",
    "..kkkkkkkkkkkk..",
  ],
  forge: [
    "................",
    "................",
    "................",
    "................",
    "...kkkkkkkkkkk..",
    "..klllllllllllk.",
    ".kkbbbbbbbbbbbk.",
    "kkkkkkkkkkkkkkkk",
    "....kbbbbbbk....",
    "....kbbbbbbk....",
    ".....kbbbbk.....",
    ".....kbbbbk.....",
    "....kbbbbbbk....",
    "...kbbbbbbbbk...",
    "..kkkkkkkkkkkk..",
    "................",
  ],
  neoforge: [
    "................",
    "...a............",
    "..aaa...........",
    "...a............",
    "................",
    "....kkkkkkkk....",
    "...kllllllllk...",
    "...kcccccccck...",
    "..kkkkkkkkkkkk..",
    ".....kcccck.....",
    ".....kcccck.....",
    "....kcccccck....",
    "....kcccccck....",
    "...kkkkkkkkkk...",
    "................",
    "................",
  ],
  unknown: [
    "................",
    "................",
    "................",
    "................",
    "......kkkkkkkkk.",
    ".....klllllllllk",
    "....kllllllllllk",
    "...kkkkkkkkkkkkk",
    "...kbbbbbbbbssk.",
    "...kbbbbbbbbssk.",
    "...kbbbbbbbbssk.",
    "...kbbbbbbbbssk.",
    "...kbbbbbbbbssk.",
    "...kbbbbbbbbssk.",
    "...kbbbbbbbbssk.",
    "...kkkkkkkkkkk..",
  ],
};

const MARK = "var(--vx-glyph-mark)";
const OLD_MARK = "var(--vx-glyph-mark-old)";

/** Snapshot: a stepped 3x3 corner block. Old: a warm one-cell diagonal. */
const VERSION_MARKS: Record<GlyphVersion, readonly GlyphRect[]> = {
  release: [],
  snapshot: [
    { x: 13, y: 0, w: 3, h: 1, fill: MARK },
    { x: 13, y: 1, w: 3, h: 1, fill: MARK },
    { x: 14, y: 2, w: 2, h: 1, fill: MARK },
  ],
  old: [
    { x: 13, y: 0, w: 1, h: 1, fill: OLD_MARK },
    { x: 14, y: 1, w: 1, h: 1, fill: OLD_MARK },
    { x: 15, y: 2, w: 1, h: 1, fill: OLD_MARK },
  ],
};

function motifCells(rows: readonly string[]): GlyphRect[] {
  const cells: GlyphRect[] = [];
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y];
    for (let x = 0; x < row.length;) {
      const fill = PALETTE[row[x]];
      let w = 1;
      while (x + w < row.length && row[x + w] === row[x]) w++;
      if (fill) cells.push({ x, y, w, h: 1, fill });
      x += w;
    }
  }
  return cells;
}

export function InstanceGlyph({ loader, version }: { loader: GlyphLoader; version: GlyphVersion }) {
  const cells = [...motifCells(MOTIFS[loader]), ...VERSION_MARKS[version]];
  return (
    <svg
      className="vx-instance-glyph"
      viewBox="0 0 16 16"
      shapeRendering="crispEdges"
      aria-hidden="true"
      data-glyph-loader={loader}
      data-glyph-version={version}
    >
      {cells.map((cell) => (
        <rect
          key={`${cell.x}:${cell.y}:${cell.w}:${cell.h}:${cell.fill}`}
          x={cell.x}
          y={cell.y}
          width={cell.w}
          height={cell.h}
          fill={cell.fill}
        />
      ))}
    </svg>
  );
}
