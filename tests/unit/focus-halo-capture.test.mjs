// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import test from 'node:test';
import { captureFocusFrame, decodeHaloFrameStamp, haloPaintMask } from '../e2e/helpers/focus-halo-capture.ts';

function stampedImage(id) {
 const width=100,height=8,pixels=Buffer.alloc(width*height*4,255);
 const bits=[...Array.from({length:8},(_,i)=>(0xac>>i)&1),
  ...Array.from({length:24},(_,i)=>(id>>i)&1),
  ...Array.from({length:8},(_,i)=>((0xa7^(id&255)^((id>>8)&255)^((id>>16)&255))>>i)&1)];
 bits.forEach((bit,index)=>{for(let y=height-2;y<height;y++)for(let x=index*2;x<index*2+2;x++)pixels.set(bit?[255,0,255,255]:[0,255,255,255],(y*width+x)*4);});
 return{width,height,pixels};
}

test('frame stamp identifies the exact painted halo frame, including high bits',()=>{
 for(const id of [1,255,256,65536,0xffffff])assert.equal(decodeHaloFrameStamp(stampedImage(id)),id);
});
test('missing, inconsistent or corrupt frame stamps fail instead of choosing the latest mask',()=>{
 const missing=stampedImage(0);assert.throws(()=>decodeHaloFrameStamp(missing));
 const corrupt=stampedImage(17);corrupt.pixels[(6*100+64)*4]^=255;
 assert.throws(()=>decodeHaloFrameStamp(corrupt));
 assert.throws(()=>decodeHaloFrameStamp({width:40,height:1,pixels:Buffer.alloc(160,255)}));
});
test('the captured crop alpha maps to its exact CSS screenshot pixels without inventing exclusions',()=>{
 const mask=haloPaintMask(8,6,{region:{x:2,y:3,width:3,height:2},alphaBase64:Buffer.from([0,1,255,7,0,2]).toString('base64')});
 assert.equal(mask.width,8);assert.equal(mask.height,6);
 assert.equal(mask.pixels[(3*8+2)*4+3],0);assert.equal(mask.pixels[(3*8+3)*4+3],1);
 assert.equal(mask.pixels[(3*8+4)*4+3],255);assert.equal(mask.pixels[(4*8+2)*4+3],7);
 assert.equal(mask.pixels[(4*8+4)*4+3],2);assert.equal(mask.pixels[(2*8+3)*4+3],0);
});
test('invalid halo crop geometry or incomplete alpha data fails explicitly',()=>{
 const paint={region:{x:2,y:3,width:3,height:2},alphaBase64:Buffer.from([0,1,255,7,0,2]).toString('base64')};
 for(const region of [{...paint.region,x:-1},{...paint.region,y:5},{...paint.region,width:1.5}])
  assert.throws(()=>haloPaintMask(8,6,{...paint,region}));
 assert.throws(()=>haloPaintMask(8,6,{...paint,alphaBase64:'AA=='}));
});

test('an inward outline still captures every side coordinate instead of treating uncaptured alpha as zero',async()=>{
 let observed;
 const page={viewportSize:()=>({width:100,height:100}),evaluate:async(_callback,region)=>{if(region)observed=region;throw new Error('stop-before-browser');}};
 await assert.rejects(captureFocusFrame(page,'unused.png',{left:40,right:60,top:40,bottom:60},'-8px','2px'),/stop-before-browser/);
 assert(observed.x<=40&&observed.y<=40);
 assert(observed.x+observed.width>=60&&observed.y+observed.height>=60);
});
