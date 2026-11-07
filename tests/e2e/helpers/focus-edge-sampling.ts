// SPDX-License-Identifier: GPL-3.0-only
type Image = {width:number;height:number;pixels:Uint8Array};
type Bounds = {left:number;right:number;top:number;bottom:number};
export function relativeLuminance(rgb:readonly number[]) {
 return rgb.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
}
const ratio=(a:readonly number[],b:readonly number[])=>{const x=relativeLuminance(a),y=relativeLuminance(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
const median=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b);const m=Math.floor(sorted.length/2);return sorted.length%2?sorted[m]:(sorted[m-1]+sorted[m])/2;};
/** R2-01 revision 7: complete 1px lines immediately beyond the focus outline. */
export function focusEdgeSamples(image:Image,bounds:Bounds,outlineOffset:string,outlineWidth:string,foreground:readonly number[]) {
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
 return lines.map(line=>{
  const points=line.points.map(p=>{const valid=Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=0&&p.y>=0&&p.x<image.width&&p.y<image.height;
   const at=(p.y*image.width+p.x)*4;const rgb=valid?Array.from(image.pixels.subarray(at,at+3)):null;
   return {...p,valid,rgb,luminance:rgb?relativeLuminance(rgb):null};});
  const valid=points.length>0&&points.every(p=>p.valid);
  const medianRgb=valid?[0,1,2].map(c=>median(points.map(p=>p.rgb![c]))):null;
  const darkest=points.filter(p=>p.valid).sort((a,b)=>a.luminance!-b.luminance!)[0]??null;
  return {side:line.side,count:points.length,distance:line.distance,valid,medianRgb,ratio:medianRgb?ratio(foreground,medianRgb):null,
   darkest:darkest?{...darkest,ratio:ratio(foreground,darkest.rgb!)}:null,points};
 });
}
