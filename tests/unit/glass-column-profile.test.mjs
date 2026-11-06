import test from 'node:test';
import assert from 'node:assert/strict';
import {glassColumnProfile} from '../e2e/helpers/glass-interior-probe.ts';
import * as glassProbe from '../e2e/helpers/glass-interior-probe.ts';
test('column profile finds a narrow central stripe while excluding only actual content boxes',()=>{
 const pixels=Buffer.alloc(64*32*4,255);
 for(let y=0;y<32;y++)for(let x=0;x<64;x++){const i=(y*64+x)*4;pixels[i]=pixels[i+1]=pixels[i+2]=(x>=30&&x<=33?60:8);}
 const image={width:64,height:32,pixels};
 const p=glassColumnProfile(image,{left:0,top:0,right:64,bottom:32,width:64,height:32},[]);
 assert.equal(p.maxDelta,52);assert(p.columns.some(c=>c.delta>12));
 const excluded=glassColumnProfile(image,{left:0,top:0,right:64,bottom:32,width:64,height:32},[{left:30,top:0,right:34,bottom:32}]);
 assert.equal(excluded.maxDelta,0);
});

function colorFixture() {
 const width=12,height=8,pixels=Buffer.alloc(width*height*4,255);
 const paint=(x,y,red,blue)=>{const i=(y*width+x)*4;pixels[i]=red;pixels[i+1]=200;pixels[i+2]=blue;};
 // Hand-selected contour samples in an 8x6 crop beginning at global (2,1).
 paint(3,1,120,90);paint(2,2,100,90); // left: +30,+10 -> +20
 paint(8,1,78,90);paint(9,2,82,90);   // right: -12,-8 -> -10
 paint(3,2,255,0);                   // actual content box, must be excluded
 paint(4,4,10,250);                  // outside the supplied contour band
 return {image:{width,height,pixels},crop:{x:2,y:1,width:8,height:6},
  bounds:{left:2,top:1,right:10,bottom:7,width:8,height:6},
  mask:[1,8,6,15,9],content:[{left:3,top:2,right:4,bottom:3}],paint};
}

function edgeProfile(...args) {
 assert.equal(typeof glassProbe.glassEdgeColorProfile,'function','S4 requires a signed left/right edge-color record');
 return glassProbe.glassEdgeColorProfile(...args);
}

test('edge color keeps signed R-B, global coordinates, and only visible contour-band samples',()=>{
 const {image,crop,bounds,mask,content}=colorFixture();
 const result=edgeProfile(image,crop,bounds,mask,content);
 assert.equal(result.left.count,2);assert.equal(result.right.count,2);
 assert.equal(result.excludedContentPixels,1);
 assert.equal(result.left.meanRedMinusBlue,20);assert.equal(result.right.meanRedMinusBlue,-10);
 assert.equal(result.differenceLeftMinusRight,30);assert.equal(result.absoluteDifference,30);
 assert.deepEqual(result.left.pixels,[{x:3,y:1,redMinusBlue:30},{x:2,y:2,redMinusBlue:10}]);
 assert.deepEqual(result.right.pixels,[{x:8,y:1,redMinusBlue:-12},{x:9,y:2,redMinusBlue:-8}]);
});

test('matching warm edges are recorded without inventing an asymmetric-color failure',()=>{
 const {image,crop,bounds,mask,content,paint}=colorFixture();
 for(const [x,y] of [[3,1],[2,2],[8,1],[9,2]])paint(x,y,105,90);
 const result=edgeProfile(image,crop,bounds,mask,content);
 assert.equal(result.left.meanRedMinusBlue,15);assert.equal(result.right.meanRedMinusBlue,15);
 assert.equal(result.differenceLeftMinusRight,0);assert.equal(result.absoluteDifference,0);
 assert.equal('pass' in result,false,'Color asymmetry is recorded, not assigned an unapproved threshold');
});

test('edge color rejects missing, clipped, or repeated band samples instead of silently changing the region',()=>{
 const {image,crop,bounds,mask,content}=colorFixture();
 assert.throws(()=>edgeProfile(image,crop,bounds,[1,8],content),/both.*sides/i);
 assert.throws(()=>edgeProfile(image,crop,bounds,[...mask,48],content),/crop/i);
 assert.throws(()=>edgeProfile(image,{...crop,x:8},bounds,mask,content),/image/i);
 assert.throws(()=>edgeProfile(image,crop,bounds,[...mask,1],content),/duplicate/i);
});
