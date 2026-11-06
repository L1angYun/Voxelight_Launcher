// SPDX-License-Identifier: GPL-3.0-only
import type { Page } from "@playwright/test";

export interface DecodedPng { width: number; height: number; pixels: Buffer; }
export function decodePng(input: Buffer): DecodedPng;
export function encodePng(input: DecodedPng): Buffer;

export interface GlassPixelReport {
  initial: {
    width: number;
    height: number;
    radius: number;
    filter: string;
    backgroundColor: string;
    backgroundImage: string;
    sourceParentClass: string;
    ancestorBackdropFilters: Array<{ className: string; filter: string }>;
  };
  maxEdgeShift: number;
  maxCenterShift: number;
  liveShift: number | null;
  liveShiftPass: boolean;
  liveOffsets: Array<{ x: number; offset: number }>;
  bevelOffsets: Array<{ x: number; offset: number }>;
  maxUniformDelta: number;
  pass: boolean;
}

export function probeGlassRefraction(page: Page, outputDirectory: string, selector?: string): Promise<GlassPixelReport>;
