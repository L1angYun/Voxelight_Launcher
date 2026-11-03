// SPDX-License-Identifier: GPL-3.0-only
import { groundHit, makeCamera, type Camera, type Vec3 } from "./camera";
import type { Tier } from "./qualityTier";
import type { WorldMaterial } from "./types";
import type { WorldFrame } from "./worldDirector";
import { buildWordTargets } from "./wordmark";
import { BLUR_FRAGMENT, COMPOSITE_FRAGMENT, FULLSCREEN_VERTEX, SKY_FRAGMENT, TERRAIN_FRAGMENT,
  THRESHOLD_FRAGMENT, VOXEL_FRAGMENT, VOXEL_VERTEX, SIMULATION_FRAGMENT, POINT_VERTEX, POINT_FRAGMENT } from "./shaders";

export type RGB = readonly [number, number, number];
export interface WorldPalette { ink: RGB; point: RGB; accent: RGB; haze: RGB; light: boolean }
export interface WorldDrawMetrics {
  cpuMs: number; gpuMs: number | null;
  /** A complete scene was submitted; a busy GPU leaves this false. */
  submitted: boolean;
  /** The points pass and final composite were submitted without a rendering failure. */
  pointsSubmitted: boolean;
}
export interface WorldRenderer {
  readonly capabilities: { webgl2: true; floatTargets: boolean };
  readonly material: WorldMaterial;
  readonly melt: number;
  resize(cssWidth: number, cssHeight: number, dpr: number): void;
  setTier(tier: Tier): void;
  setPalette(palette: WorldPalette): void;
  setAnchor(ndc: [number, number]): void;
  setPointer(ndc: [number, number] | null): void;
  press(ndc: [number, number]): void;
  release(): void;
  shock(ndc: [number, number]): void;
  draw(frame: WorldFrame, dtSeconds: number): WorldDrawMetrics;
  dispose(): void;
}
type Callbacks = { onLost(): void; onRestored(): void };
interface TimerExtension { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }
interface Target { texture: WebGLTexture; framebuffer: WebGLFramebuffer; width: number; height: number }
interface Program { program: WebGLProgram; uniforms: Map<string, WebGLUniformLocation | null> }

/** A scope owns all allocations made before a framebuffer or program can fail. */
class ResourceScope {
  private releases: (() => void)[] = [];
  own<T>(value: T | null, release: (value: T) => void): T {
    if (value === null) throw new Error("WebGL resource allocation failed");
    this.releases.push(() => release(value));
    return value;
  }
  dispose() {
    for (const release of this.releases.reverse()) release();
    this.releases = [];
  }
}
interface FieldResources { scope: ResourceScope; targets: [Target, Target]; read: number; grid: number }
interface ParticleTarget { position: WebGLTexture; velocity: WebGLTexture; framebuffer: WebGLFramebuffer }
interface ParticleResources {
  scope: ResourceScope; targets: [ParticleTarget, ParticleTarget]; word: WebGLTexture;
  simulation: Program; points: Program; side: number; read: number; initialized: boolean; wordKey: string;
}
interface SurfaceResources {
  scope: ResourceScope; scene: Target; bloom: [Target, Target];
  drawFramebuffer: WebGLFramebuffer; multisampled: boolean; width: number; height: number;
}
interface CoreResources {
  scope: ResourceScope; empty: WebGLVertexArrayObject; cubes: WebGLVertexArrayObject;
  terrain: Program; voxel: Program; sky: Program; threshold: Program; blur: Program; composite: Program;
}
const SPAN = 160;
const LATTICE_EPSILON = .01;
const OFFSET: [number, number] = [0, -46];
const SUN_LENGTH = Math.hypot(.72, .4, .16);
const SUN: RGB = [.72 / SUN_LENGTH, .4 / SUN_LENGTH, .16 / SUN_LENGTH];
const SUN_XZ_LENGTH = Math.hypot(SUN[0], SUN[2]);
const DEFAULT_PALETTE: WorldPalette = {
  ink: [7 / 255, 8 / 255, 11 / 255], point: [236 / 255, 231 / 255, 218 / 255],
  accent: [180 / 255, 241 / 255, 122 / 255], haze: [.25, .27, .32], light: false,
};
const DEFAULT_TIER: Tier = { kind: "animated", particleSide: 256, grid: 160, dprCap: 1.5, forceSolid: false };

function cubeVertices(): Float32Array {
  const faces: [Vec3, Vec3[]][] = [
    [[0, 1, 0], [[-.5, .5, -.5], [-.5, .5, .5], [.5, .5, .5], [.5, .5, -.5]]],
    [[0, 0, 1], [[-.5, -.5, .5], [.5, -.5, .5], [.5, .5, .5], [-.5, .5, .5]]],
    [[0, 0, -1], [[.5, -.5, -.5], [-.5, -.5, -.5], [-.5, .5, -.5], [.5, .5, -.5]]],
    [[1, 0, 0], [[.5, -.5, .5], [.5, -.5, -.5], [.5, .5, -.5], [.5, .5, .5]]],
    [[-1, 0, 0], [[-.5, -.5, -.5], [-.5, -.5, .5], [-.5, .5, .5], [-.5, .5, -.5]]],
  ];
  const data: number[] = [];
  for (const [normal, points] of faces) for (const index of [0, 1, 2, 0, 2, 3]) data.push(...points[index], ...normal);
  return new Float32Array(data);
}

export function createWorldRenderer(canvas: HTMLCanvasElement, callbacks: Callbacks): WorldRenderer | null {
  let context: WebGL2RenderingContext | null;
  try { context = canvas.getContext("webgl2", { alpha: false, antialias: false, preserveDrawingBuffer: false, powerPreference: "high-performance" }); }
  catch { return null; }
  if (!context) return null;
  const gl = context;
  const capabilities: { webgl2: true; floatTargets: boolean } = { webgl2: true, floatTargets: false };
  let palette = DEFAULT_PALETTE, tier = { ...DEFAULT_TIER };
  let core: CoreResources | null = null, field: FieldResources | null = null, surface: SurfaceResources | null = null;
  let particles: ParticleResources | null = null, actualMaterial: WorldMaterial = "solid";
  let cssWidth = 2, cssHeight = 2, requestedDpr = 1;
  let anchor: [number, number] = [.62, -.66], pointer: [number, number] | null = null;
  let islandOrigin: [number, number] | null = null;
  let pointerStrength = 0, pointerMovedAt = -Infinity, terrainTime = 0;
  let lastHit: [number, number] | null = null, holding = false, holdTime = 0, meltAmount = 0;
  let meltAt: [number, number] = [99999, 99999], shockAt: [number, number] = [99999, 99999];
  let pendingShock: [number, number] | null = null, shockTime = -9;
  let lost = false, terminal = false, disposed = false, lossCount = 0;
  let timer: TimerExtension | null = null;
  let pendingQueries: WebGLQuery[] = [];
  let frameFence: WebGLSync | null = null;
  let pendingSimulationDt = 0;

  function ownTexture(scope: ResourceScope) { return scope.own(gl.createTexture(), value => gl.deleteTexture(value)); }
  function ownFramebuffer(scope: ResourceScope) { return scope.own(gl.createFramebuffer(), value => gl.deleteFramebuffer(value)); }
  function ownRenderbuffer(scope: ResourceScope) { return scope.own(gl.createRenderbuffer(), value => gl.deleteRenderbuffer(value)); }
  function assertFramebuffer() {
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("Incomplete world framebuffer");
  }
  function textureStorage(texture: WebGLTexture, width: number, height: number, float: boolean, filter: number) {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, float ? gl.RGBA32F : gl.RGBA8, width, height, 0, gl.RGBA, float ? gl.FLOAT : gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  function target(scope: ResourceScope, width: number, height: number, filter: number = gl.LINEAR): Target {
    const texture = ownTexture(scope), framebuffer = ownFramebuffer(scope);
    textureStorage(texture, width, height, false, filter);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    assertFramebuffer();
    return { texture, framebuffer, width, height };
  }
  function probeFloatTargets(): boolean {
    if (!gl.getExtension("EXT_color_buffer_float")) return false;
    const scope = new ResourceScope();
    try {
      const framebuffer = ownFramebuffer(scope);
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      for (let attachment = 0; attachment < 2; attachment++) {
        const texture = ownTexture(scope);
        textureStorage(texture, 2, 2, true, gl.NEAREST);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + attachment, gl.TEXTURE_2D, texture, 0);
      }
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      return gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE && gl.getError() === gl.NO_ERROR;
    } catch { return false; }
    finally { scope.dispose(); gl.bindFramebuffer(gl.FRAMEBUFFER, null); }
  }
  function compile(type: number, source: string): WebGLShader {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("World shader allocation failed");
    try {
      gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "World shader compilation failed");
      return shader;
    } catch (error) { gl.deleteShader(shader); throw error; }
  }
  function program(scope: ResourceScope, vertex: string, fragment: string): Program {
    const program = scope.own(gl.createProgram(), value => gl.deleteProgram(value));
    let vs: WebGLShader | null = null, fs: WebGLShader | null = null;
    try {
      vs = compile(gl.VERTEX_SHADER, vertex); gl.attachShader(program, vs);
      fs = compile(gl.FRAGMENT_SHADER, fragment); gl.attachShader(program, fs); gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "World program link failed");
      return { program, uniforms: new Map() };
    } finally {
      if (vs) { gl.detachShader(program, vs); gl.deleteShader(vs); }
      if (fs) { gl.detachShader(program, fs); gl.deleteShader(fs); }
    }
  }
  function createCore(): CoreResources {
    const scope = new ResourceScope();
    try {
      const terrain = program(scope, FULLSCREEN_VERTEX, TERRAIN_FRAGMENT), voxel = program(scope, VOXEL_VERTEX, VOXEL_FRAGMENT);
      const sky = program(scope, FULLSCREEN_VERTEX, SKY_FRAGMENT), threshold = program(scope, FULLSCREEN_VERTEX, THRESHOLD_FRAGMENT);
      const blur = program(scope, FULLSCREEN_VERTEX, BLUR_FRAGMENT), composite = program(scope, FULLSCREEN_VERTEX, COMPOSITE_FRAGMENT);
      const empty = scope.own(gl.createVertexArray(), value => gl.deleteVertexArray(value));
      const cubes = scope.own(gl.createVertexArray(), value => gl.deleteVertexArray(value));
      const vertices = scope.own(gl.createBuffer(), value => gl.deleteBuffer(value));
      gl.bindVertexArray(cubes); gl.bindBuffer(gl.ARRAY_BUFFER, vertices); gl.bufferData(gl.ARRAY_BUFFER, cubeVertices(), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
      gl.bindVertexArray(null); gl.bindBuffer(gl.ARRAY_BUFFER, null);
      return { scope, empty, cubes, terrain, voxel, sky, threshold, blur, composite };
    } catch (error) { scope.dispose(); throw error; }
  }
  function createField(grid: number): FieldResources {
    const scope = new ResourceScope();
    try {
      const targets: [Target, Target] = [target(scope, grid, grid, gl.NEAREST), target(scope, grid, grid, gl.NEAREST)];
      gl.clearColor(0, 0, 0, 0);
      for (const item of targets) { gl.bindFramebuffer(gl.FRAMEBUFFER, item.framebuffer); gl.clear(gl.COLOR_BUFFER_BIT); }
      return { scope, targets, read: 0, grid };
    } catch (error) { scope.dispose(); throw error; }
  }
  function createParticles(side: number): ParticleResources {
    const scope = new ResourceScope();
    try {
      const simulation = program(scope, FULLSCREEN_VERTEX, SIMULATION_FRAGMENT);
      const points = program(scope, POINT_VERTEX, POINT_FRAGMENT);
      const pair = (): ParticleTarget => {
        const framebuffer = ownFramebuffer(scope), position = ownTexture(scope), velocity = ownTexture(scope);
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        for (const [index, texture] of [position, velocity].entries()) {
          textureStorage(texture, side, side, true, gl.NEAREST);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + index, gl.TEXTURE_2D, texture, 0);
        }
        gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]); assertFramebuffer();
        return { position, velocity, framebuffer };
      };
      const targets: [ParticleTarget, ParticleTarget] = [pair(), pair()];
      const word = ownTexture(scope); textureStorage(word, side, side, true, gl.NEAREST);
      if (gl.getError() !== gl.NO_ERROR) throw new Error("World float texture allocation failed");
      return { scope, targets, word, simulation, points, side, read: 0, initialized: false, wordKey: "" };
    } catch (error) { scope.dispose(); throw error; }
    finally { gl.bindFramebuffer(gl.FRAMEBUFFER, null); }
  }
  function clearInteraction(clearPointer = true) {
    holding = false; holdTime = 0; meltAmount = 0;
    if (clearPointer) pointerStrength = 0;
    lastHit = null; pendingShock = null; shockTime = -9;
    meltAt = [99999, 99999]; shockAt = [99999, 99999];
  }
  function releaseParticles() {
    particles?.scope.dispose(); particles = null; actualMaterial = "solid";
  }
  function particleMaterialAllowed() {
    return tier.kind === "animated" && !tier.forceSolid && tier.particleSide > 0 && capabilities.floatTargets;
  }
  function samples(): number {
    try {
      const color = Array.from(gl.getInternalformatParameter(gl.RENDERBUFFER, gl.RGBA8, gl.SAMPLES) as Int32Array);
      const depth = Array.from(gl.getInternalformatParameter(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, gl.SAMPLES) as Int32Array);
      return Math.max(0, ...color.filter(value => value <= 4 && depth.includes(value)));
    } catch { return 0; }
  }
  function createSurface(width: number, height: number, sampleCount: number): SurfaceResources {
    const scope = new ResourceScope();
    try {
      const scene = target(scope, width, height);
      const bw = Math.max(1, width >> 2), bh = Math.max(1, height >> 2);
      const bloom: [Target, Target] = [target(scope, bw, bh), target(scope, bw, bh)];
      const drawFramebuffer = sampleCount ? ownFramebuffer(scope) : scene.framebuffer;
      gl.bindFramebuffer(gl.FRAMEBUFFER, drawFramebuffer);
      if (sampleCount) {
        const color = ownRenderbuffer(scope); gl.bindRenderbuffer(gl.RENDERBUFFER, color);
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER, sampleCount, gl.RGBA8, width, height);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
      }
      const depth = ownRenderbuffer(scope); gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
      if (sampleCount) gl.renderbufferStorageMultisample(gl.RENDERBUFFER, sampleCount, gl.DEPTH_COMPONENT24, width, height);
      else gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
      assertFramebuffer();
      return { scope, scene, bloom, drawFramebuffer, multisampled: sampleCount > 0, width, height };
    } catch (error) { scope.dispose(); throw error; }
  }
  function dimensions(): [number, number] {
    const maximum = Math.max(2, Math.min(Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)), Number(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE))));
    const dpr = Math.min(requestedDpr, tier.dprCap);
    const scale = Math.min(dpr, maximum / cssWidth, maximum / cssHeight);
    return [Math.max(2, Math.round(cssWidth * scale)), Math.max(2, Math.round(cssHeight * scale))];
  }
  function allocateSurface(width: number, height: number) {
    const count = samples();
    try { return createSurface(width, height, count); }
    catch (error) { if (!count) throw error; return createSurface(width, height, 0); }
  }
  function replaceTargets() {
    const [width, height] = dimensions();
    let nextField: FieldResources | null = null, nextSurface: SurfaceResources | null = null;
    try {
      if (!field || field.grid !== tier.grid) nextField = createField(tier.grid);
      if (!surface || surface.width !== width || surface.height !== height) nextSurface = allocateSurface(width, height);
    } catch (error) { nextField?.scope.dispose(); nextSurface?.scope.dispose(); throw error; }
    if (nextField) { field?.scope.dispose(); field = nextField; }
    if (nextSurface) {
      surface?.scope.dispose(); surface = nextSurface;
      canvas.width = width; canvas.height = height;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  function clearQueries() { for (const query of pendingQueries) gl.deleteQuery(query); pendingQueries = []; }
  function clearFrameFence() {
    if (frameFence) gl.deleteSync(frameFence);
    frameFence = null;
  }
  function releaseResources() {
    clearFrameFence(); pendingSimulationDt = 0;
    clearQueries(); releaseParticles(); clearInteraction(); surface?.scope.dispose(); field?.scope.dispose(); core?.scope.dispose();
    surface = null; field = null; core = null;
  }
  function rebuild() {
    capabilities.floatTargets = probeFloatTargets();
    timer = gl.getExtension("EXT_disjoint_timer_query_webgl2") as TimerExtension | null;
    core = createCore(); replaceTargets();
  }
  function fail() {
    if (terminal || disposed) return;
    terminal = true; releaseResources(); callbacks.onLost();
  }
  function onContextLost(event: Event) {
    event.preventDefault();
    if (disposed || terminal) return;
    lost = true; lossCount++; releaseResources();
    if (lossCount > 1) terminal = true;
    callbacks.onLost();
  }
  function onContextRestored() {
    if (disposed || terminal || !lost) return;
    try { rebuild(); lost = false; pointerStrength = 0; callbacks.onRestored(); }
    catch { fail(); }
  }
  try { rebuild(); }
  catch { releaseResources(); return null; }
  canvas.addEventListener("webglcontextlost", onContextLost);
  canvas.addEventListener("webglcontextrestored", onContextRestored);

  function uniform(p: Program, name: string) {
    if (!p.uniforms.has(name)) p.uniforms.set(name, gl.getUniformLocation(p.program, name));
    return p.uniforms.get(name)!;
  }
  function scalar(p: Program, name: string, value: number) { gl.uniform1f(uniform(p, name), value); }
  function vector2(p: Program, name: string, value: readonly [number, number]) { gl.uniform2f(uniform(p, name), value[0], value[1]); }
  function vector3(p: Program, name: string, value: RGB) { gl.uniform3fv(uniform(p, name), value); }
  function bind(p: Program, name: string, texture: WebGLTexture, unit = 0) {
    gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, texture); gl.uniform1i(uniform(p, name), unit);
  }
  function fullscreen(p: Program, framebuffer: WebGLFramebuffer | null, width: number, height: number) {
    gl.bindVertexArray(core!.empty); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.BLEND); gl.depthMask(true);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer); gl.viewport(0, 0, width, height); gl.useProgram(p.program);
  }
  function pollGpu(): number | null {
    if (!timer) return null;
    if (gl.getParameter(timer.GPU_DISJOINT_EXT)) { clearQueries(); return null; }
    let value: number | null = null;
    while (pendingQueries.length && gl.getQueryParameter(pendingQueries[0], gl.QUERY_RESULT_AVAILABLE)) {
      const query = pendingQueries.shift()!;
      const nanoseconds = Number(gl.getQueryParameter(query, gl.QUERY_RESULT));
      if (Number.isFinite(nanoseconds) && nanoseconds >= 0) value = nanoseconds / 1e6;
      gl.deleteQuery(query);
    }
    return value;
  }
  function crystalUniforms(p: Program, frame: WorldFrame, lat: number, origin: [number, number]) {
    scalar(p, "uLat", lat); scalar(p, "uCry", frame.cry); scalar(p, "uIsland", frame.island);
    scalar(p, "uMelt", meltAmount); scalar(p, "uMask", frame.mask);
    vector2(p, "uOrigin", origin); vector2(p, "uMeltAt", meltAt);
  }
  function simulate(frame: WorldFrame, dt: number, terrain: WebGLTexture, camera: Camera, aspect: number,
    hit: [number, number] | null, velocity: [number, number], origin: [number, number]) {
    const p = particles!, sim = p.simulation;
    if (frame.introActive) {
      const key = [aspect, ...frame.eye, ...frame.at, frame.fov].join(",");
      if (p.wordKey !== key) {
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, p.word);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, p.side, p.side, gl.RGBA, gl.FLOAT, buildWordTargets(camera, aspect, p.side, Math.random, [.28, .62]));
        p.wordKey = key;
      }
    }
    const pass = (initialize: boolean) => {
      const from = p.targets[p.read], to = p.targets[1 - p.read];
      fullscreen(sim, to.framebuffer, p.side, p.side);
      bind(sim, "uPos", from.position); bind(sim, "uVel", from.velocity, 1);
      bind(sim, "uField", terrain, 2); bind(sim, "uWord", p.word, 3);
      scalar(sim, "uN", field!.grid); scalar(sim, "uS", p.side); scalar(sim, "uSpan", SPAN);
      scalar(sim, "uInitialize", Number(initialize)); scalar(sim, "uTime", frame.simTime); scalar(sim, "uDt", initialize ? 0 : Math.min(dt, 1 / 30));
      scalar(sim, "uIntroActive", Number(frame.introActive));
      scalar(sim, "uIntroTime", frame.introTime);
      scalar(sim, "uMorphStart", frame.morph.start); scalar(sim, "uMorphDur", frame.morph.dur);
      scalar(sim, "uToWord", Number(frame.morph.toWord)); scalar(sim, "uFromWord", Number(frame.morph.fromWord));
      scalar(sim, "uTransit", frame.morph.transit); scalar(sim, "uMeltP", meltAmount); scalar(sim, "uPtrOn", pointerStrength);
      scalar(sim, "uShockT", shockTime); scalar(sim, "uRing", frame.ring);
      vector2(sim, "uOffset", OFFSET); vector2(sim, "uPtr", hit ?? [99999, 99999]); vector2(sim, "uPtrVel", velocity);
      vector2(sim, "uMeltAtP", meltAt); vector2(sim, "uShockAt", shockAt); vector2(sim, "uOriginP", origin);
      gl.drawArrays(gl.TRIANGLES, 0, 3); p.read = 1 - p.read;
    };
    if (!p.initialized) { pass(true); p.initialized = true; }
    pass(false);
  }
  function drawPasses(frame: WorldFrame, dt: number) {
    let pointsSubmitted = false;
    const c = core!, f = field!, s = surface!;
    const animated = tier.kind === "animated";
    terrainTime += animated ? dt * frame.timeScale : 0;
    const aspect = cssWidth / cssHeight;
    const camera = makeCamera(frame.eye, frame.at, frame.fov, aspect);
    // Keep the departing island in world space while the content camera rises.
    if (frame.page === "home" || islandOrigin === null)
      islandOrigin = groundHit(camera, aspect, anchor[0], anchor[1]) ?? [16, 6];
    const origin = islandOrigin;
    const hit = animated && pointer ? groundHit(camera, aspect, pointer[0], pointer[1]) : null;
    const pointerGoal = hit && performance.now() - pointerMovedAt < 260 ? 1 : 0;
    pointerStrength = animated ? pointerStrength + (pointerGoal - pointerStrength) * (1 - Math.exp(-dt * 8)) : 0;
    let lat = particleMaterialAllowed() && frame.lat > LATTICE_EPSILON ? Math.min(1, frame.lat) : 0;
    if (lat > 0 && !particles) {
      try { particles = createParticles(tier.particleSide); }
      catch { capabilities.floatTargets = false; releaseParticles(); clearInteraction(); lat = 0; }
    } else if (lat === 0 && particles) releaseParticles();
    actualMaterial = lat > 0 ? "lattice" : "solid";
    if (lat > 0) {
      if (holding) { holdTime += dt; if (hit) meltAt = hit; }
      const goal = holding && holdTime > .22 ? Math.min(1, (holdTime - .22) / .9) : 0;
      meltAmount += (goal - meltAmount) * Math.min(1, dt * (goal > meltAmount ? 5 : 3));
      if (pendingShock) {
        const at = groundHit(camera, aspect, pendingShock[0], pendingShock[1]);
        if (at) { shockAt = at; shockTime = frame.simTime; }
        pendingShock = null;
      }
    } else clearInteraction(!animated);
    const velocity: [number, number] = hit && lastHit && dt > 0 ? [(hit[0] - lastHit[0]) / Math.max(dt, .008), (hit[1] - lastHit[1]) / Math.max(dt, .008)] : [0, 0];
    const speed = Math.hypot(...velocity);
    if (speed > 60) { velocity[0] *= 60 / speed; velocity[1] *= 60 / speed; }
    lastHit = hit;
    const hazeMix = frame.profile * .8 + (1 - frame.profile * .8) * lat;
    const haze: RGB = palette.light ? palette.haze : palette.haze.map((value, index) => value + (palette.ink[index] - value) * hazeMix) as unknown as RGB;
    const from = f.targets[f.read], to = f.targets[1 - f.read];

    fullscreen(c.terrain, to.framebuffer, f.grid, f.grid);
    bind(c.terrain, "uPrev", from.texture);
    scalar(c.terrain, "uT", terrainTime); scalar(c.terrain, "uProfile", frame.profile);
    scalar(c.terrain, "uFront", animated ? frame.ring : 0); scalar(c.terrain, "uPtrOn", pointerStrength);
    scalar(c.terrain, "uDecay", Math.pow(.16, dt)); scalar(c.terrain, "uN", f.grid); scalar(c.terrain, "uSpan", SPAN);
    vector2(c.terrain, "uPtr", hit ?? [99999, 99999]); vector2(c.terrain, "uOrigin", origin as [number, number]);
    vector2(c.terrain, "uOffset", OFFSET); vector2(c.terrain, "uSunXZ", [SUN[0] / SUN_XZ_LENGTH, SUN[2] / SUN_XZ_LENGTH]);
    gl.drawArrays(gl.TRIANGLES, 0, 3); f.read = 1 - f.read;

    if (lat > 0) simulate(frame, dt, to.texture, camera, aspect, hit, velocity, origin);

    fullscreen(c.sky, s.drawFramebuffer, s.width, s.height);
    vector3(c.sky, "uHaze", haze); vector3(c.sky, "uInk", palette.ink); vector3(c.sky, "uPoint", palette.point);
    scalar(c.sky, "uHorizon", frame.horizon); scalar(c.sky, "uDots", lat * frame.runDim); scalar(c.sky, "uDotPx", Math.max(1, Math.round(s.width / 62)));
    scalar(c.sky, "uLight", Number(palette.light));
    gl.drawArrays(gl.TRIANGLES, 0, 3); gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); gl.frontFace(gl.CCW);
    gl.bindVertexArray(c.cubes); gl.useProgram(c.voxel.program);
    bind(c.voxel, "uField", to.texture); gl.uniformMatrix4fv(uniform(c.voxel, "uVP"), false, camera.viewProj);
    scalar(c.voxel, "uN", f.grid); scalar(c.voxel, "uSpan", SPAN); crystalUniforms(c.voxel, frame, lat, origin);
    scalar(c.voxel, "uFront", frame.front); scalar(c.voxel, "uCharge", frame.charge);
    vector2(c.voxel, "uOffset", OFFSET);
    vector3(c.voxel, "uEye", frame.eye); vector3(c.voxel, "uAccent", palette.accent); vector3(c.voxel, "uSun", SUN);
    vector3(c.voxel, "uHaze", haze); vector3(c.voxel, "uPoint", palette.point);
    scalar(c.voxel, "uExposure", frame.exposure); scalar(c.voxel, "uFogD", frame.fogD); scalar(c.voxel, "uDim", frame.dim * (1 - .7 * lat));
    scalar(c.voxel, "uLight", Number(palette.light));
    scalar(c.voxel, "uPaperInk", frame.paperInk);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 30, f.grid * f.grid);

    if (lat > 0 && particles) {
      const p = particles, points = p.points, state = p.targets[p.read];
      gl.bindVertexArray(c.empty); gl.disable(gl.CULL_FACE); gl.depthMask(false); gl.enable(gl.BLEND);
      gl.blendFunc(palette.light ? gl.SRC_ALPHA : gl.ONE, palette.light ? gl.ONE_MINUS_SRC_ALPHA : gl.ONE);
      gl.useProgram(points.program);
      bind(points, "uPos", state.position); bind(points, "uVel", state.velocity, 1); bind(points, "uField", to.texture, 2);
      gl.uniformMatrix4fv(uniform(points, "uVP"), false, camera.viewProj);
      vector3(points, "uEye", frame.eye); vector2(points, "uOffset", OFFSET);
      scalar(points, "uN", f.grid); scalar(points, "uS", p.side); scalar(points, "uSpan", SPAN);
      scalar(points, "uDpr", s.width / cssWidth); scalar(points, "uFogD", frame.fogD); scalar(points, "uRunDim", frame.runDim);
      vector3(points, "uPoint", palette.point); vector3(points, "uAccent", palette.accent); scalar(points, "uLight", Number(palette.light));
      scalar(points, "uPaperInk", frame.paperInk); scalar(points, "uFront", frame.ring);
      crystalUniforms(points, frame, lat, origin); gl.drawArrays(gl.POINTS, 0, p.side * p.side);
      pointsSubmitted = true;
      gl.disable(gl.BLEND); gl.depthMask(true);
    }

    if (s.multisampled) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, s.drawFramebuffer); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, s.scene.framebuffer);
      gl.blitFramebuffer(0, 0, s.width, s.height, 0, 0, s.width, s.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }
    const bloomAmount = palette.light ? 0 : frame.bloom;
    if (bloomAmount > 0) {
      const [a, b] = s.bloom;
      fullscreen(c.threshold, a.framebuffer, a.width, a.height); bind(c.threshold, "uTex", s.scene.texture); gl.drawArrays(gl.TRIANGLES, 0, 3);
      for (let index = 0; index < 4; index++) {
        const horizontal = index % 2 === 0, spread = 1 + (index >> 1);
        fullscreen(c.blur, horizontal ? b.framebuffer : a.framebuffer, a.width, a.height);
        bind(c.blur, "uTex", horizontal ? a.texture : b.texture);
        vector2(c.blur, "uDir", horizontal ? [spread / a.width, 0] : [0, spread / a.height]); gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
    }
    fullscreen(c.composite, null, s.width, s.height);
    bind(c.composite, "uTex", s.scene.texture); bind(c.composite, "uBloom", bloomAmount > 0 ? s.bloom[0].texture : s.scene.texture, 1);
    scalar(c.composite, "uAmt", bloomAmount); scalar(c.composite, "uFlash", animated && !palette.light ? frame.flash : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0); gl.bindVertexArray(null);
    return pointsSubmitted;
  }
  return {
    capabilities,
    get material(): WorldMaterial { return actualMaterial; },
    get melt() { return meltAmount; },
    resize(width, height, dpr) {
      cssWidth = Number.isFinite(width) && width > 0 ? width : 2;
      cssHeight = Number.isFinite(height) && height > 0 ? height : 2;
      requestedDpr = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
      if (!lost && !terminal && !disposed) try { replaceTargets(); } catch { fail(); }
    },
    setTier(next) {
      tier = { ...next };
      if (!particleMaterialAllowed() || particles?.side !== next.particleSide) releaseParticles();
      if (!particleMaterialAllowed()) clearInteraction();
      if (!lost && !terminal && !disposed) try { replaceTargets(); } catch { fail(); }
    },
    setPalette(next) { palette = next; },
    setAnchor(ndc) { anchor = [...ndc]; },
    setPointer(ndc) { pointer = ndc ? [...ndc] : null; pointerMovedAt = performance.now(); },
    press(ndc) {
      if (!particleMaterialAllowed() || lost || terminal || disposed) return;
      pointer = [...ndc]; pointerMovedAt = performance.now(); holding = true; holdTime = 0;
    },
    release() { holding = false; holdTime = 0; },
    shock(ndc) {
      if (particleMaterialAllowed() && !lost && !terminal && !disposed) pendingShock = [...ndc];
    },
    draw(frame, dtSeconds) {
      if (lost || terminal || disposed || !core || !field || !surface || tier.kind === "css") return { cpuMs: 0, gpuMs: null, submitted: false, pointsSubmitted: false };
      const started = performance.now();
      let gpuMs: number | null = null, query: WebGLQuery | null = null;
      let submitted = false, pointsSubmitted = false;
      pendingSimulationDt = tier.kind === "animated"
        ? Math.min(.05, pendingSimulationDt + (Number.isFinite(dtSeconds) ? Math.max(0, Math.min(.05, dtSeconds)) : 0)) : 0;
      try {
        if (frameFence) {
          if (tier.kind === "animated") {
            const ready = gl.clientWaitSync(frameFence, 0, 0);
            if (ready === gl.TIMEOUT_EXPIRED) return { cpuMs: Math.max(0, performance.now() - started), gpuMs: null, submitted: false, pointsSubmitted: false };
            if (ready !== gl.ALREADY_SIGNALED && ready !== gl.CONDITION_SATISFIED) throw new Error("World GPU fence wait failed");
          }
          // Static paints are mandatory one-shot updates. Their new fence also
          // covers older queued commands without blocking the UI thread.
          clearFrameFence();
        }
        gpuMs = pollGpu();
        if (timer && pendingQueries.length < 4) {
          query = gl.createQuery();
          if (query) gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
        }
        const dt = pendingSimulationDt; pendingSimulationDt = 0;
        pointsSubmitted = drawPasses(frame, dt);
        if (query && timer) { gl.endQuery(timer.TIME_ELAPSED_EXT); pendingQueries.push(query); query = null; }
        frameFence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        if (!frameFence) throw new Error("World GPU fence allocation failed");
        gl.flush();
        submitted = true;
      } catch {
        pointsSubmitted = false;
        if (query && timer) { gl.endQuery(timer.TIME_ELAPSED_EXT); gl.deleteQuery(query); }
        fail();
      }
      const valid = submitted && !lost && !gl.isContextLost();
      return { cpuMs: Math.max(0, performance.now() - started), gpuMs, submitted: valid, pointsSubmitted: pointsSubmitted && valid };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      canvas.removeEventListener("webglcontextlost", onContextLost); canvas.removeEventListener("webglcontextrestored", onContextRestored);
      releaseResources();
    },
  };
}
