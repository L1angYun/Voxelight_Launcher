export type GlassVariant = "nav" | "control" | "dialog" | "toast";
export type GlassQuality = "lite" | "full";
export type GlassMode = GlassQuality | "fallback";

export interface GlassRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Live deformation published by a moving surface; bend values are in CSS pixels, the rest are unit ranges. */
export interface GlassOptics {
  bendX: number;
  bendY: number;
  pressure: number;
  energy: number;
}

export interface GlassSurfaceModel {
  id: string;
  rect: GlassRect;
  clip?: GlassRect;
  radius: number;
  variant: GlassVariant;
  active: boolean;
  opacity: number;
  optics?: GlassOptics;
}

export interface GlassFrame {
  time: number;
  accent: string;
  motion: boolean;
  light?: boolean;
  pointer?: { x: number; y: number };
}

export interface GlassRenderer {
  readonly mode: GlassMode;
  readonly surfaceCount: number;
  upsert(surface: GlassSurfaceModel): void;
  remove(id: string): void;
  resize(width: number, height: number, dpr?: number): void;
  update(frame: GlassFrame): void;
  setQuality(quality: GlassQuality): void;
  setBackground(source: TexImageSource | null): void;
  pause(paused: boolean): void;
  dispose(): void;
}

export interface GlassScheduler {
  readonly frameCount: number;
  readonly pending: boolean;
  request(): void;
  setQuality(quality: GlassQuality): void;
  pause(paused: boolean): void;
  dispose(): void;
}
