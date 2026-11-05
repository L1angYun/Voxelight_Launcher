// SPDX-License-Identifier: GPL-3.0-only
import type { Page } from "@playwright/test";

export interface WorldUniformSample {
  atMs: number; worldFrames: number; contextId: number; voxelProgramId: number; terrainProgramId: number;
  uLat: number; uCry: number; uIsland: number; uT: number;
  writes: { uLat: number; uCry: number; uIsland: number; uT: number };
}

type UniformProbeWindow = Window & { __voxelightWorldUniformProbe?: { read(): WorldUniformSample } };

/** Self-contained so Playwright and the boundary tests serialize the same installer. */
export function installWorldUniformProbeInBrowser(): void {
  const host = window as UniformProbeWindow;
  if (host.__voxelightWorldUniformProbe) return;
  if (typeof WebGL2RenderingContext === "undefined") throw new Error("World uniform probe requires WebGL2");

  type Key = "uLat" | "uCry" | "uIsland" | "uT";
  interface ProgramState {
    id: number; program: WebGLProgram; owner: ContextState;
    locations: Map<string, WebGLUniformLocation | null>;
    writes: Partial<Record<Key, number>>; retired: boolean;
  }
  interface ContextState {
    id: number; gl: WebGL2RenderingContext; lost: boolean;
    programs: Map<WebGLProgram, ProgramState>;
  }
  const proto = WebGL2RenderingContext.prototype;
  const locate = proto.getUniformLocation, submit = proto.uniform1f;
  const unlink = proto.deleteProgram, link = proto.linkProgram;
  const getUniform = proto.getUniform;
  const contexts = new Map<WebGL2RenderingContext, ContextState>();
  const locations = new WeakMap<WebGLUniformLocation, { state: ProgramState; name: string }>();
  let nextContextId = 0, nextProgramId = 0, writeSerial = 0;
  const isWorld = (gl: WebGL2RenderingContext) => gl.canvas instanceof HTMLCanvasElement
    && gl.canvas.matches(".world-scene__canvas");
  function contextFor(gl: WebGL2RenderingContext): ContextState {
    let state = contexts.get(gl);
    if (!state) {
      state = { id: ++nextContextId, gl, lost: gl.isContextLost(), programs: new Map() };
      contexts.set(gl, state);
      const owner = state;
      const invalidate = (lost: boolean) => {
        for (const program of owner.programs.values()) program.retired = true;
        owner.programs.clear(); owner.lost = lost; owner.id = ++nextContextId;
      };
      gl.canvas.addEventListener("webglcontextlost", () => invalidate(true));
      gl.canvas.addEventListener("webglcontextrestored", () => invalidate(false));
    }
    return state;
  }
  function retire(gl: WebGL2RenderingContext, program: WebGLProgram | null): void {
    if (!program) return;
    const owner = contexts.get(gl), state = owner?.programs.get(program);
    if (state) state.retired = true;
    owner?.programs.delete(program);
  }
  proto.getUniformLocation = function(program, name) {
    const location = locate.call(this, program, name);
    if (isWorld(this)) {
      const owner = contextFor(this);
      let state = owner.programs.get(program);
      if (!state) {
        state = { id: ++nextProgramId, program, owner, locations: new Map(), writes: {}, retired: false };
        owner.programs.set(program, state);
      }
      state.locations.set(name, location);
      if (location) locations.set(location, { state, name });
    }
    return location;
  };
  proto.uniform1f = function(location, supplied) {
    const result = submit.call(this, location, supplied);
    const entry = location ? locations.get(location) : undefined;
    if (entry && (entry.name === "uLat" || entry.name === "uCry" || entry.name === "uIsland" || entry.name === "uT")
      && isWorld(this) && entry.state.owner.gl === this && !entry.state.retired
      && !entry.state.owner.lost && !this.isContextLost()
      && this.getParameter(this.CURRENT_PROGRAM) === entry.state.program) {
      entry.state.writes[entry.name] = ++writeSerial;
    }
    return result;
  };
  proto.deleteProgram = function(program) {
    const result = unlink.call(this, program); retire(this, program); return result;
  };
  proto.linkProgram = function(program) {
    const result = link.call(this, program); retire(this, program); return result;
  };

  host.__voxelightWorldUniformProbe = {
    read() {
      const canvases = document.querySelectorAll<HTMLCanvasElement>(".world-scene__canvas");
      if (canvases.length !== 1 || !canvases[0].isConnected) throw new Error("World uniform probe requires one connected world canvas");
      const canvas = canvases[0];
      const owners = [...contexts.values()].filter(owner => owner.gl.canvas === canvas);
      if (owners.length !== 1) throw new Error("World uniform context is unavailable or ambiguous");
      const owner = owners[0], gl = owner.gl;
      if (owner.lost || gl.isContextLost()) throw new Error("World uniform context is lost");
      const worldFrames = Number(canvas.closest<HTMLElement>(".world-scene")?.dataset.worldFrames);
      if (!Number.isSafeInteger(worldFrames) || worldFrames < 1) throw new Error("World uniform submission counter is unavailable");
      const select = (label: string, signature: string[]) => {
        const candidates = [...owner.programs.values()].filter(state => !state.retired
          && gl.isProgram(state.program) && gl.getProgramParameter(state.program, gl.LINK_STATUS)
          && signature.every(name => state.locations.get(name)));
        // A newly observed matching generation must not fall back to a complete
        // old generation while the new uniforms are still missing.
        candidates.sort((a, b) => b.id - a.id);
        if (!candidates.length) throw new Error(`World ${label} uniform program is unavailable`);
        return candidates[0];
      };
      const voxel = select("voxel", ["uField", "uVP", "uCharge"]);
      const terrain = select("terrain", ["uPrev", "uProfile", "uT"]);
      const value = (state: ProgramState, key: Key): number => {
        const location = state.locations.get(key);
        if (!location || !state.writes[key]) throw new Error(`World uniform ${key} is missing or incomplete`);
        // This reads the applied GPU float after any clock-pin wrapper. Reading
        // supplied arguments would depend on unspecified init-script ordering.
        const actual = getUniform.call(gl, state.program, location) as unknown;
        if (typeof actual !== "number" || !Number.isFinite(actual)) throw new Error(`World uniform ${key} is not finite`);
        return actual;
      };
      return { atMs: performance.now(), worldFrames, contextId: owner.id,
        voxelProgramId: voxel.id, terrainProgramId: terrain.id,
        uLat: value(voxel, "uLat"), uCry: value(voxel, "uCry"), uIsland: value(voxel, "uIsland"), uT: value(terrain, "uT"),
        writes: { uLat: voxel.writes.uLat!, uCry: voxel.writes.uCry!, uIsland: voxel.writes.uIsland!, uT: terrain.writes.uT! } };
    },
  };
}

export async function installWorldUniformProbe(page: Page): Promise<void> {
  await page.addInitScript(installWorldUniformProbeInBrowser);
}

/** Self-contained page.evaluate callback; freshness is compared by the caller. */
export function readWorldUniformProbe(): WorldUniformSample {
  const probe = (window as UniformProbeWindow).__voxelightWorldUniformProbe;
  if (!probe) throw new Error("World uniform probe was not installed before navigation");
  return probe.read();
}
