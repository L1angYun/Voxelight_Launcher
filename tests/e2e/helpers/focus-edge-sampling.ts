// SPDX-License-Identifier: GPL-3.0-only
type Image = {width:number;height:number;pixels:Uint8Array};
type Bounds = {left:number;right:number;top:number;bottom:number};
export function relativeLuminance(rgb:readonly number[]) {
 return rgb.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
}
const ratio=(a:readonly number[],b:readonly number[])=>{const x=relativeLuminance(a),y=relativeLuminance(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
const median=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b);const m=Math.floor(sorted.length/2);return sorted.length%2?sorted[m]:(sorted[m-1]+sorted[m])/2;};
/** R3-3 ruling two: preserve geometry; replace painted halo pixels from the background reference. */
export function focusEdgeSamples(image:Image,bounds:Bounds,outlineOffset:string,outlineWidth:string,foreground:readonly number[],haloPaint?:Image,referenceImage?:Image) {
 if(haloPaint!==undefined&&(!haloPaint||!Number.isInteger(haloPaint.width)||!Number.isInteger(haloPaint.height)
  ||haloPaint.width<=0||haloPaint.height<=0||haloPaint.width!==image.width||haloPaint.height!==image.height
  ||!(haloPaint.pixels instanceof Uint8Array)||haloPaint.pixels.length!==image.width*image.height*4))
  throw new Error('Halo paint must contain complete RGBA pixels matching the screenshot geometry');
 if(referenceImage!==undefined&&(!referenceImage||!Number.isInteger(referenceImage.width)||!Number.isInteger(referenceImage.height)
  ||referenceImage.width<=0||referenceImage.height<=0||referenceImage.width!==image.width||referenceImage.height!==image.height
  ||!(referenceImage.pixels instanceof Uint8Array)||referenceImage.pixels.length!==image.width*image.height*4))
  throw new Error('Background reference must contain complete RGBA pixels matching the screenshot geometry');
 const outerExtent=parseFloat(outlineOffset)+parseFloat(outlineWidth);
 const before=outerExtent+1;
 const ys=Array.from({length:Math.max(0,Math.ceil(bounds.bottom)-Math.ceil(bounds.top))},(_,i)=>Math.ceil(bounds.top)+i);
 const xs=Array.from({length:Math.max(0,Math.ceil(bounds.right)-Math.ceil(bounds.left))},(_,i)=>Math.ceil(bounds.left)+i);
 // The right and bottom rectangle bounds are exclusive. Ceil reaches the
 // first pixel outside their outline; adding one would skip that pixel.
 const lines=[{side:'left',distance:before,points:ys.map(y=>({x:Math.floor(bounds.left-before),y}))},
  {side:'right',distance:outerExtent,points:ys.map(y=>({x:Math.ceil(bounds.right+outerExtent),y}))},
  {side:'top',distance:before,points:xs.map(x=>({x,y:Math.floor(bounds.top-before)}))},
  {side:'bottom',distance:outerExtent,points:xs.map(x=>({x,y:Math.ceil(bounds.bottom+outerExtent)}))}];
 const edges=lines.map(line=>{
  const points=line.points.map(p=>{const valid=Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=0&&p.y>=0&&p.x<image.width&&p.y<image.height;
   const at=(p.y*image.width+p.x)*4;const normalRgb=valid?Array.from(image.pixels.subarray(at,at+3)):null;
   const referenceRgb=valid&&referenceImage?Array.from(referenceImage.pixels.subarray(at,at+3)):null;
   const haloAlpha=valid?(haloPaint?.pixels[at+3]??0):null;
   const replaced=valid&&(haloAlpha??0)>0;
   if(replaced&&!referenceImage)throw new Error('Background reference is required for painted halo samples');
   const usedRgb=replaced?referenceRgb:normalRgb;
   const backgroundDelta=valid&&!replaced&&referenceRgb
    ?Math.max(...normalRgb!.map((value,index)=>Math.abs(value-referenceRgb[index]))):null;
   return {...p,valid,rgb:normalRgb,normalRgb,referenceRgb,usedRgb,
    luminance:normalRgb?relativeLuminance(normalRgb):null,usedLuminance:usedRgb?relativeLuminance(usedRgb):null,
    haloAlpha,replaced,source:replaced?'reference':'normal',replacementReason:replaced?'halo-alpha>0':null,backgroundDelta};});
  const validCount=points.filter(p=>p.valid).length;
  const geometryValid=points.length>0&&validCount===points.length;
  const replacedPoints=points.filter(p=>p.replaced),unaffectedPoints=points.filter(p=>p.valid&&!p.replaced);
  const backgroundDeltaPoints=unaffectedPoints.filter(p=>p.backgroundDelta!==null);
  const maxBackgroundDelta=backgroundDeltaPoints.length?Math.max(...backgroundDeltaPoints.map(p=>p.backgroundDelta!)):null;
  const backgroundWithinTolerance=maxBackgroundDelta===null||maxBackgroundDelta<=8;
  // Keep the unmodified normal-frame minimum as a diagnostic, not the gate.
  const darkest=points.filter(p=>p.valid).sort((a,b)=>a.luminance!-b.luminance!)[0]??null;
  return {side:line.side,count:points.length,distance:line.distance,geometryValid,validCount,
   replacedCount:replacedPoints.length,unaffectedCount:unaffectedPoints.length,replacedPoints,unaffectedPoints,
   maxBackgroundDelta,backgroundComparisonCount:backgroundDeltaPoints.length,backgroundDeltaPoints,backgroundWithinTolerance,
   darkest:darkest?{...darkest,ratio:ratio(foreground,darkest.rgb!)}:null,points};
 });
 // The reference contributes to the station if any of its four edges used a
 // replacement. Keep every recorded delta, including unused-reference drift.
 const stationReplacedCount=edges.reduce((sum,edge)=>sum+edge.replacedCount,0);
 const backgroundCheckApplies=stationReplacedCount>0;
 return edges.map(edge=>{
  const backgroundStable=!backgroundCheckApplies||edge.backgroundWithinTolerance;
  const valid=edge.geometryValid&&backgroundStable;
  const invalidReason=!edge.points.length?'empty-edge':!edge.geometryValid?'offscreen-edge'
   :!backgroundStable?'background-frame-drift':null;
  const medianRgb=valid?[0,1,2].map(c=>median(edge.points.map(point=>point.usedRgb![c]))):null;
  return {...edge,stationReplacedCount,backgroundCheckApplies,backgroundStable,valid,invalidReason,
   medianRgb,ratio:medianRgb?ratio(foreground,medianRgb):null};
 });
}
