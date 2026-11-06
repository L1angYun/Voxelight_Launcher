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
