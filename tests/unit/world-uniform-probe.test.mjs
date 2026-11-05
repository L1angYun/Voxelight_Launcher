// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

// The fake is the browser/GPU boundary; the serialized installer and reader run unchanged.
const probe = await import('../e2e/helpers/world-uniform-probe.ts').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});

function browser() {
  let serial = 0, clock = 123, reads = 0;
  const calls = [];
  class Canvas extends EventTarget {
    isConnected = true;
    world = { dataset: { worldFrames: '12' } };
    matches(selector) { return selector === '.world-scene__canvas' && this.world !== null; }
    closest(selector) { return selector === '.world-scene' ? this.world : null; }
  }
  class GL {
    CURRENT_PROGRAM = 1; LINK_STATUS = 2;
    current = null; lost = false;
    constructor(canvas) { this.canvas = canvas; canvas.gl = this; }
    createProgram() { return { id: ++serial, live: true, linked: true, values: new Map(), missing: new Set() }; }
    deleteProgram(program) { calls.push(['delete', this, program]); program.live = false; }
    linkProgram(program) { calls.push(['link', this, program]); program.linked = true; program.values.clear(); }
    isProgram(program) { return program.live; }
    getProgramParameter(program, parameter) { assert.equal(parameter, this.LINK_STATUS); return program.linked; }
    getParameter(parameter) { assert.equal(parameter, this.CURRENT_PROGRAM); return this.current; }
    getUniformLocation(program, name) {
      calls.push(['locate', this, program, name]);
      return program.missing.has(name) ? null : { program, name };
    }
    uniform1f(location, value) {
      calls.push(['submit', this, location, value]);
      if (value === 'throw') throw new Error('native submission failure');
      if (location && this.current === location.program && location.program.live)
        location.program.values.set(location.name, Math.fround(value));
      return 'native-return';
    }
    getUniform(program, location) { reads++; assert.equal(program, location.program); return program.values.get(location.name) ?? null; }
    isContextLost() { return this.lost; }
  }
  const canvas = new Canvas(), gl = new GL(canvas), active = [canvas];
  const globals = { window: {}, HTMLCanvasElement: Canvas, WebGL2RenderingContext: GL,
    document: { querySelectorAll: () => active }, performance: { now: () => clock } };
  const context = vm.createContext(globals);
  const run = fn => vm.runInContext(`(${fn.toString()})()`, context);
  const install = () => run(probe.installWorldUniformProbeInBrowser);
  const read = () => JSON.parse(JSON.stringify(run(probe.readWorldUniformProbe)));
  function program(names, contextGL = gl) {
    const handle = contextGL.createProgram(), locations = {};
    for (const name of names) locations[name] = contextGL.getUniformLocation(handle, name);
    return { handle, locations, gl: contextGL };
  }
  function write(target, values) {
    target.gl.current = target.handle;
    for (const [name, value] of Object.entries(values)) target.gl.uniform1f(target.locations[name], value);
  }
  function scene() {
    const terrain = program(['uPrev', 'uProfile', 'uT']);
    const voxel = program(['uField', 'uVP', 'uCharge', 'uLat', 'uCry', 'uIsland']);
    write(terrain, { uT: 9.7 }); write(voxel, { uLat: 1, uCry: 0, uIsland: 9 });
    return { terrain, voxel };
  }
  function pin(value) {
    const proto = GL.prototype, locate = proto.getUniformLocation, submit = proto.uniform1f;
    const names = new WeakMap();
    proto.getUniformLocation = function(program, name) {
      const location = locate.call(this, program, name);
      if (location) names.set(location, name);
      return location;
    };
    proto.uniform1f = function(location, supplied) {
      return submit.call(this, location, location && names.get(location) === 'uT'
        && this.canvas instanceof Canvas && this.canvas.closest('.world-scene') ? value : supplied);
    };
  }
  return { install, read, program, write, scene, pin, gl, canvas, active, calls, GL, Canvas,
    setClock(value) { clock = value; }, get reads() { return reads; } };
}

test('probe exposes a serialized browser installer and reader', () => {
  assert.equal(typeof probe.installWorldUniformProbeInBrowser, 'function');
  assert.equal(typeof probe.readWorldUniformProbe, 'function');
});

test('snapshot selects the voxel trio and terrain clock without reading uniforms on writes', () => {
  const b = browser(); b.install(); b.scene();
  const points = b.program(['uField', 'uVP', 'uLat', 'uCry', 'uIsland']);
  b.write(points, { uLat: .2, uCry: 99, uIsland: -18 });
  assert.equal(b.reads, 0);
  const sample = b.read();
  assert.deepEqual([sample.uLat, sample.uCry, sample.uIsland, sample.uT], [1, 0, 9, Math.fround(9.7)]);
  assert.equal(sample.atMs, 123); assert.equal(sample.worldFrames, 12);
  assert.equal(b.reads, 4);
  assert.ok(sample.contextId > 0 && sample.voxelProgramId > 0 && sample.terrainProgramId > 0);
  assert.notEqual(sample.voxelProgramId, sample.terrainProgramId);
});

test('fresh write serials distinguish identical submitted values from repeated diagnostic reads', () => {
  const b = browser(); b.install(); const s = b.scene();
  const first = b.read(), repeated = b.read();
  assert.deepEqual(repeated.writes, first.writes);
  b.canvas.world.dataset.worldFrames = '13'; b.setClock(523);
  b.write(s.terrain, { uT: 10 }); b.write(s.voxel, { uLat: 1, uCry: 0, uIsland: 9 });
  const fresh = b.read();
  for (const key of ['uLat', 'uCry', 'uIsland', 'uT']) assert.ok(fresh.writes[key] > first.writes[key]);
  assert.equal(fresh.worldFrames, 13); assert.equal(fresh.atMs, 523);
});

for (const order of ['observer-first', 'pin-first']) test(`clock pin ${order} records the actual GPU float and preserves other uniforms`, () => {
  const b = browser();
  if (order === 'pin-first') b.pin(188);
  b.install();
  if (order === 'observer-first') b.pin(188);
  b.scene();
  const sample = b.read();
  assert.deepEqual([sample.uLat, sample.uCry, sample.uIsland, sample.uT], [1, 0, 9, 188]);
});

test('deleted programs cannot supply old uniforms and replacement programs have new identities', () => {
  const b = browser(); b.install(); const s = b.scene(), first = b.read();
  b.gl.deleteProgram(s.voxel.handle);
  assert.throws(b.read, /voxel|program/i);
  const voxel = b.program(['uField', 'uVP', 'uCharge', 'uLat', 'uCry', 'uIsland']);
  b.write(voxel, { uLat: 1, uCry: 0, uIsland: 5 });
  assert.notEqual(b.read().voxelProgramId, first.voxelProgramId);
  assert.equal(b.read().uIsland, 5);
});

test('relinking invalidates locations and an incomplete latest program cannot fall back to stale values', () => {
  const b = browser(); b.install(); const s = b.scene(); b.read();
  b.gl.linkProgram(s.voxel.handle);
  assert.throws(b.read, /voxel|program|uniform/i);
  for (const name of Object.keys(s.voxel.locations)) s.voxel.locations[name] = b.gl.getUniformLocation(s.voxel.handle, name);
  b.write(s.voxel, { uLat: 1, uCry: 0 });
  assert.throws(b.read, /missing|incomplete|uniform/i);
  b.write(s.voxel, { uIsland: 9 });
  assert.equal(b.read().uIsland, 9);
});

test('a newer matching program without complete writes blocks an older complete generation', () => {
  const b = browser(); b.install(); b.scene(); b.read();
  const latest = b.program(['uField', 'uVP', 'uCharge', 'uLat', 'uCry', 'uIsland']);
  assert.throws(b.read, /missing|incomplete|uniform/i);
  b.write(latest, { uLat: 1, uCry: 0, uIsland: 5 });
  assert.equal(b.read().uIsland, 5);
});

test('an optimized-out required location and an unlinked program cannot supply a tuple', () => {
  const b = browser(); b.install(); const s = b.scene();
  s.voxel.handle.missing.add('uIsland');
  s.voxel.locations.uIsland = b.gl.getUniformLocation(s.voxel.handle, 'uIsland');
  assert.throws(b.read, /missing|incomplete|uniform/i);
  s.voxel.handle.linked = false;
  assert.throws(b.read, /program/i);
});

test('nonworld canvas writes and detached world canvases cannot contaminate a sample', () => {
  const b = browser(); b.install(); b.scene(); const first = b.read();
  const canvas = new b.Canvas(); canvas.world = null; const gl = new b.GL(canvas);
  const voxel = b.program(['uField', 'uVP', 'uCharge', 'uLat', 'uCry', 'uIsland'], gl);
  b.write(voxel, { uLat: .1, uCry: 88, uIsland: -18 });
  assert.deepEqual(b.read(), first);
  b.canvas.isConnected = false; assert.throws(b.read, /canvas/i);
});

test('loss and restoration on the same GL object require a new generation and fresh programs', () => {
  const b = browser(); b.install(); b.scene(); const first = b.read();
  b.gl.lost = true; b.canvas.dispatchEvent(new Event('webglcontextlost'));
  assert.throws(b.read, /lost|context/i);
  b.gl.lost = false; b.canvas.dispatchEvent(new Event('webglcontextrestored'));
  assert.throws(b.read, /program|uniform/i);
  b.scene(); const restored = b.read();
  assert.notEqual(restored.contextId, first.contextId);
  assert.notEqual(restored.voxelProgramId, first.voxelProgramId);
});

test('replacement canvases cannot reuse an earlier world context or unrelated canvas uniforms', () => {
  const b = browser(); b.install(); b.scene(); const first = b.read();
  const canvas = new b.Canvas(), gl = new b.GL(canvas);
  const terrain = b.program(['uPrev', 'uProfile', 'uT'], gl);
  const voxel = b.program(['uField', 'uVP', 'uCharge', 'uLat', 'uCry', 'uIsland'], gl);
  b.write(terrain, { uT: 20 }); b.write(voxel, { uLat: 1, uCry: 0, uIsland: 5 });
  assert.equal(b.read().contextId, first.contextId);
  b.active[0] = canvas;
  const second = b.read(); assert.notEqual(second.contextId, first.contextId); assert.equal(second.uIsland, 5);
  b.active.push(b.canvas); assert.throws(b.read, /canvas/i);
});

test('missing writes and nonfinite GPU values never become zero-valued samples', () => {
  for (const value of [undefined, null, NaN, Infinity]) {
    const b = browser(); b.install(); const s = b.scene();
    if (value === undefined) s.voxel.handle.values.delete('uIsland');
    else s.voxel.handle.values.set('uIsland', value);
    assert.throws(b.read, /uniform|finite|missing/i);
  }
  const b = browser(); b.install();
  assert.throws(b.read, /context|program/i);
});

test('invalid ownership and null locations are forwarded without creating accepted writes', () => {
  const b = browser(); b.install(); const s = b.scene(), first = b.read();
  b.gl.current = s.terrain.handle;
  b.gl.uniform1f(s.voxel.locations.uIsland, -18);
  assert.equal(b.gl.uniform1f(null, 4), 'native-return');
  const after = b.read(); assert.equal(after.uIsland, 9); assert.deepEqual(after.writes, first.writes);
  assert.throws(() => b.gl.uniform1f(s.terrain.locations.uT, 'throw'), /native submission failure/);
  assert.deepEqual(b.read().writes, first.writes);
});

test('installer is idempotent and forwards exact original receivers, locations, and return values', () => {
  const b = browser(); b.install(); const wrapped = b.GL.prototype.uniform1f; b.install();
  assert.equal(b.GL.prototype.uniform1f, wrapped);
  const s = b.scene(); b.gl.current = s.voxel.handle;
  const result = b.gl.uniform1f(s.voxel.locations.uIsland, 7.25);
  assert.equal(result, 'native-return');
  const call = b.calls.at(-1);
  assert.equal(call[1], b.gl); assert.equal(call[2], s.voxel.locations.uIsland); assert.equal(call[3], 7.25);
  assert.equal(b.read().uIsland, 7.25);
});
