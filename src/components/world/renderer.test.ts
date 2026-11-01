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
  const uniforms = new Map<string, number>();
  const attached = new Map<Handle, Set<Handle>>(), errors: string[] = [];
  let compiled = 0;
  let failShader = false, failFramebuffer = false, floatAttachment = false;
  let currentInternalFormat = 0;
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
    texImage2D: (_target: number, _level: number, internal: number, width: number, height: number) => {
      currentInternalFormat = internal; textures.push([width, height]);
    },
    framebufferTexture2D: () => { floatAttachment ||= currentInternalFormat === constant("RGBA32F"); },
    checkFramebufferStatus: () => failFramebuffer || (floatAttachment && options.floatComplete === false) ? 0 : constant("FRAMEBUFFER_COMPLETE"),
    drawArraysInstanced: (_mode: number, _first: number, _count: number, count: number) => instances.push(count),
    getQueryParameter: (_query: Handle, name: number) => name === constant("QUERY_RESULT_AVAILABLE") ? true : 2_500_000,
    getError: () => constant("NO_ERROR"), isContextLost: () => false,
  };
  for (const name of ["shaderSource", "compileShader", "linkProgram", "bindTexture", "texParameteri",
    "bindFramebuffer", "drawBuffers", "bindRenderbuffer", "renderbufferStorageMultisample", "renderbufferStorage", "framebufferRenderbuffer",
    "bindBuffer", "bufferData", "bindVertexArray", "enableVertexAttribArray", "vertexAttribPointer", "useProgram", "uniform1i",
    "uniform2f", "uniform3fv", "uniformMatrix4fv", "activeTexture", "viewport", "clearColor", "clear", "enable", "disable",
    "depthMask", "cullFace", "frontFace", "drawArrays", "blitFramebuffer", "beginQuery", "endQuery", "blendFunc"]) methods[name] = noOp;
  function constant(name: string) { if (!constants.has(name)) constants.set(name, enumSequence++); return constants.get(name)!; }
  const gl = new Proxy(methods, { get: (target, name: string) => /^[A-Z][A-Z_0-9]+$/.test(name) ? constant(name) : target[name] }) as unknown as WebGL2RenderingContext;
  return { gl, live, textures, instances, uniforms, errors, failShader: () => { failShader = true; }, failFramebuffer: () => { failFramebuffer = true; } };
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
    r.dispose(); vi.unstubAllGlobals();
  });

  it("rebuilds once after context loss and stays failed after a second loss", () => {
    const t = mount(); const r = t.renderer!;
    const lost = new Event("webglcontextlost", { cancelable: true });
    t.canvas.dispatchEvent(lost);
    expect(lost.defaultPrevented).toBe(true);
    r.draw(frame(), .016); expect(t.instances).toHaveLength(0);
    t.canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(t.callbacks.onRestored).toHaveBeenCalledTimes(1);
    r.draw(frame(), 0); expect(t.instances).toHaveLength(1);
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
