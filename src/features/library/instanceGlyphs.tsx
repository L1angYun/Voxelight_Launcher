// SPDX-License-Identifier: GPL-3.0-only
import { APRIL_FOOLS_IDS } from "./versionCatalog";

export type GlyphLoader = "vanilla" | "fabric" | "quilt" | "forge" | "neoforge" | "optifine" | "unknown";
export type GlyphVersion = "release" | "snapshot" | "old";

/** The cube is authored on a 48-unit grid, so the same icon stays sharp at 24, 32 and 48 px. */
export const GLYPH_VIEWBOX = 48;

/** A loader family that can be named by a version-directory id. */
type DetectedLoader = Exclude<GlyphLoader, "vanilla" | "unknown">;

/**
 * The folder ids written by the launchers. Loader names are matched as whole
 * hyphen-separated tokens, never as arbitrary substrings, so a Minecraft id
 * such as "1.21.1" cannot be mistaken for one.
 */
function loaderInVersionId(id: string): DetectedLoader | undefined {
  if (/^fabric-loader-|-fabric-/.test(id)) return "fabric";
  if (/^quilt-loader-|-quilt-/.test(id)) return "quilt";
  if (/^neoforge-|-neoforge-/.test(id)) return "neoforge";
  if (/^forge-|-forge-/.test(id)) return "forge";
  if (/(?:^|-)(?:optifine[-_])/.test(id)) return "optifine";
  return undefined;
}

/** Loader families, independent of their display casing and version suffix. */
export function glyphLoader(loader: string | null | undefined): GlyphLoader {
  const normalized = loader?.trim().toLowerCase();
  switch (normalized) {
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
    case "optifine":
      return "optifine";
    case "unknown":
      return "unknown";
  }
  // A caller may hold a full version id instead of the loader family: the
  // library does for loader-profile directories.
  return normalized ? loaderInVersionId(normalized) ?? "unknown" : "vanilla";
}

/**
 * The version-directory listing also contains loader profiles. Their ids follow
 * the same naming rules as the backend's `known_loader_profile`, plus the
 * "<mc>-<loader>-<version>" form written by other launchers.
 */
export function glyphLoaderForVersionDirectory(versionId: string): GlyphLoader {
  return loaderInVersionId(versionId.trim().toLowerCase()) ?? "vanilla";
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

export type GlyphPoint = readonly [x: number, y: number];
export type GlyphFaceTone = "top" | "left" | "right";

export interface GlyphFace {
  readonly tone: GlyphFaceTone;
  readonly points: readonly GlyphPoint[];
}

export interface GlyphHighlight {
  readonly tone: "top" | "left";
  readonly points: readonly GlyphPoint[];
}

export interface GlyphGeometry {
  readonly faces: readonly GlyphFace[];
  readonly highlights: readonly GlyphHighlight[];
  /** Centres of the 3x3 dotted lattice on the top face. */
  readonly dots: readonly GlyphPoint[];
  /** The quarter-size corner step, or null for a full cube. */
  readonly notch: readonly GlyphPoint[] | null;
  /** The lit inner edge of the notch, when the notch exists. */
  readonly notchEdge: readonly GlyphPoint[] | null;
}

// A centred 36x32 isometric cube. Every point is a whole viewBox unit, and the
// faces are ordered top (lightest), left (mid), right (darkest).
const TOP_FACE: readonly GlyphPoint[] = [[24, 8], [42, 16], [24, 24], [6, 16]];
const LEFT_FACE: readonly GlyphPoint[] = [[6, 16], [24, 24], [24, 40], [6, 32]];
const RIGHT_FACE: readonly GlyphPoint[] = [[24, 24], [42, 16], [42, 32], [24, 40]];

// One pixel inside the top silhouette and the left silhouette edge.
const TOP_HIGHLIGHT: readonly GlyphPoint[] = [[7, 16], [24, 9], [41, 16]];
const LEFT_HIGHLIGHT: readonly GlyphPoint[] = [[7, 17], [7, 31]];

// The front quarter of the top face, snapped to whole units: a step whose
// 18x8 diagonal is exactly a quarter of the 36x16 top face.
const SNAPSHOT_NOTCH: readonly GlyphPoint[] = [[24, 24], [33, 20], [24, 16], [15, 20]];
const SNAPSHOT_TOP_FACE: readonly GlyphPoint[] = [[24, 8], [42, 16], [33, 20], [24, 16], [15, 20], [6, 16]];
const SNAPSHOT_NOTCH_EDGE: readonly GlyphPoint[] = [[33, 20], [24, 16], [15, 20]];

/** The dotted lattice follows the top face's two axes, rounded to whole units. */
const DOTS: readonly GlyphPoint[] = Array.from({ length: 9 }, (_, index) => {
  const row = Math.floor(index / 3), column = index % 3;
  return [24 + 6 * (row - column), Math.round(8 + (8 * (row + column + 1)) / 3)] as const;
});

/** Pure cube geometry, so the visual contract can be asserted without a DOM. */
export function glyphGeometry(version: GlyphVersion): GlyphGeometry {
  const snapshot = version === "snapshot";
  return {
    faces: [
      { tone: "top", points: snapshot ? SNAPSHOT_TOP_FACE : TOP_FACE },
      { tone: "left", points: LEFT_FACE },
      { tone: "right", points: RIGHT_FACE },
    ],
    highlights: [
      { tone: "top", points: TOP_HIGHLIGHT },
      { tone: "left", points: LEFT_HIGHLIGHT },
    ],
    dots: DOTS,
    notch: snapshot ? SNAPSHOT_NOTCH : null,
    notchEdge: snapshot ? SNAPSHOT_NOTCH_EDGE : null,
  };
}

function pointsAttribute(points: readonly GlyphPoint[]) {
  return points.map(([x, y]) => `${x},${y}`).join(" ");
}

/** A decorative voxel cube; the card's visible text names the version and loader. */
export function InstanceGlyph({ loader, version }: { loader: GlyphLoader; version: GlyphVersion }) {
  const geometry = glyphGeometry(version);
  return (
    <svg
      className="vx-instance-glyph"
      viewBox={`0 0 ${GLYPH_VIEWBOX} ${GLYPH_VIEWBOX}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
      data-glyph-loader={loader}
      data-glyph-version={version}
    >
      {geometry.faces.map((face) => (
        <polygon
          key={face.tone}
          className="vx-instance-glyph__face"
          data-face={face.tone}
          points={pointsAttribute(face.points)}
          fill={`var(--vx-glyph-face-${face.tone})`}
        />
      ))}
      {geometry.dots.map(([x, y]) => (
        <rect
          key={`dot:${x}:${y}`}
          className="vx-instance-glyph__dot"
          x={x - 1}
          y={y - 1}
          width={2}
          height={2}
          fill="var(--vx-glyph-dot)"
          fillOpacity={0.35}
        />
      ))}
      {geometry.notch ? (
        <polygon
          className="vx-instance-glyph__notch"
          points={pointsAttribute(geometry.notch)}
          fill="var(--vx-glyph-notch)"
        />
      ) : null}
      {geometry.highlights.map((highlight) => (
        <polyline
          key={highlight.tone}
          className="vx-instance-glyph__highlight"
          data-highlight={highlight.tone}
          points={pointsAttribute(highlight.points)}
          fill="none"
          stroke={`var(--vx-glyph-highlight-${highlight.tone})`}
          strokeWidth={1}
          strokeLinecap="square"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {geometry.notchEdge ? (
        <polyline
          className="vx-instance-glyph__notch-edge"
          points={pointsAttribute(geometry.notchEdge)}
          fill="none"
          stroke="var(--vx-glyph-highlight-top)"
          strokeWidth={1}
          strokeLinecap="square"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
    </svg>
  );
}
