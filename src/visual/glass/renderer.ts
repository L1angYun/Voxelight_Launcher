import { clampRadius, normalizeRect } from "./geometry";
import type {
  GlassFrame,
  GlassMode,
  GlassOptics,
  GlassQuality,
  GlassRect,
  GlassRenderer,
  GlassScheduler,
  GlassSurfaceModel,
} from "./types";

interface SchedulerOptions {
  requestFrame: (callback: (time: number) => void) => number;
  cancelFrame: (id: number) => void;
}

export interface GlassRendererOptions {
  onModeChange?: (mode: GlassMode) => void;
  /** Runs before every frame so live surfaces can publish their latest geometry and optics. */
  beforeFrame?: () => void;
}

const restingOptics: GlassOptics = { bendX: 0, bendY: 0, pressure: 0, energy: 0 };

function sameRect(first: GlassRect | undefined, second: GlassRect | undefined): boolean {
  if (!first || !second) return first === second;
  return first.x === second.x && first.y === second.y && first.width === second.width && first.height === second.height;
}

export function sameSurface(first: GlassSurfaceModel, second: GlassSurfaceModel): boolean {
  const a = first.optics ?? restingOptics;
  const b = second.optics ?? restingOptics;
  return (
    first.radius === second.radius &&
    first.opacity === second.opacity &&
    first.active === second.active &&
    first.variant === second.variant &&
    sameRect(first.rect, second.rect) &&
    sameRect(first.clip, second.clip) &&
    a.bendX === b.bendX &&
    a.bendY === b.bendY &&
    a.pressure === b.pressure &&
    a.energy === b.energy
  );
}

export function createGlassScheduler(
  onFrame: (time: number) => void,
  options: SchedulerOptions = {
    requestFrame: (callback) => requestAnimationFrame(callback),
    cancelFrame: (id) => cancelAnimationFrame(id),
  },
): GlassScheduler {
  let quality: GlassQuality = "full";
  let paused = false;
  let disposed = false;
  let pending: number | null = null;
  let frames = 0;

  const request = () => {
    if (disposed || paused || pending !== null) return;
    pending = options.requestFrame((time) => {
      pending = null;
      if (disposed || paused) return;
      frames += 1;
      onFrame(time);
      if (quality === "full") request();
    });
  };

  return {
    get frameCount() {
      return frames;
    },
    get pending() {
      return pending !== null;
    },
    request,
    setQuality(next) {
      quality = next;
      if (quality === "lite" && pending !== null) {
        options.cancelFrame(pending);
        pending = null;
      }
      if (!paused && quality === "full") request();
    },
    pause(next) {
      paused = next;
      if (paused && pending !== null) {
        options.cancelFrame(pending);
        pending = null;
      } else if (!paused && quality === "full") {
        request();
      }
    },
    dispose() {
      disposed = true;
      if (pending !== null) options.cancelFrame(pending);
      pending = null;
    },
  };
}

export function resolveGlassMode({
  webgl2,
  effects,
  reducedTransparency = false,
  highContrast = false,
  contextLost = false,
}: {
  webgl2: boolean;
  effects: GlassQuality;
  reducedTransparency?: boolean;
  highContrast?: boolean;
  contextLost?: boolean;
}): GlassMode {
  if (!webgl2 || reducedTransparency || highContrast || contextLost) return "fallback";
  return effects;
}

function createFallbackRenderer(): GlassRenderer {
  const surfaces = new Map<string, GlassSurfaceModel>();
  return {
    mode: "fallback",
    get surfaceCount() {
      return surfaces.size;
    },
    upsert(surface) {
      surfaces.set(surface.id, surface);
    },
    remove(id) {
      surfaces.delete(id);
    },
    resize() {},
    update() {},
    setQuality() {},
    setBackground() {},
    pause() {},
    dispose() {
      surfaces.clear();
    },
  };
}

const vertexSource = `#version 300 es
in vec2 a_position;
void main() { gl_Position = vec4(a_position, 0.0, 1.0); }
`;

const fragmentSource = `#version 300 es
precision highp float;
uniform vec2 u_resolution;
uniform vec4 u_rect;
uniform float u_radius;
uniform float u_time;
uniform float u_opacity;
uniform float u_quality;
uniform float u_active;
uniform float u_scale;
uniform vec3 u_accent;
uniform sampler2D u_background;
uniform float u_hasBackground;
uniform float u_light;
uniform vec2 u_pointer;
uniform vec2 u_bend;
uniform float u_pressure;
uniform float u_energy;
out vec4 outColor;

float roundedBox(vec2 p, vec2 bounds, float radius) {
  vec2 q = abs(p) - bounds + radius;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - radius;
}

// The silhouette bows toward the side that lags behind a moving surface.
float surfaceDistance(vec2 p) {
  vec2 extent = u_rect.zw * 0.5;
  vec2 q = clamp(p / max(extent, vec2(1.0)), vec2(-1.3), vec2(1.3));
  vec2 sag = vec2(1.0 - q.y * q.y, 1.0 - q.x * q.x);
  float radius = min(u_radius * (1.0 + u_pressure * 0.12), min(extent.x, extent.y));
  return roundedBox(p - u_bend * sag * 0.6, extent, radius);
}

void main() {
  vec2 center = u_rect.xy + u_rect.zw * 0.5;
  vec2 p = gl_FragCoord.xy - center;
  float d = surfaceDistance(p);
  float shape = 1.0 - smoothstep(-1.0, 1.0, d);
  if (shape <= 0.001) discard;

  vec2 uv = gl_FragCoord.xy / u_resolution;
  vec2 local = (gl_FragCoord.xy - u_rect.xy) / max(u_rect.zw, vec2(1.0));
  float time = u_time * 0.00012;

  vec2 slope = vec2(
    surfaceDistance(p + vec2(1.0, 0.0)) - surfaceDistance(p - vec2(1.0, 0.0)),
    surfaceDistance(p + vec2(0.0, 1.0)) - surfaceDistance(p - vec2(0.0, 1.0))
  );
  vec2 outward = normalize(slope + vec2(0.00001));

  float bevel = max(min(min(u_rect.z, u_rect.w) * 0.5, 18.0 * u_scale), 1.0);
  float edge = clamp(1.0 + d / bevel, 0.0, 1.0);
  float rim = exp(-abs(d) / (1.5 * u_scale));
  float inner = exp(-abs(d + 9.0 * u_scale) / (8.0 * u_scale));

  // Near the rim the background is sampled along the surface normal, so a
  // moving or pressed surface visibly bends what lies behind it.
  float lean = (1.0 + u_pressure * 0.25 + u_energy * 0.6) * mix(0.55, 1.0, u_quality);
  vec2 pull = -outward * pow(edge, 1.7) * 12.0 * u_scale * lean / u_resolution;
  vec2 wave = vec2(sin(uv.y * 8.0 + time), cos(uv.x * 6.0 - time)) * 0.002 * u_quality;
  vec2 split = outward * pow(edge, 2.4) * 2.6 * u_scale * (0.4 + u_quality) / u_resolution;
  vec2 at = uv + pull + wave;
  vec3 sampled = vec3(
    texture(u_background, at + split).r,
    texture(u_background, at).g,
    texture(u_background, at - split).b
  );

  // Without a supplied image an analytic light environment stands in; it is a
  // material reflection, not a capture of the page.
  vec3 environment = mix(vec3(0.085, 0.10, 0.12), vec3(0.91, 0.92, 0.93), u_light);
  float blueLight = exp(-pow((local.x + local.y * 0.4 - 0.3 + wave.x * 18.0) * 2.2, 2.0));
  float warmLight = exp(-pow((local.x - local.y * 0.5 - 0.75) * 3.0, 2.0));
  environment += vec3(0.10, 0.18, 0.25) * blueLight * (0.15 + inner * 0.5);
  environment += vec3(0.24, 0.14, 0.09) * warmLight * (0.1 + inner * 0.4);
  vec3 optical = mix(environment, sampled, u_hasBackground);

  vec2 lightDirection = normalize(vec2(-0.45, 0.89));
  float sheen = pow(max(dot(outward, lightDirection), 0.0), 3.0);
  float underside = pow(max(dot(outward, -lightDirection), 0.0), 3.0) * 0.5;
  optical += rim * (sheen * vec3(0.46, 0.53, 0.56) + underside * vec3(0.12, 0.14, 0.17));
  optical += u_accent * inner * u_active * 0.018;

  float interaction = exp(-length((uv - u_pointer) * vec2(1.0, 0.7)) * 10.0) * u_quality;
  optical += vec3(0.42, 0.53, 0.64) * interaction * inner * 0.3;

  float surge = u_energy * (0.35 + 0.65 * rim);
  optical += vec3(0.5, 0.58, 0.66) * surge * 0.55;

  float coverage = 0.1 + inner * 0.3 + rim * 0.6 + u_energy * 0.25;
  outColor = vec4(optical, min(1.0, shape * u_opacity * coverage));
}
`;

interface GLResources {
  program: WebGLProgram;
  buffer: WebGLBuffer;
  texture: WebGLTexture;
  position: number;
  resolution: WebGLUniformLocation | null;
  rect: WebGLUniformLocation | null;
  radius: WebGLUniformLocation | null;
  time: WebGLUniformLocation | null;
  opacity: WebGLUniformLocation | null;
  quality: WebGLUniformLocation | null;
  active: WebGLUniformLocation | null;
  scale: WebGLUniformLocation | null;
  accent: WebGLUniformLocation | null;
  background: WebGLUniformLocation | null;
  hasBackground: WebGLUniformLocation | null;
  light: WebGLUniformLocation | null;
  pointer: WebGLUniformLocation | null;
  bend: WebGLUniformLocation | null;
  pressure: WebGLUniformLocation | null;
  energy: WebGLUniformLocation | null;
}

function createResources(gl: WebGL2RenderingContext): GLResources {
  function shader(type: number, source: string) {
    const result = gl.createShader(type);
    if (!result) throw new Error("Unable to allocate glass shader");
    gl.shaderSource(result, source);
    gl.compileShader(result);
    if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(result);
      gl.deleteShader(result);
      throw new Error(`Glass shader compilation failed: ${log}`);
    }
    return result;
  }
  const vertex = shader(gl.VERTEX_SHADER, vertexSource);
  const fragment = shader(gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) throw new Error("Unable to allocate glass program");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Glass program link failed: ${log}`);
  }
  const buffer = gl.createBuffer();
  const texture = gl.createTexture();
  if (!buffer || !texture) throw new Error("Unable to allocate glass resources");
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
  return {
    program,
    buffer,
    texture,
    position: gl.getAttribLocation(program, "a_position"),
    resolution: gl.getUniformLocation(program, "u_resolution"),
    rect: gl.getUniformLocation(program, "u_rect"),
    radius: gl.getUniformLocation(program, "u_radius"),
    time: gl.getUniformLocation(program, "u_time"),
    opacity: gl.getUniformLocation(program, "u_opacity"),
    quality: gl.getUniformLocation(program, "u_quality"),
    active: gl.getUniformLocation(program, "u_active"),
    scale: gl.getUniformLocation(program, "u_scale"),
    accent: gl.getUniformLocation(program, "u_accent"),
    background: gl.getUniformLocation(program, "u_background"),
    hasBackground: gl.getUniformLocation(program, "u_hasBackground"),
    light: gl.getUniformLocation(program, "u_light"),
    pointer: gl.getUniformLocation(program, "u_pointer"),
    bend: gl.getUniformLocation(program, "u_bend"),
    pressure: gl.getUniformLocation(program, "u_pressure"),
    energy: gl.getUniformLocation(program, "u_energy"),
  };
}

function accentChannels(hex: string): [number, number, number] {
  const normalized = /^#[0-9a-f]{6}$/i.test(hex) ? hex.slice(1) : "b4f17a";
  return [0, 2, 4].map((start) => Number.parseInt(normalized.slice(start, start + 2), 16) / 255) as [number, number, number];
}

export function createGlassRenderer(canvas: HTMLCanvasElement, options: GlassRendererOptions = {}): GlassRenderer {
  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = canvas.getContext("webgl2", { alpha: true, antialias: false, premultipliedAlpha: false });
  } catch {
    gl = null;
  }
  if (!gl) return createFallbackRenderer();

  const surfaces = new Map<string, GlassSurfaceModel>();
  let resources: GLResources | null = null;
  let quality: GlassQuality = "full";
  let mode: GlassMode = "full";
  let dpr = 1;
  let frame: GlassFrame = { time: 0, accent: "#b4f17a", motion: true };
  let disposed = false;
  let drawing = false;
  let background: TexImageSource | null = null;
  let paused = false;

  const emitMode = (next: GlassMode) => {
    mode = next;
    options.onModeChange?.(next);
  };
  const render = (time: number) => {
    if (!resources || disposed || mode === "fallback") return;
    drawing = true;
    try {
      options.beforeFrame?.();
    } finally {
      drawing = false;
    }
    frame = { ...frame, time };
    const current = resources;
    const context = gl!;
    context.disable(context.SCISSOR_TEST);
    context.clearColor(0, 0, 0, 0);
    context.clear(context.COLOR_BUFFER_BIT);
    context.useProgram(current.program);
    context.bindBuffer(context.ARRAY_BUFFER, current.buffer);
    context.enableVertexAttribArray(current.position);
    context.vertexAttribPointer(current.position, 2, context.FLOAT, false, 0, 0);
    context.viewport(0, 0, canvas.width, canvas.height);
    context.enable(context.BLEND);
    context.blendFunc(context.SRC_ALPHA, context.ONE_MINUS_SRC_ALPHA);
    context.enable(context.SCISSOR_TEST);
    context.uniform2f(current.resolution, canvas.width, canvas.height);
    context.uniform1f(current.time, frame.motion ? frame.time : 0);
    context.uniform1f(current.quality, quality === "full" ? 1 : 0);
    context.uniform1f(current.scale, dpr);
    context.uniform3fv(current.accent, accentChannels(frame.accent));
    context.activeTexture(context.TEXTURE0);
    context.bindTexture(context.TEXTURE_2D, current.texture);
    context.uniform1i(current.background, 0);
    context.uniform1f(current.hasBackground, background ? 1 : 0);
    context.uniform1f(current.light, frame.light ? 1 : 0);
    context.uniform2f(current.pointer, frame.pointer?.x ?? -1, frame.pointer?.y ?? -1);
    for (const surface of surfaces.values()) {
      const rect = normalizeRect(surface.rect, dpr);
      if (rect.width <= 0 || rect.height <= 0) continue;
      const x = rect.x;
      const y = canvas.height - (rect.y + rect.height);
      const clip = normalizeRect(surface.clip ?? surface.rect, dpr);
      if (clip.width <= 0 || clip.height <= 0) continue;
      const optics = surface.optics ?? restingOptics;
      context.scissor(Math.floor(clip.x), Math.floor(canvas.height - clip.y - clip.height), Math.ceil(clip.width), Math.ceil(clip.height));
      context.uniform4f(current.rect, x, y, rect.width, rect.height);
      context.uniform1f(current.radius, clampRadius(surface.radius * dpr, rect.width, rect.height));
      context.uniform1f(current.opacity, surface.opacity);
      context.uniform1f(current.active, surface.active ? 1 : 0);
      context.uniform2f(current.bend, optics.bendX * dpr, -optics.bendY * dpr);
      context.uniform1f(current.pressure, optics.pressure);
      context.uniform1f(current.energy, optics.energy);
      context.drawArrays(context.TRIANGLE_STRIP, 0, 4);
    }
  };
  const scheduler = createGlassScheduler(render);
  const requestPaint = () => {
    if (!frame.motion) render(frame.time);
    else scheduler.request();
  };
  const uploadBackground = () => {
    if (!resources || !gl) return;
    gl.bindTexture(gl.TEXTURE_2D, resources.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    if (background) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, background);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
  };

  try {
    resources = createResources(gl);
  } catch (error) {
    console.warn("Glass shader unavailable; using the CSS material", error);
    scheduler.dispose();
    emitMode("fallback");
    return createFallbackRenderer();
  }

  const onLost = (event: Event) => {
    event.preventDefault();
    resources = null;
    scheduler.pause(true);
    emitMode("fallback");
  };
  const onRestored = () => {
    if (disposed || !gl) return;
    try {
      resources = createResources(gl);
      uploadBackground();
      emitMode(quality);
      scheduler.pause(paused);
      if (!frame.motion) render(frame.time);
      else scheduler.request();
    } catch {
      emitMode("fallback");
    }
  };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  return {
    get mode() {
      return mode;
    },
    get surfaceCount() {
      return surfaces.size;
    },
    upsert(surface) {
      const previous = surfaces.get(surface.id);
      surfaces.set(surface.id, surface);
      // A surface that reports an unchanged model needs no repaint, and one that
      // changes while a frame is being prepared is drawn by that same frame.
      if (!drawing && (!previous || !sameSurface(previous, surface))) requestPaint();
    },
    remove(id) {
      surfaces.delete(id);
      requestPaint();
    },
    resize(width, height, nextDpr = 1) {
      dpr = Math.max(0.1, nextDpr);
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      requestPaint();
    },
    update(nextFrame) {
      frame = nextFrame;
      requestPaint();
    },
    setQuality(next) {
      quality = next;
      if (mode !== "fallback") emitMode(next);
      scheduler.setQuality(next);
    },
    setBackground(source) {
      background = source;
      uploadBackground();
      requestPaint();
    },
    pause(next) {
      paused = next;
      scheduler.pause(next);
    },
    dispose() {
      disposed = true;
      scheduler.dispose();
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      if (resources && gl) {
        gl.deleteBuffer(resources.buffer);
        gl.deleteTexture(resources.texture);
        gl.deleteProgram(resources.program);
      }
      resources = null;
      surfaces.clear();
    },
  };
}
