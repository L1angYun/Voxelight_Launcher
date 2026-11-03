// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorldRenderer } from "./renderer";
import { createWorldDirector } from "./worldDirector";
import type { Tier } from "./qualityTier";

type Handle = { kind: string; id: number };
function glBoundary(options: { float?: boolean; floatComplete?: boolean; timer?: boolean; shaderFailureAt?: number } = {}) {
  let sequence = 0, enumSequence = 1;
  const constants = new Map<string, number>();
  const live = new Set<Handle>();
  const textures: number[][] = [], instances: number[] = [];
  const floatSizes: number[][] = [], pointCounts: number[] = [], blends: number[][] = [];
  const passes: { mrt: boolean; width: number; uniforms: Map<string, number>; field: Handle | undefined }[] = [];
  const uniforms = new Map<string, number>();
  const vectors = new Map<string, [number, number]>();
  const textureSizes = new Map<Handle, number[]>(), framebufferTextures = new Map<Handle, Map<number, Handle>>();
  const boundTextures = new Map<number, Handle>();
  const attached = new Map<Handle, Set<Handle>>(), errors: string[] = [];
  const waits: { sync: Handle; flags: number; timeout: number }[] = [];
  const fences: { handle: Handle; passes: number }[] = [];
  let waitStatus = "ALREADY_SIGNALED", flushes = 0;
  let compiled = 0;
  let failShader = false, failFramebuffer = false, floatAttachment = false;
  let currentInternalFormat = 0;
  let boundTexture: Handle, boundFramebuffer: Handle | null = null, textureUnit = 0, failLargeFloat = false;
  const create = (kind: string) => { const handle = { kind, id: ++sequence }; live.add(handle); return handle; };
  const remove = (handle: Handle | null) => { if (handle) { expect(live.has(handle)).toBe(true); live.delete(handle); } };
  const noOp = () => {};
  const methods: Record<string, unknown> = {
    createShader: () => create("shader"), deleteShader: remove,
    createProgram: () => create("program"), deleteProgram: remove,
    createTexture: () => create("texture"), deleteTexture: remove,
    createFramebuffer: () => { floatAttachment = false; return create("framebuffer"); }, deleteFramebuffer: remove,
    createRenderbuffer: () => create("renderbuffer"), deleteRenderbuffer: remove,
    createBuffer: () => create("buffer"), deleteBuffer: remove,
    createVertexArray: () => create("vao"), deleteVertexArray: remove,
    createQuery: () => create("query"), deleteQuery: remove,
    fenceSync: () => { const handle = create("sync"); fences.push({ handle, passes: passes.length }); return handle; },
    clientWaitSync: (sync: Handle, flags: number, timeout: number) => { expect(live.has(sync)).toBe(true); waits.push({ sync, flags, timeout }); return constant(waitStatus); },
    deleteSync: remove,
    flush: () => { flushes++; },
    getExtension: (name: string) => name === "EXT_color_buffer_float" ? options.float ? {} : null
      : name === "EXT_disjoint_timer_query_webgl2" && options.timer ? { TIME_ELAPSED_EXT: 9001, GPU_DISJOINT_EXT: 9002 } : null,
    getParameter: (name: number) => name === constant("MAX_TEXTURE_SIZE") || name === constant("MAX_RENDERBUFFER_SIZE") ? 4096
      : name === 9002 ? false : name === constant("MAX_SAMPLES") ? 4 : 0,
    getInternalformatParameter: () => new Int32Array([4, 2, 1]),
    getShaderParameter: () => !failShader && ++compiled !== options.shaderFailureAt,
    getProgramParameter: () => true,
    getShaderInfoLog: () => "injected shader compilation failure",
    getProgramInfoLog: () => "injected program link failure",
    getUniformLocation: (_program: Handle, name: string) => ({ name }),
    attachShader: (program: Handle, shader: Handle) => {
      if (!attached.has(program)) attached.set(program, new Set());
      attached.get(program)!.add(shader);
    },
    detachShader: (program: Handle, shader: Handle) => {
      if (!attached.get(program)?.delete(shader)) errors.push("INVALID_OPERATION: shader was not attached");
    },
    uniform1f: (location: { name: string }, value: number) => uniforms.set(location.name, value),
    uniform2f: (location: { name: string }, x: number, y: number) => vectors.set(location.name, [x, y]),
    activeTexture: (unit: number) => { textureUnit = unit - constant("TEXTURE0"); },
    bindTexture: (_target: number, texture: Handle) => { boundTexture = texture; boundTextures.set(textureUnit, texture); },
    bindFramebuffer: (_target: number, framebuffer: Handle | null) => { boundFramebuffer = framebuffer; },
    texImage2D: (_target: number, _level: number, internal: number, width: number, height: number) => {
      currentInternalFormat = internal; textures.push([width, height]);
      textureSizes.set(boundTexture, [width, height]);
      if (internal === constant("RGBA32F")) floatSizes.push([width, height]);
    },
    framebufferTexture2D: (_target: number, attachment: number, _textureTarget: number, texture: Handle) => {
      floatAttachment ||= currentInternalFormat === constant("RGBA32F");
      if (!framebufferTextures.has(boundFramebuffer!)) framebufferTextures.set(boundFramebuffer!, new Map());
      framebufferTextures.get(boundFramebuffer!)!.set(attachment, texture);
    },
    checkFramebufferStatus: () => failFramebuffer || (floatAttachment && options.floatComplete === false) ||
      (failLargeFloat && [...(framebufferTextures.get(boundFramebuffer!)?.values() ?? [])].some(texture => (textureSizes.get(texture)?.[0] ?? 0) > 2) && floatAttachment) ? 0 : constant("FRAMEBUFFER_COMPLETE"),
    drawArrays: (mode: number, _first: number, count: number) => {
      if (mode === constant("POINTS")) pointCounts.push(count);
      const attachments = framebufferTextures.get(boundFramebuffer!);
      const width = attachments?.size ? textureSizes.get(attachments.values().next().value!)?.[0] ?? 0 : 0;
      passes.push({ mrt: (attachments?.size ?? 0) === 2, width, uniforms: new Map(uniforms), field: boundTextures.get(2) });
    },
    blendFunc: (source: number, destination: number) => blends.push([source, destination]),
    drawArraysInstanced: (_mode: number, _first: number, _count: number, count: number) => instances.push(count),
    getQueryParameter: (_query: Handle, name: number) => name === constant("QUERY_RESULT_AVAILABLE") ? true : 2_500_000,
    getError: () => constant("NO_ERROR"), isContextLost: () => false,
  };
  for (const name of ["shaderSource", "compileShader", "linkProgram", "texParameteri", "texSubImage2D",
    "drawBuffers", "bindRenderbuffer", "renderbufferStorageMultisample", "renderbufferStorage", "framebufferRenderbuffer",
    "bindBuffer", "bufferData", "bindVertexArray", "enableVertexAttribArray", "vertexAttribPointer", "useProgram", "uniform1i",
    "uniform3fv", "uniformMatrix4fv", "viewport", "clearColor", "clear", "enable", "disable",
    "depthMask", "cullFace", "frontFace", "blitFramebuffer", "beginQuery", "endQuery"]) methods[name] = noOp;
  function constant(name: string) { if (!constants.has(name)) constants.set(name, enumSequence++); return constants.get(name)!; }
  const gl = new Proxy(methods, { get: (target, name: string) => /^[A-Z][A-Z_0-9]+$/.test(name) ? constant(name) : target[name] }) as unknown as WebGL2RenderingContext;
  return { gl, live, textures, instances, floatSizes, pointCounts, blends, passes, uniforms, vectors, errors, waits, fences,
    wait: (status: string) => { waitStatus = status; }, flushCount: () => flushes,
    failShader: () => { failShader = true; }, failFramebuffer: () => { failFramebuffer = true; },
    failLargeFloat: () => { failLargeFloat = true; } };
}
const fullTier: Tier = { kind: "animated", grid: 160, particleSide: 256, dprCap: 1.5, forceSolid: false };
const frame = () => createWorldDirector({ phase: "idle", fraction: null, page: "home", scene: "horizon", material: "lattice" }).step(0, 0);
function mount(options: Parameters<typeof glBoundary>[0] = {}) {
  const boundary = glBoundary(options);
  const canvas = document.createElement("canvas");
  vi.spyOn(canvas, "getContext").mockReturnValue(boundary.gl);
  const callbacks = { onLost: vi.fn(), onRestored: vi.fn() };
  const renderer = createWorldRenderer(canvas, callbacks);
  return { ...boundary, canvas, callbacks, renderer };
}
afterEach(() => vi.restoreAllMocks());

describe("WebGL renderer boundary", () => {
  it("reports the last submitted material across allocation changes and busy skips", () => {
    const t = mount({ float: true }); const r = t.renderer!;
    expect(r.draw(frame(), .016).submitted).toBe(true);
    expect(r.material).toBe("lattice");
    r.setTier({ ...fullTier, grid: 110, particleSide: 160 });
    expect(r.material).toBe("lattice");
    const passes = t.passes.length;
    t.wait("TIMEOUT_EXPIRED");
    expect(r.draw(frame(), .016).submitted).toBe(false);
    expect(r.material).toBe("lattice");
    expect(t.passes).toHaveLength(passes);
    t.wait("CONDITION_SATISFIED");
    expect(r.draw(frame(), .016).submitted).toBe(true);
    expect(r.material).toBe("lattice");
    expect(t.pointCounts).toEqual([65536, 25600]);
    t.wait("TIMEOUT_EXPIRED");
    expect(r.draw({ ...frame(), lat: 0 }, .016).submitted).toBe(false);
    expect(r.material).toBe("lattice");
    t.wait("ALREADY_SIGNALED");
    expect(r.draw({ ...frame(), lat: 0 }, .016).submitted).toBe(true);
    expect(r.material).toBe("solid");
    expect(t.pointCounts).toEqual([65536, 25600]);
    expect(t.instances).toEqual([25600, 12100, 12100]);
    r.dispose(); expect(t.live.size).toBe(0);
  });

  it("polls final frame completion without submitting draws or changing textures", () => {
    const t = mount({ float: true }); const r = t.renderer!;
    expect(r.pollFrameComplete).toBeTypeOf("function");
    r.draw(frame(), .016);
    const passes = t.passes.length;
    const textures = vi.spyOn(t.gl, "texImage2D");
    t.wait("TIMEOUT_EXPIRED");
    expect(r.pollFrameComplete()).toBe(false);
    expect(r.pollFrameComplete()).toBe(false);
    expect(t.passes).toHaveLength(passes); expect(textures).not.toHaveBeenCalled();
    expect(t.fences).toHaveLength(1); expect(t.flushCount()).toBe(1);
    t.wait("CONDITION_SATISFIED");
    expect(r.pollFrameComplete()).toBe(true);
    expect([...t.live].filter(handle => handle.kind === "sync")).toHaveLength(0);
    const waits = t.waits.length;
    expect(r.pollFrameComplete()).toBe(true);
    expect(t.waits).toHaveLength(waits);
    expect(t.waits.every(wait => wait.flags === 0 && wait.timeout === 0)).toBe(true);
    r.dispose(); expect(r.pollFrameComplete()).toBe(false); expect(t.live.size).toBe(0);
  });

  it("fails closed when a completion-only fence poll fails", () => {
    const t = mount({ float: true }); const r = t.renderer!;
    expect(r.pollFrameComplete).toBeTypeOf("function");
    r.draw(frame(), .016); t.wait("WAIT_FAILED");
    expect(r.pollFrameComplete()).toBe(false);
    expect(t.callbacks.onLost).toHaveBeenCalledOnce();
    expect(r.material).toBe("solid"); expect(t.live.size).toBe(0);
  });
  it("skips all pass and texture work while one whole-frame fence is pending, then submits the latest state", () => {
    const t = mount({ float: true }); const r = t.renderer!;
    const first = r.draw(frame(), .01);
    expect(first.submitted).toBe(true);
    expect(t.fences).toHaveLength(1);
    expect(t.fences[0].passes).toBe(t.passes.length);
    expect(t.flushCount()).toBe(1);
    const draws = t.passes.length;
    const textures = vi.spyOn(t.gl, "texImage2D");
    const binds = vi.spyOn(t.gl, "bindTexture");
    t.wait("TIMEOUT_EXPIRED");
    expect(r.draw({ ...frame(), profile: .4, simTime: 1 }, .02)).toMatchObject({ submitted: false, pointsSubmitted: false });
    expect(r.draw({ ...frame(), profile: .6, simTime: 2 }, .02)).toMatchObject({ submitted: false, pointsSubmitted: false });
    expect(t.passes).toHaveLength(draws);
    expect(textures).not.toHaveBeenCalled(); expect(binds).not.toHaveBeenCalled();
    expect(t.fences).toHaveLength(1);
    expect(t.waits.every(wait => wait.flags === 0 && wait.timeout === 0)).toBe(true);
    t.wait("CONDITION_SATISFIED");
    expect(r.draw({ ...frame(), profile: .9, simTime: 3 }, .02).submitted).toBe(true);
    expect(t.uniforms.get("uProfile")).toBe(.9);
    expect(t.uniforms.get("uTime")).toBe(3);
    expect(t.uniforms.get("uT")).toBeCloseTo(.06);
    expect(t.pointCounts).toEqual([65536, 65536]);
    expect([...t.live].filter(handle => handle.kind === "sync")).toHaveLength(1);
    expect(t.live.has(t.fences[0].handle)).toBe(false);
    r.dispose(); expect(t.live.size).toBe(0);
  });

  it("bypasses backpressure for one-shot static palette and resize updates", () => {
    const t = mount({ float: true }); const r = t.renderer!;
    r.draw(frame(), .016); t.wait("TIMEOUT_EXPIRED");
    r.setTier({ kind: "static", grid: 110, particleSide: 0, dprCap: 1, forceSolid: true });
    r.resize(1280, 720, 1);
    expect(r.draw({ ...frame(), exposure: .42 }, 0).submitted).toBe(true);
    r.setPalette({ light: true, ink: [1, 1, 1], point: [0, 0, 0], accent: [.5, .6, .7], haze: [1, 1, 1] });
    expect(r.draw(frame(), 0).submitted).toBe(true);
    expect(t.uniforms.get("uLight")).toBe(1);
    expect(t.waits).toHaveLength(0);
    expect([...t.live].filter(handle => handle.kind === "sync")).toHaveLength(1);
    r.dispose(); expect(t.live.size).toBe(0);
  });

  it("never waits on an old fence after context loss and restoration", () => {
    const t = mount({ float: true }); const r = t.renderer!;
    r.draw(frame(), .016);
    const old = t.fences[0]?.handle;
    expect(old).toBeDefined();
    t.canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    expect(t.live.has(old!)).toBe(false);
    expect(r.material).toBe("solid");
    t.canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(r.material).toBe("solid");
    expect(r.draw(frame(), .016).submitted).toBe(true);
    expect(t.waits).toHaveLength(0);
    expect(t.fences.at(-1)!.handle).not.toBe(old);
    r.dispose(); expect(t.live.size).toBe(0);
  });

  it("falls back on a failed GPU fence wait and releases every resource", () => {
    const t = mount(); const r = t.renderer!;
    r.draw(frame(), .016); t.wait("WAIT_FAILED");
    expect(r.draw(frame(), .016)).toMatchObject({ submitted: false, pointsSubmitted: false });
    expect(t.callbacks.onLost).toHaveBeenCalledOnce();
    expect(t.live.size).toBe(0);
    r.dispose();
  });
  it("keeps the island at its world position while the content camera moves", () => {
    const t = mount({ float: true }); const r = t.renderer!;
    r.draw(frame(), 0);
    const origin = t.vectors.get("uOrigin");
    const content = createWorldDirector({ phase: "idle", fraction: null, page: "content", scene: "horizon", material: "lattice" }).snap();
    r.draw(content, 0);
    expect(t.vectors.get("uOrigin")).toEqual(origin);
    r.dispose(); expect(t.live.size).toBe(0);
  });

  it("sends flash and paper ink to rendering and suppresses flash in static policy", () => {
    const t = mount({ float: true }); const r = t.renderer!;
    r.draw({ ...frame(), flash: 1.1, paperInk: .12 }, .016);
    expect(t.uniforms.get("uFlash")).toBe(1.1);
    expect(t.uniforms.get("uPaperInk")).toBe(.12);
    r.setTier({ kind: "static", grid: 110, particleSide: 0, dprCap: 1, forceSolid: true });
    r.draw({ ...frame(), flash: 1.1 }, 0);
    expect(t.uniforms.get("uFlash")).toBe(0);
    r.dispose(); expect(t.live.size).toBe(0);
  });
  it("acknowledges points only after their real draw pass completes", () => {
    const t = mount({ float: true }); const r = t.renderer!;
    expect(r.draw(frame(), .016).pointsSubmitted).toBe(true);
    expect(t.pointCounts).toEqual([65536]);
    const drawArrays = t.gl.drawArrays.bind(t.gl);
    vi.spyOn(t.gl, "drawArrays").mockImplementation((mode, first, count) => {
      if (mode === t.gl.POINTS) throw new Error("injected points draw failure");
      drawArrays(mode, first, count);
    });
    expect(r.draw(frame(), .016).pointsSubmitted).toBe(false);
    expect(t.callbacks.onLost).toHaveBeenCalledOnce();
    r.dispose(); expect(t.live.size).toBe(0);
  });

  it("does not acknowledge points in solid, epsilon, static, CSS, lost or disposed draws", () => {
    const t = mount({ float: true }); const r = t.renderer!;
    expect(r.draw({ ...frame(), lat: 0 }, .016).pointsSubmitted).toBe(false);
    expect(r.draw({ ...frame(), lat: .0001 }, .016).pointsSubmitted).toBe(false);
    r.setTier({ kind: "static", grid: 110, particleSide: 0, dprCap: 1, forceSolid: true });
    expect(r.draw(frame(), 0).pointsSubmitted).toBe(false);
    r.setTier({ kind: "css", grid: 110, particleSide: 0, dprCap: 1, forceSolid: true });
    expect(r.draw(frame(), 0).pointsSubmitted).toBe(false);
    t.canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    expect(r.draw(frame(), 0).pointsSubmitted).toBe(false);
    r.dispose(); expect(r.draw(frame(), 0).pointsSubmitted).toBe(false);
    expect(t.pointCounts).toEqual([]); expect(t.live.size).toBe(0);
  });

  it("does not acknowledge points when float allocation falls back to solid", () => {
    const unsupported = mount();
    expect(unsupported.renderer!.draw(frame(), .016).pointsSubmitted).toBe(false);
    unsupported.renderer!.dispose(); expect(unsupported.live.size).toBe(0);
    const t = mount({ float: true }); t.failLargeFloat();
    expect(t.renderer!.draw(frame(), .016).pointsSubmitted).toBe(false);
    expect(t.renderer!.capabilities.floatTargets).toBe(false);
    expect(t.pointCounts).toEqual([]);
    t.renderer!.dispose(); expect(t.live.size).toBe(0);
  });

  it("allocates lattice simulation lazily and renders the current particle budget", () => {
    const t = mount({ float: true }); const r = t.renderer!;
    expect(t.floatSizes.every(([width]) => width <= 2)).toBe(true);
    r.draw({ ...frame(), lat: 0 }, .016);
    expect(t.pointCounts).toEqual([]);
    expect(t.floatSizes.every(([width]) => width <= 2)).toBe(true);
    r.draw(frame(), .016);
    expect(r.material).toBe("lattice");
    expect(t.pointCounts).toEqual([65536]);
    expect(t.floatSizes.filter(([width]) => width === 256).length).toBeGreaterThanOrEqual(4);
    expect(t.passes.filter(pass => pass.mrt && pass.width === 256).length).toBeGreaterThanOrEqual(2);
    r.dispose(); expect(t.live.size).toBe(0);
  });

  it("finishes the solid transition by releasing particles below the visible lattice boundary", () => {
    const t = mount({ float: true }); const r = t.renderer!;
    const baselineTextures = [...t.live].filter(handle => handle.kind === "texture").length;
    r.draw(frame(), .016);
    expect([...t.live].filter(handle => handle.kind === "texture")).toHaveLength(baselineTextures + 5);
    r.draw({ ...frame(), lat: .1 }, .016);
    expect(r.material).toBe("lattice");
    expect(t.uniforms.get("uLat")).toBe(.1);
    const pointsBefore = t.pointCounts.length, simulationsBefore = t.passes.filter(pass => pass.mrt).length;
    r.draw({ ...frame(), lat: .0001 }, .016);
    expect(r.material).toBe("solid");
    expect(t.pointCounts).toHaveLength(pointsBefore);
    expect(t.passes.filter(pass => pass.mrt)).toHaveLength(simulationsBefore);
    expect(t.uniforms.get("uLat")).toBe(0);
    expect(t.uniforms.get("uDots")).toBe(0);
    expect([...t.live].filter(handle => handle.kind === "texture")).toHaveLength(baselineTextures);
    expect(r.capabilities.floatTargets).toBe(true);
    r.dispose(); expect(t.live.size).toBe(0);
  });

  it("sends an immediate intro end to the existing simulation even with zero delta", () => {
    const t = mount({ float: true }); const r = t.renderer!;
    r.draw({ ...frame(), introActive: true, introTime: 1.2,
      morph: { start: -9, dur: .001, toWord: true, fromWord: false, transit: 0 } }, .016);
    expect(t.uniforms.get("uIntroActive")).toBe(1);
    expect(t.uniforms.get("uIntroTime")).toBe(1.2);
    const count = t.live.size;
    r.draw({ ...frame(), introActive: false,
      morph: { start: 0, dur: .001, toWord: false, fromWord: false, transit: 0 } }, 0);
    expect(t.uniforms.get("uIntroActive")).toBe(0);
    expect(t.uniforms.get("uDt")).toBe(0);
    expect(t.uniforms.get("uInitialize")).toBe(0);
    expect(t.pointCounts).toEqual([65536, 65536]);
    expect(t.live.size).toBe(count);
    r.dispose(); expect(t.live.size).toBe(0);
  });

  it("initializes a changed particle budget from the current terrain without a scatter burst", () => {
    const t = mount({ float: true }); const r = t.renderer!;
    r.draw(frame(), .016);
    const count = t.live.size;
    r.setTier({ ...fullTier, grid: 110, particleSide: 160 });
    r.draw({ ...frame(), profile: 1 }, .016);
    expect(t.pointCounts.at(-1)).toBe(25600);
    const initialized = t.passes.filter(pass => pass.mrt && pass.width === 160 && pass.uniforms.get("uInitialize") === 1);
    expect(initialized.length).toBeGreaterThanOrEqual(1);
    expect(initialized[0].field).toBeDefined();
    expect(initialized[0].uniforms.get("uSpan")).toBe(160);
    expect(initialized[0].uniforms.get("uN")).toBe(110);
    expect(t.live.size).toBe(count);
    r.dispose(); expect(t.live.size).toBe(0);
  });

  it("exposes hold melt and shock input while static tiers ignore interaction", () => {
    const t = mount({ float: true }); const r = t.renderer!;
    expect(typeof r.press).toBe("function");
    expect(typeof r.release).toBe("function");
    expect(typeof r.shock).toBe("function");
    r.press([.5, -.6]);
    for (let index = 0; index < 30; index++) r.draw(frame(), .05);
    expect(r.melt).toBeGreaterThan(.6);
    expect(t.uniforms.get("uMeltP")).toBeGreaterThan(.6);
    r.release();
    for (let index = 0; index < 30; index++) r.draw(frame(), .05);
    expect(r.melt).toBeLessThan(.05);
    r.shock([0, -.5]); r.draw(frame(), .016);
    expect(t.uniforms.get("uShockT")).toBeGreaterThanOrEqual(0);
    r.setTier({ kind: "static", grid: 110, particleSide: 0, dprCap: 1, forceSolid: true });
    const pointCount = t.pointCounts.length;
    r.press([0, -.5]); r.shock([0, -.5]); r.draw(frame(), .05);
    expect(r.melt).toBe(0);
    expect(t.pointCounts).toHaveLength(pointCount);
    expect(r.material).toBe("solid");
    r.dispose(); expect(t.live.size).toBe(0);
  });

  it("keeps solid rendering alive when the real particle allocation fails", () => {
    const t = mount({ float: true }); const r = t.renderer!;
    t.failLargeFloat(); r.draw(frame(), .016);
    expect(r.capabilities.floatTargets).toBe(false);
    expect(r.material).toBe("solid");
    expect(t.callbacks.onLost).not.toHaveBeenCalled();
    expect(t.instances.at(-1)).toBe(25600);
    expect(t.pointCounts).toEqual([]);
    r.dispose(); expect(t.live.size).toBe(0);
  });

  it("uses normal alpha points and skips bloom on paper", () => {
    const t = mount({ float: true }); const r = t.renderer!;
    r.setPalette({ ink: [1, 1, 1], point: [.1, .1, .1], accent: [.3, .6, .2], haze: [.95, .95, .95], light: true });
    r.draw(frame(), .016);
    expect(t.pointCounts).toEqual([65536]);
    expect(t.blends.at(-1)).toEqual([t.gl.SRC_ALPHA, t.gl.ONE_MINUS_SRC_ALPHA]);
    expect(t.uniforms.get("uAmt")).toBe(0);
    r.dispose(); expect(t.live.size).toBe(0);
  });

  it("preserves animated solid terrain pointer feedback without allocating particles", () => {
    const t = mount({ float: true }); const r = t.renderer!;
    r.setPointer([.5, -.6]); r.draw({ ...frame(), lat: 0 }, .05);
    expect(t.uniforms.get("uPtrOn")).toBeGreaterThan(0);
    expect(t.pointCounts).toEqual([]);
    expect(t.floatSizes.every(([width]) => width <= 2)).toBe(true);
    r.dispose(); expect(t.live.size).toBe(0);
  });

  it("returns null when WebGL2 creation is unavailable or throws", () => {
    const canvas = document.createElement("canvas");
    const getContext = vi.spyOn(canvas, "getContext").mockReturnValue(null);
    expect(createWorldRenderer(canvas, { onLost() {}, onRestored() {} })).toBeNull();
    getContext.mockImplementation(() => { throw new Error("disabled GPU"); });
    expect(createWorldRenderer(canvas, { onLost() {}, onRestored() {} })).toBeNull();
  });

  it("owns every GL resource and disposes once, including its context listeners", () => {
    const t = mount({ float: true });
    expect(t.renderer).not.toBeNull();
    expect(t.renderer!.material).toBe("solid");
    t.renderer!.resize(1280, 720, 1.5);
    t.renderer!.draw(frame(), 0);
    t.renderer!.dispose(); t.renderer!.dispose();
    expect(t.live.size).toBe(0);
    t.canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(t.callbacks.onRestored).not.toHaveBeenCalled();
    expect(t.live.size).toBe(0);
  });

  it("replaces resize and downgrade targets without retaining the old allocations", () => {
    const t = mount(); const r = t.renderer!;
    r.resize(800, 600, 1.5);
    r.draw(frame(), 0); // Compare submitted states, each owning exactly one frame fence.
    const count = t.live.size;
    for (let i = 0; i < 5; i++) r.resize(900 + i, 620 + i, 1.5);
    expect(t.live.size).toBe(count);
    r.setTier({ ...fullTier, grid: 110, dprCap: 1, particleSide: 160 });
    r.draw(frame(), 0);
    expect(t.instances.at(-1)).toBe(12100);
    expect(t.uniforms.get("uSpan")).toBe(160);
    expect(t.textures.some(size => size[0] === 110 && size[1] === 110)).toBe(true);
    expect(t.live.size).toBe(count);
    r.dispose(); expect(t.live.size).toBe(0);
  });

  it("checks the actual float MRT framebuffer rather than assuming the extension works", () => {
    const valid = mount({ float: true });
    expect(valid.renderer!.capabilities.floatTargets).toBe(true);
    valid.renderer!.dispose();
    const invalid = mount({ float: true, floatComplete: false });
    expect(invalid.renderer!.capabilities.floatTargets).toBe(false);
    expect(invalid.renderer!.material).toBe("solid");
    invalid.renderer!.draw(frame(), 0);
    expect(invalid.instances.at(-1)).toBe(25600);
    invalid.renderer!.dispose(); expect(invalid.live.size).toBe(0);
  });

  it("draws static tiers with zero delta without allocating a float simulation or scheduling frames", () => {
    const raf = vi.fn(); vi.stubGlobal("requestAnimationFrame", raf);
    const t = mount({ float: true }); const r = t.renderer!;
    r.setTier({ kind: "static", grid: 110, particleSide: 0, dprCap: 1, forceSolid: true });
    const result = r.draw(frame(), 0);
    expect(t.instances).toEqual([12100]);
    expect(t.uniforms.get("uLat")).toBe(0);
    expect(result.cpuMs).toBeGreaterThanOrEqual(0);
    expect(result.gpuMs).toBeNull();
    expect(raf).not.toHaveBeenCalled();
    expect(t.floatSizes.every(([width]) => width <= 2)).toBe(true);
    r.dispose(); vi.unstubAllGlobals();
  });

  it("rebuilds once after context loss and stays failed after a second loss", () => {
    const t = mount({ float: true }); const r = t.renderer!;
    const lost = new Event("webglcontextlost", { cancelable: true });
    t.canvas.dispatchEvent(lost);
    expect(lost.defaultPrevented).toBe(true);
    r.draw(frame(), .016); expect(t.instances).toHaveLength(0);
    t.canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(t.callbacks.onRestored).toHaveBeenCalledTimes(1);
    r.draw(frame(), 0); expect(t.instances).toHaveLength(1);
    expect(t.pointCounts).toEqual([65536]);
    t.canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    t.canvas.dispatchEvent(new Event("webglcontextrestored"));
    r.draw(frame(), 0); expect(t.instances).toHaveLength(1);
    expect(t.callbacks.onLost).toHaveBeenCalledTimes(2);
    r.dispose(); expect(t.live.size).toBe(0);
  });

  it("cleans partial shader compilation failure and failed target replacement", () => {
    const bad = glBoundary(); bad.failShader();
    const canvas = document.createElement("canvas");
    vi.spyOn(canvas, "getContext").mockReturnValue(bad.gl);
    expect(createWorldRenderer(canvas, { onLost() {}, onRestored() {} })).toBeNull();
    expect(bad.live.size).toBe(0);
    const t = mount(); t.failFramebuffer();
    expect(() => t.renderer!.resize(600, 400, 1)).not.toThrow();
    expect(t.callbacks.onLost).toHaveBeenCalledTimes(1);
    t.renderer!.dispose(); expect(t.live.size).toBe(0);
  });

  it("releases a vertex shader when fragment compilation fails without detaching an unattached shader", () => {
    const bad = glBoundary({ shaderFailureAt: 2 });
    const canvas = document.createElement("canvas");
    vi.spyOn(canvas, "getContext").mockReturnValue(bad.gl);
    expect(createWorldRenderer(canvas, { onLost() {}, onRestored() {} })).toBeNull();
    expect(bad.live.size).toBe(0);
    expect(bad.errors).toEqual([]);
  });

  it("reports asynchronous GPU cost separately from CPU cost and deletes completed queries", () => {
    const t = mount({ timer: true }); const r = t.renderer!;
    expect(r.draw(frame(), .016).gpuMs).toBeNull();
    expect(r.draw(frame(), .016).gpuMs).toBe(2.5);
    expect([...t.live].filter(handle => handle.kind === "query")).toHaveLength(1);
    r.dispose(); expect(t.live.size).toBe(0);
  });
});
