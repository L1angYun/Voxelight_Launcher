// SPDX-License-Identifier: GPL-3.0-only
// Terrain and lighting algorithms ported from the approved crystal-world concept.
const NOISE = `
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vn(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3. - 2. * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) {
  float a = .5, s = 0.;
  for (int i = 0; i < 4; i++) { s += a * vn(p); p = p * 2.03 + vec2(17., 9.); a *= .5; }
  return s;
}`;

export const FULLSCREEN_VERTEX = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p;
  gl_Position = vec4(p * 2. - 1., 0., 1.);
}`;

export const TERRAIN_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uPrev;
uniform float uT, uProfile, uFront, uPtrOn, uDecay, uN, uSpan;
uniform vec2 uPtr, uOrigin, uOffset, uSunXZ;
${NOISE}
float H(vec2 p) {
  float n = fbm(p * .035 + vec2(uT * .006, 0.));
  float ridge = 1. - abs(2. * n - 1.);
  float farSide = 1. - smoothstep(-122., -48., p.y);
  float a = 1. + 9. * n * n + farSide * ridge * ridge * 25.
          + .5 * sin(dot(p, vec2(.13, .09)) + uT * .5);
  float m = 1. - smoothstep(8., 60., length((p - vec2(24., -16.)) * vec2(1., .8)));
  float b = m * m * (4. + pow(fbm(p * .05 + vec2(uT * .005, 3.)), 1.4) * 52.)
          + .25 * sin(dot(p, vec2(.1, .14)) + uT * .5) * m;
  float raw = mix(a, b, uProfile), fl = floor(raw);
  return fl + smoothstep(.82, 1., raw - fl);
}
void main() {
  vec2 p = ((floor(vUv * uN) + .5) / uN - .5) * uSpan + uOffset;
  float h = H(p), shadow = 0.;
  for (int i = 1; i <= 8; i++) {
    float d = float(i) * 2.6;
    shadow = max(shadow, smoothstep(0., 1.6, H(p + uSunXZ * d) - (h + d * .42)));
  }
  float pulse = exp(-pow(length(p - uPtr) / 4.5, 2.)) * uPtrOn;
  h += pulse * 1.5;
  float d0 = length(p - uOrigin);
  float ring = uFront > 0. ? exp(-pow((d0 - uFront) / 3.2, 2.)) : 0.;
  h += ring * 3.2;
  float id = hash(floor(p) + .5);
  float ember = id > .994 ? pow(max(0., sin(uT * .3 + id * 900.)), 60.) * .5 : 0.;
  // Subtract two quantization steps so heat cannot stick after RGBA8 rounding.
  float heat = max(max(0., texture(uPrev, vUv).a * uDecay - 2. / 255.), max(pulse * .72, ember));
  float encoded = floor(clamp(h / 40., 0., 1.) * 65535.);
  float cloud = .42 + .58 * smoothstep(.36, .58, fbm(p * .022 + vec2(-uT * .022, uT * .008) + 4.));
  cloud *= mix(.5, 1., smoothstep(-34., 26., p.x));
  o = vec4(floor(encoded / 256.) / 255., mod(encoded, 256.) / 255., (1. - shadow) * cloud, heat);
}`;

// Shared with the later point pass. uLat=0 is always enforced by the solid renderer.
export const CRYSTAL_GLSL = `
uniform float uLat, uCry, uIsland, uMelt, uMask;
uniform vec2 uOrigin, uMeltAt;
float maskM(vec2 c) {
  float q = 1. - (length((c - vec2(24., -16.)) * vec2(1., .8)) - 14.) / 64.;
  return clamp(1. - uMask * (1. - smoothstep(0., 1., q)), 0., 1.);
}
float crystal(vec2 c, float heat, float m) {
  float d = length(c - uOrigin);
  float island = 1. - smoothstep(uIsland, uIsland + 18., d);
  float front = uCry > 0. ? 1. - smoothstep(uCry - 16., uCry, d) : 0.;
  float trail = smoothstep(.56, .7, heat) * .8;
  float core = uMask * m * m;
  float melt = uMelt * exp(-pow(length(c - uMeltAt) / 9., 2.));
  return mix(1., max(max(island, front), max(trail, core)) * (1. - melt), uLat);
}`;

export const VOXEL_VERTEX = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNor;
uniform sampler2D uField;
uniform mat4 uVP;
uniform vec2 uOffset;
uniform float uN, uSpan, uFront, uCharge;
${CRYSTAL_GLSL}
out vec3 vN, vW, vL;
out float vH, vM, vHeat, vLit, vChg;
void main() {
  ivec2 id = ivec2(gl_InstanceID % int(uN), gl_InstanceID / int(uN));
  vec4 f = texelFetch(uField, id, 0);
  float h = (f.r * 255. * 256. + f.g * 255.) / 65535. * 40.;
  vec2 c = ((vec2(id) + .5) / uN - .5) * uSpan + uOffset;
  float m = maskM(c), cr = crystal(c, f.a, m);
  float crE = cr * cr * (3. - 2. * cr);
  float pitch = uSpan / uN;
  float s = mix(.13, .97, m * m) * pitch * mix(1., step(.03, cr) * mix(.16, 1., crE), uLat);
  float depth = mix(s, 9., m * mix(1., crE, uLat));
  vec3 p = vec3(c.x + aPos.x * s, aPos.y > 0. ? h : h - depth, c.y + aPos.z * s);
  vN = aNor; vW = p; vL = aPos; vH = h; vM = m; vHeat = f.a; vLit = f.b;
  float d = length(c - uOrigin);
  vChg = uCharge * (1. - smoothstep(uFront - 30., uFront, d));
  if (uFront > 0.) vHeat = max(vHeat, uCharge * exp(-pow((d - uFront) / 2.4, 2.)));
  gl_Position = uVP * vec4(p, 1.);
}`;

export const VOXEL_FRAGMENT = `#version 300 es
precision highp float;
in vec3 vN, vW, vL;
in float vH, vM, vHeat, vLit, vChg;
out vec4 o;
uniform vec3 uEye, uAccent, uSun, uHaze, uPoint;
uniform float uExposure, uFogD, uDim, uLight;
void main() {
  float diff = max(dot(vN, uSun), 0.) * vLit;
  vec3 alb = mix(vec3(.26, .27, .28), vec3(1., .97, .9), smoothstep(4., 17., vH));
  alb = mix(uPoint * .62, alb, smoothstep(0., .35, vM));
  vec3 col = alb * (vec3(.05, .06, .085) + vec3(2.5, 2.1, 1.62) * diff);
  col += alb * vec3(.03, .05, .08) * max(vN.z, 0.);
  if (vN.y > .5) col += smoothstep(.45, .5, max(abs(vL.x), abs(vL.z))) * .035 * (.2 + vLit);
  col *= uExposure;
  col = mix(col, col * .55 + uAccent * .3 * (.25 + vLit), vChg * .55);
  col = mix(col, uAccent * (1. + vHeat * 1.2), clamp(vHeat * 1.05, 0., 1.) * uDim);
  // On paper, retain diffuse relief without dark fog or emitted light.
  vec3 paper = mix(uHaze, uPoint, .12 + .54 * (1. - diff)) * mix(.75, 1., uExposure);
  paper = mix(paper, uAccent, clamp(vHeat * .55 + vChg * .2, 0., .65));
  col = mix(col, paper, uLight);
  float fog = (1. - exp(-pow(length(vW - uEye) / uFogD, 2.4))) * .96;
  o = vec4(mix(col, uHaze, fog), 1.);
}`;

export const SKY_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform vec3 uHaze, uInk, uPoint;
uniform float uHorizon, uDots, uDotPx, uLight;
void main() {
  float t = smoothstep(0., .5, vUv.y - uHorizon);
  vec3 c = mix(uHaze, uInk, pow(t, .55));
  vec2 g = fract(gl_FragCoord.xy / uDotPx) - .5;
  float d = (1. - smoothstep(.07, .13, length(g))) * .2 * uDots * smoothstep(0., .2, vUv.y - .38);
  c = mix(c + uPoint * d, mix(c, uPoint, d), uLight);
  o = vec4(c, 1.);
}`;

export const THRESHOLD_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
void main() {
  vec3 c = texture(uTex, vUv).rgb;
  o = vec4(c * smoothstep(.6, .82, max(c.r, max(c.g, c.b))), 1.);
}`;

export const BLUR_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
uniform vec2 uDir;
void main() {
  vec3 c = texture(uTex, vUv).rgb * .227;
  c += (texture(uTex, vUv + uDir * 1.38).rgb + texture(uTex, vUv - uDir * 1.38).rgb) * .316;
  c += (texture(uTex, vUv + uDir * 3.23).rgb + texture(uTex, vUv - uDir * 3.23).rgb) * .07;
  o = vec4(c, 1.);
}`;

export const COMPOSITE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex, uBloom;
uniform float uAmt;
float dither(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec3 c = texture(uTex, vUv).rgb + texture(uBloom, vUv).rgb * uAmt;
  c += (dither(gl_FragCoord.xy) - .5) / 255.;
  o = vec4(c, 1.);
}`;
