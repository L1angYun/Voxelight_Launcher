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

// Shared by the voxel and point passes so both materials use the same boundary.
export const CRYSTAL_GLSL = `
uniform float uLat, uCry, uIsland, uMelt, uMask;
uniform vec2 uOrigin, uMeltAt;
float maskM(vec2 c) {
  float q = 1. - (length((c - vec2(24., -16.)) * vec2(1., .8)) - 14.) / 64.;
  return clamp(1. - uMask * (1. - smoothstep(0., 1., q)), 0., 1.);
}
float crystal(vec2 c, float heat, float m) {
  float d = length(c - uOrigin);
  float island = 1. - smoothstep(uIsland, uIsland + 10., d);
  float front = uCry > 0. ? 1. - smoothstep(uCry - 16., uCry, d) : 0.;
  float trail = smoothstep(.56, .7, heat) * .8;
  float core = uMask * m * m;
  float melt = uMelt * exp(-pow(length(c - uMeltAt) / 9., 2.));
  return mix(1., max(max(island, front), max(trail, core)) * (1. - melt), uLat);
}`;

export const SIMULATION_FRAGMENT = `#version 300 es
precision highp float;
layout(location=0) out vec4 oP;
layout(location=1) out vec4 oV;
uniform sampler2D uPos, uVel, uField, uWord;
uniform float uN, uS, uSpan, uTime, uDt, uInitialize, uIntroActive, uIntroTime;
uniform float uMorphStart, uMorphDur, uToWord, uFromWord, uTransit, uMeltP, uPtrOn, uShockT, uRing;
uniform vec2 uOffset, uPtr, uPtrVel, uMeltAtP, uShockAt, uOriginP;
float rnd(vec2 p) {
  p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19);
  return fract((p.x + p.y) * p.x);
}
vec3 abc(vec3 p, float t) {
  return vec3(sin(p.z + t * .13) + .43 * cos(p.y - t * .11),
    .7 * sin(p.x + t * .07) + cos(p.z + t * .05),
    .43 * sin(p.y - t * .09) + .7 * cos(p.x + t * .12));
}
void main() {
  ivec2 id = ivec2(gl_FragCoord.xy);
  vec2 uv = (vec2(id) + .5) / uS;
  vec2 site = (uv - .5) * uSpan + uOffset;
  vec4 f = texelFetch(uField, clamp(ivec2(uv * uN), ivec2(0), ivec2(int(uN) - 1)), 0);
  float h = (f.r * 255. * 256. + f.g * 255.) / 65535. * 40.;
  vec3 terrain = vec3(site.x, h + .62, site.y);
  // New tiers start on the current GPU terrain, never in a random scatter.
  if (uInitialize > .5) { oP = vec4(terrain, 0.); oV = vec4(0.); return; }
  vec4 P = texelFetch(uPos, id, 0), V = texelFetch(uVel, id, 0), W = texelFetch(uWord, id, 0);
  // A skip or deadline is immediate, including a zero-delta frame. Ordinary
  // particles have no word weight and retain their current motion.
  if (uIntroActive < .5 && P.w > 0.) { oP = vec4(terrain, 0.); oV = vec4(0.); return; }
  float seed = rnd(uv), seed2 = rnd(uv + .37);
  // The 2.5-second entrance has its own bounded motion, driven by real phase
  // time. Ordinary particles keep the spring/ABC simulation below unchanged.
  if (uIntroActive > .5 && W.w > .5) {
    float order = seed * .45 + uv.x * .55;
    if (uToWord > .5) {
      float t = clamp((uIntroTime - order * .2) / .6, 0., 1.);
      float eased = t * t * (3. - 2. * t);
      float rate = t > 0. && t < 1. ? 6. * t * (1. - t) / .6 : 0.;
      vec3 cloud = W.xyz + vec3((seed - .5) * 10., (seed2 - .5) * 8., (rnd(uv + .73) - .5) * 4.);
      oP = vec4(mix(cloud, W.xyz, eased), .05 + .95 * eased);
      oV = vec4((W.xyz - cloud) * rate, 0.); return;
    }
    if (uFromWord > .5) {
      float t = clamp((uIntroTime - order * .15) / .75, 0., 1.);
      float eased = t * t * (3. - 2. * t);
      float rate = t > 0. && t < 1. ? 6. * t * (1. - t) / .75 : 0.;
      oP = vec4(mix(W.xyz, terrain, eased), 1. - eased);
      oV = vec4((terrain - W.xyz) * rate, 0.); return;
    }
  }
  float releaseAt = uMorphStart + (seed * .45 + uv.x * .55) * uMorphDur;
  float since = uTime - releaseAt;
  bool after = since >= 0.;
  bool word = uIntroActive > .5 && W.w > .5 && (uToWord > .5 ? after : (uFromWord > .5 && !after));
  vec3 goal = word ? W.xyz : terrain;
  float k = after ? 38. * smoothstep(.05, .75, since) : 38.;
  float flow = after ? uTransit * (1. - smoothstep(0., 1., since)) : 0.;
  float dm = length(P.xz - uMeltAtP);
  float hf = uMeltP * exp(-dm * dm / 81.);
  k *= 1. - .97 * hf; flow += hf * 42.;
  vec3 acc = (goal - P.xyz) * k;
  acc += abc(P.xyz * .16 + vec3(seed, seed2, seed + seed2) * 6.2831, uTime) * flow;
  acc += vec3(-(P.z - uMeltAtP.y), 0., P.x - uMeltAtP.x) * hf * 3.;
  acc.y += hf * 14.;
  vec2 dp = P.xz - uPtr;
  float dd = length(dp), fp = exp(-dd * dd / 30.) * uPtrOn;
  vec2 n = dp / max(dd, .001);
  acc.xz += (n * 150. + vec2(-n.y, n.x) * 70. + uPtrVel * 5.) * fp;
  acc.y += fp * 80.;
  float st = uTime - uShockT;
  if (st > 0. && st < 1.8) {
    vec2 ds = P.xz - uShockAt; float l = length(ds);
    float e = exp(-pow((l - st * 42.) / 4.5, 2.)) * (1. - st / 1.8);
    acc.xz += ds / max(l, .001) * e * 520.; acc.y += e * 520.;
  }
  if (uRing > 0.) {
    float e = exp(-pow((length(site - uOriginP) - uRing) / 3.2, 2.));
    acc.y += e * 360. * (.4 + seed);
  }
  vec3 velocity = (V.xyz + acc * uDt) * exp(-6.5 * uDt);
  P.xyz += velocity * uDt;
  P.w += ((word ? 1. : 0.) - P.w) * min(1., uDt * (word ? 3. : 6.));
  oP = P; oV = vec4(velocity, hf);
}`;

export const POINT_VERTEX = `#version 300 es
uniform sampler2D uPos, uVel, uField;
uniform mat4 uVP;
uniform vec3 uEye;
uniform vec2 uOffset;
uniform float uN, uS, uSpan, uDpr, uFogD, uRunDim, uFront, uPointGain, uHome;
${CRYSTAL_GLSL}
out float vAlpha, vHot;
void main() {
  ivec2 id = ivec2(gl_VertexID % int(uS), gl_VertexID / int(uS));
  vec4 P = texelFetch(uPos, id, 0), V = texelFetch(uVel, id, 0);
  vec2 uv = (vec2(id) + .5) / uS, c = (uv - .5) * uSpan + uOffset;
  vec4 f = texelFetch(uField, clamp(ivec2(uv * uN), ivec2(0), ivec2(int(uN) - 1)), 0);
  float h = (f.r * 255. * 256. + f.g * 255.) / 65535. * 40.;
  float cr = crystal(c, f.a, maskM(c)), speed = length(V.xyz), dist = length(P.xyz - uEye);
  float fog = exp(-pow(dist / (uFogD * 1.12), 3.));
  float flying = smoothstep(.6, 3.5, length(P.xz - c));
  float alpha = (.42 + 1.47 * f.b * (.55 + .45 * smoothstep(3., 20., h))) * (1. + .5 * uHome * smoothstep(10., 26., h)) * (1. - smoothstep(.35, .9, cr));
  alpha = min(max(alpha, flying * .55) * fog * uRunDim * uPointGain, .85);
  vAlpha = mix(alpha, .95, P.w) * uLat;
  vHot = clamp((speed - 7.) * .035 + V.w * 1.2, 0., 1.);
  if (uFront > 0.) vHot = max(vHot, exp(-pow((length(c - uOrigin) - uFront) / 3.2, 2.)));
  gl_Position = uVP * vec4(P.xyz, 1.);
  gl_PointSize = uDpr * (1.15 + P.w * .9 + min(speed, 30.) * .035) * clamp(58. / max(dist, .001), mix(.72, 1.05, uHome), 2.7) * (1. + .45 * uHome * smoothstep(8., 26., h));
}`;

export const POINT_FRAGMENT = `#version 300 es
precision highp float;
in float vAlpha, vHot;
out vec4 o;
uniform vec3 uAccent, uPoint;
uniform float uLight, uPaperInk;
void main() {
  float d = 1. - smoothstep(.3, .5, length(gl_PointCoord - .5));
  float alpha = d * vAlpha * mix(1., uPaperInk, uLight);
  if (alpha < .004) discard;
  vec3 color = mix(uPoint, uAccent, vHot);
  o = uLight > .5 ? vec4(color, alpha) : vec4(color * alpha * (1. + vHot), 1.);
}`;

export const VOXEL_VERTEX = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNor;
uniform sampler2D uField;
uniform mat4 uVP;
uniform vec2 uOffset;
uniform float uN, uSpan, uFront, uCharge;
uniform float uLight;
${CRYSTAL_GLSL}
out vec3 vN, vW, vL;
out float vH, vM, vHeat, vLit, vChg, vIsland;
void main() {
  ivec2 id = ivec2(gl_InstanceID % int(uN), gl_InstanceID / int(uN));
  vec4 f = texelFetch(uField, id, 0);
  float h = (f.r * 255. * 256. + f.g * 255.) / 65535. * 40.;
  vec2 c = ((vec2(id) + .5) / uN - .5) * uSpan + uOffset;
  float m = maskM(c), cr = crystal(c, f.a, m);
  float crE = cr * cr * (3. - 2. * cr);
  float pitch = uSpan / uN;
  float s = mix(.13, .97, m * m) * pitch * mix(1., step(.03, cr) * mix(.16, 1., crE), uLat);
  float depth = mix(s, 3., m * mix(1., crE * crE * crE, uLat));
  vec3 p = vec3(c.x + aPos.x * s, aPos.y > 0. ? h : h - depth, c.y + aPos.z * s);
  vN = aNor; vW = p; vL = aPos; vH = h; vM = m; vHeat = f.a; vLit = f.b;
  float d = length(c - uOrigin);
  float isl = 1. - smoothstep(uIsland, uIsland + 10., d);
  vIsland = isl;
  vLit = max(vLit, mix(1.25, 1.1, uLight) * uLat * isl);
  vChg = uCharge * (1. - smoothstep(uFront - 30., uFront, d));
  if (uFront > 0.) vHeat = max(vHeat, uCharge * exp(-pow((d - uFront) / 2.4, 2.)));
  gl_Position = uVP * vec4(p, 1.);
}`;

export const VOXEL_FRAGMENT = `#version 300 es
precision highp float;
in vec3 vN, vW, vL;
in float vH, vM, vHeat, vLit, vChg, vIsland;
out vec4 o;
uniform vec3 uEye, uAccent, uSun, uHaze, uPoint;
uniform float uExposure, uFogD, uDim, uLight, uLat, uPaperInk;
void main() {
  float diff = max(dot(vN, uSun), 0.) * vLit;
  vec3 alb = mix(vec3(.26, .27, .28), vec3(1., .97, .9), smoothstep(4., 17., vH));
  alb = mix(uPoint * .62, alb, smoothstep(0., .35, vM));
  alb = max(alb, vec3(.6, .588, .552) * uLat * vIsland);
  vec3 col = alb * (vec3(.05, .06, .085) + vec3(2.5, 2.1, 1.62) * diff);
  col += alb * vec3(.03, .05, .08) * max(vN.z, 0.);
  if (vN.y > .5) col += smoothstep(.45, .5, max(abs(vL.x), abs(vL.z))) * .035 * (.2 + vLit);
  col *= uExposure;
  vec3 k = max(col - .8, 0.);
  vec3 sh = min(col, .8) + k / (1. + 5. * k);
  col = mix(sh, col, uLight);
  col = mix(col, col * .55 + uAccent * .3 * (.25 + vLit), vChg * .55);
  col = mix(col, uAccent * (1. + vHeat * 1.2), clamp(vHeat * 1.05, 0., 1.) * uDim);
  // On paper, retain diffuse relief without dark fog or emitted light.
  vec3 paper = mix(uHaze, uPoint, (.12 + .54 * (1. - diff)) * uPaperInk) * mix(1., mix(.75, 1., uExposure), uPaperInk);
  paper = mix(paper, uAccent, clamp(vHeat * .55 + vChg * .2, 0., .65) * uPaperInk);
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
uniform float uAmt, uFlash;
float dither(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec3 c = texture(uTex, vUv).rgb + texture(uBloom, vUv).rgb * uAmt;
  c *= 1. + uFlash;
  c += (dither(gl_FragCoord.xy) - .5) / 255.;
  o = vec4(c, 1.);
}`;
