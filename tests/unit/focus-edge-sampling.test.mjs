import assert from 'node:assert/strict';
import test from 'node:test';
import { focusEdgeSamples } from '../e2e/helpers/focus-edge-sampling.ts';

test('edge median measures the complete adjacent one-pixel line and records isolated dark ink separately', () => {
 const pixels=Buffer.alloc(40*40*4,255);
 // Offset 2 + width 2 + 1 gives a top sampling line at y=5, x=10..29.
 for(let x=10;x<30;x++){const i=(5*40+x)*4;pixels[i]=240;pixels[i+1]=238;pixels[i+2]=230;}
 pixels[(5*40+20)*4]=pixels[(5*40+20)*4+1]=pixels[(5*40+20)*4+2]=0;
 const edges=focusEdgeSamples({width:40,height:40,pixels},{left:10,right:30,top:10,bottom:30},'2px','2px',[90,146,5]);
 assert.equal(edges.length,4);
 const top=edges.find(e=>e.side==='top');
 assert.equal(top.count,20);assert.deepEqual(top.medianRgb,[240,238,230]);
 assert.deepEqual(top.darkest.rgb,[0,0,0]);assert.equal(top.darkest.x,20);assert.equal(top.darkest.y,5);
 assert(top.ratio>=3);assert(top.valid);
});
test('edge samples retain off-screen positions as invalid rather than silently shortening an edge',()=>{
 const edges=focusEdgeSamples({width:20,height:20,pixels:Buffer.alloc(1600,255)},{left:0,right:10,top:2,bottom:12},'2px','2px',[90,146,5]);
 const left=edges.find(e=>e.side==='left');assert.equal(left.count,10);assert.equal(left.valid,false);assert.equal(left.medianRgb,null);
});

test('the right and bottom lines begin at the exclusive outline boundary, with left and top outside their inclusive boundary', () => {
 const pixels = Buffer.alloc(18 * 16 * 4, 255);
 // Distinct neighboring lines make a one-pixel skip visible in the result.
 for (const [x, y] of [[0, 7], [16, 7], [9, 1], [9, 14]]) {
  pixels.set([230, 231, 232], (y * 18 + x) * 4);
 }
 const edges = focusEdgeSamples({ width: 18, height: 16, pixels },
  { left: 5.5, right: 12, top: 6.25, bottom: 10 }, '1px', '3px', [80, 135, 0]);
 assert.deepEqual(edges.map(({ side, darkest }) => [side, darkest.x, darkest.y, darkest.rgb]), [
  ['left', 0, 7, [230, 231, 232]],
  ['right', 16, 7, [230, 231, 232]],
  ['top', 9, 1, [230, 231, 232]],
  ['bottom', 9, 14, [230, 231, 232]],
 ]);
});

test('a single pixel below 3:1 is recorded without failing an edge whose median passes', () => {
 const width = 20, height = 20;
 const pixels = Buffer.alloc(width * height * 4, 255);
 const indicator = [80, 135, 0];
 // The lower luminance pixel matches the indicator exactly (1:1).
 // Both the old and new geometries share the tested top line.
 pixels.set(indicator, (3 * width + 10) * 4);
 const top = focusEdgeSamples({ width, height, pixels },
  { left: 5, right: 15, top: 6, bottom: 13 }, '1px', '1px', indicator)
  .find(edge => edge.side === 'top');
 assert.equal(top.darkest.ratio, 1);
 assert.deepEqual(top.darkest.rgb, indicator);
 assert.deepEqual(top.medianRgb, [255, 255, 255]);
 assert(top.ratio >= 3);
});

function haloFixture(maskedCount) {
 const width=40,height=40;
 const image={width,height,pixels:Buffer.alloc(width*height*4,255)};
 const reference={width,height,pixels:Buffer.alloc(width*height*4,255)};
 const haloPaint={width,height,pixels:Buffer.alloc(width*height*4)};
 for(let x=10;x<30;x++)reference.pixels.set([253,251,249,255],(5*width+x)*4);
 for(let x=10;x<10+maskedCount;x++) {
  image.pixels.set([83,137,0,255],(5*width+x)*4);
  reference.pixels.set([230,232,234,255],(5*width+x)*4);
  // Even the faintest nonzero alpha uses the background reference.
  haloPaint.pixels.set([1,2,3,1],(5*width+x)*4);
 }
 return {image,reference,haloPaint,bounds:{left:10,right:30,top:10,bottom:30}};
}

test('painted halo pixels use reference colors rather than being discarded or left in the median', () => {
 const {image,reference,haloPaint,bounds}=haloFixture(12);
 const top=focusEdgeSamples(image,bounds,'2px','2px',[83,137,0],haloPaint,reference).find(edge=>edge.side==='top');
 // Twelve reference pixels and eight normal pixels give this literal median.
 assert.deepEqual(top.medianRgb,[230,232,234]);
 assert.equal(top.valid,true);assert(top.ratio>=3);
 assert.equal(top.count,20);assert.equal(top.validCount,20);
 assert.equal(top.replacedCount,12);assert.equal(top.unaffectedCount,8);
 assert.deepEqual(top.replacedPoints.map(p=>p.x),[10,11,12,13,14,15,16,17,18,19,20,21]);
 const {luminance,usedLuminance,...replacement}=top.replacedPoints[0];
 assert.deepEqual(replacement,{
  x:10,y:5,valid:true,rgb:[83,137,0],normalRgb:[83,137,0],referenceRgb:[230,232,234],usedRgb:[230,232,234],
  haloAlpha:1,replaced:true,source:'reference',replacementReason:'halo-alpha>0',backgroundDelta:null,
 });
 assert.equal(top.points.at(-1).haloAlpha,0);assert.equal(top.points.at(-1).replaced,false);
 assert.deepEqual(top.points.at(-1).usedRgb,[255,255,255]);
 assert.equal(top.maxBackgroundDelta,6);
 assert.equal(top.darkest.ratio,1);assert.deepEqual(top.darkest.rgb,[83,137,0]);
});

test('without painted halo pixels reference capture preserves the original normal-frame result',()=>{
 const {image,reference,haloPaint,bounds}=haloFixture(0);
 // Nonzero RGB with transparent alpha never selects the reference frame.
 haloPaint.pixels.set([80,90,100,0],(5*40+10)*4);
 const original=focusEdgeSamples(image,bounds,'2px','2px',[83,137,0]);
 const sampled=focusEdgeSamples(image,bounds,'2px','2px',[83,137,0],haloPaint,reference);
 for(let index=0;index<4;index++) {
  for(const key of ['side','count','distance','valid','medianRgb','ratio'])assert.deepEqual(sampled[index][key],original[index][key]);
  assert.equal(sampled[index].replacedCount,0);
 }
 const top=sampled.find(edge=>edge.side==='top');
 assert.deepEqual(top.medianRgb,[255,255,255]);
 assert.deepEqual(top.points[0].usedRgb,[255,255,255]);
 assert.deepEqual(top.points[0].referenceRgb,[253,251,249]);
 assert.equal(top.unaffectedCount,20);assert.equal(top.maxBackgroundDelta,6);
});

test('a zero-replacement station records arbitrarily large reference drift without invalidating the normal result',()=>{
 const {image,reference,haloPaint,bounds}=haloFixture(0);
 for(let at=0;at<reference.pixels.length;at+=4)reference.pixels.set([0,0,0,255],at);
 const original=focusEdgeSamples(image,bounds,'2px','2px',[83,137,0]);
 const sampled=focusEdgeSamples(image,bounds,'2px','2px',[83,137,0],haloPaint,reference);
 for(let index=0;index<4;index++) {
  const edge=sampled[index];
  assert.equal(edge.valid,true);
  for(const key of ['side','count','distance','valid','medianRgb','ratio'])assert.deepEqual(edge[key],original[index][key]);
  assert.deepEqual(edge.medianRgb,[255,255,255]);assert(edge.ratio>=3);
  assert.equal(edge.replacedCount,0);assert.equal(edge.stationReplacedCount,0);
  assert.equal(edge.maxBackgroundDelta,255);assert.equal(edge.backgroundWithinTolerance,false);
  assert.equal(edge.backgroundCheckApplies,false);assert.equal(edge.backgroundStable,true);
  assert.equal(edge.invalidReason,null);
  assert(edge.points.every(point=>point.source==='normal'&&point.usedRgb.join()==='255,255,255'));
 }
});

test('one painted edge keeps the drift gate active for a different unpainted edge in the same station',()=>{
 const {image,reference,haloPaint,bounds}=haloFixture(1);
 // The halo paints only top x=10/y=5. Left x=5/y=12 stays clear but drifts9.
 reference.pixels.set([246,255,255,255],(12*40+5)*4);
 const edges=focusEdgeSamples(image,bounds,'2px','2px',[83,137,0],haloPaint,reference);
 const top=edges.find(edge=>edge.side==='top'),left=edges.find(edge=>edge.side==='left');
 assert.equal(top.replacedCount,1);assert.equal(top.valid,true);
 assert.equal(left.replacedCount,0);assert.equal(left.maxBackgroundDelta,9);
 assert.equal(left.valid,false);assert.equal(left.invalidReason,'background-frame-drift');
 assert.equal(left.medianRgb,null);assert.equal(left.ratio,null);
});

test('background channel movement above eight invalidates a reference pair',()=>{
 const {image,reference,haloPaint,bounds}=haloFixture(1);
 reference.pixels.set([246,255,255,255],(5*40+12)*4);
 const top=focusEdgeSamples(image,bounds,'2px','2px',[83,137,0],haloPaint,reference).find(edge=>edge.side==='top');
 assert.equal(top.valid,false);assert.equal(top.geometryValid,true);
 assert.equal(top.invalidReason,'background-frame-drift');assert.equal(top.maxBackgroundDelta,9);
 assert.equal(top.unaffectedCount,19);
 assert.equal(top.medianRgb,null);assert.equal(top.ratio,null);
 assert.equal(top.unaffectedPoints.find(point=>point.x===12).backgroundDelta,9);
});

test('a maximum background delta of exactly eight remains valid',()=>{
 const {image,reference,haloPaint,bounds}=haloFixture(1);
 reference.pixels.set([247,255,255,255],(5*40+12)*4);
 const top=focusEdgeSamples(image,bounds,'2px','2px',[83,137,0],haloPaint,reference).find(edge=>edge.side==='top');
 assert.equal(top.valid,true);assert.equal(top.maxBackgroundDelta,8);assert(top.ratio>=3);
});

test('background drift uses only unaffected pixels rather than rejecting the intended replacement',()=>{
 const {image,reference,haloPaint,bounds}=haloFixture(1);
 reference.pixels.fill(255);reference.pixels.set([0,0,0,255],(5*40+10)*4);
 const top=focusEdgeSamples(image,bounds,'2px','2px',[83,137,0],haloPaint,reference).find(edge=>edge.side==='top');
 assert.equal(top.valid,true);assert.equal(top.replacedCount,1);assert.equal(top.maxBackgroundDelta,0);
 assert.equal(top.points[0].backgroundDelta,null);assert.deepEqual(top.points[0].usedRgb,[0,0,0]);
});

test('a fully painted edge uses all reference pixels without the withdrawn coverage gate',()=>{
 const {image,reference,haloPaint,bounds}=haloFixture(20);
 const top=focusEdgeSamples(image,bounds,'2px','2px',[83,137,0],haloPaint,reference).find(edge=>edge.side==='top');
 assert.equal(top.valid,true);assert.equal(top.replacedCount,20);assert.equal(top.unaffectedCount,0);
 assert.equal(top.maxBackgroundDelta,null);assert.equal(top.invalidReason,null);
 assert.deepEqual(top.medianRgb,[230,232,234]);assert(top.ratio>=3);
});

test('a supplied halo mask must be complete and match screenshot geometry', () => {
 const {image,haloPaint,bounds}=haloFixture(0);
 for(const malformed of [
  {...haloPaint,width:39}, {...haloPaint,height:39}, {...haloPaint,width:40.5},
  {...haloPaint,pixels:Buffer.alloc(4)}, {...haloPaint,pixels:null},
 ]) assert.throws(()=>focusEdgeSamples(image,bounds,'2px','2px',[83,137,0],malformed),/Halo paint/);
});

test('painted halo samples require a complete geometry-matched background reference',()=>{
 const {image,reference,haloPaint,bounds}=haloFixture(1);
 assert.throws(()=>focusEdgeSamples(image,bounds,'2px','2px',[83,137,0],haloPaint),/Background reference/);
 for(const malformed of [null,{...reference,width:39},{...reference,pixels:Buffer.alloc(4)}])
  assert.throws(()=>focusEdgeSamples(image,bounds,'2px','2px',[83,137,0],haloPaint,malformed),/Background reference/);
});
