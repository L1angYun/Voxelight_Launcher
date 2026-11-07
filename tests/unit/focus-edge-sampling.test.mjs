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
