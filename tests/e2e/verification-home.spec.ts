// SPDX-License-Identifier: GPL-3.0-only
import {chromium,expect,test} from "@playwright/test";
import {writeFile} from "node:fs/promises";
import {installLauncherFixture} from "./fixtures";
const nativeTest=test.extend({context:async({baseURL},use)=>{
 const browser=await chromium.launch({channel:"chromium",args:["--use-angle=d3d11"]});
 const context=await browser.newContext({baseURL,deviceScaleFactor:1});
 try{await use(context);}finally{await context.close();await browser.close();}
}});
for(const theme of ["dark","light"] as const)for(const width of [1050,1440]){
 nativeTest(`verification 4 ${theme} ${width}: unavailable character is centered with secondary text`,async({page},info)=>{
  await page.setViewportSize({width,height:width===1050?720:930});
  await installLauncherFixture(page,{theme,profileFailure:true});await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-world-intro","off");
  const fallback=page.locator(".vx-character-placeholder");await expect(fallback.getByRole("button")).toBeVisible();
  await page.evaluate(()=>document.fonts.ready.then(()=>undefined));
  const data=await fallback.evaluate(element=>{
   const box=element.getBoundingClientRect(),panel=element.closest(".vx-home__character-panel")!.getBoundingClientRect();
   const feet=document.querySelector(".vx-home__feet")!.getBoundingClientRect();
   const probe=document.createElement("span");probe.style.color="var(--text-secondary)";element.append(probe);
   const secondary=getComputedStyle(probe).color;probe.remove();
   const button=element.querySelector("button")!,style=getComputedStyle(element);
   const world=document.querySelector<HTMLCanvasElement>(".world-scene canvas")!,gl=world.getContext("webgl2")!,ext=gl.getExtension("WEBGL_debug_renderer_info")!;
   return {box:box.toJSON(),panel:panel.toJSON(),feet:feet.toJSON(),deltaX:Math.abs((box.left+box.right-panel.left-panel.right)/2),
    deltaY:Math.abs((box.top+box.bottom-panel.top-panel.bottom)/2),color:style.color,statusColor:getComputedStyle(element.querySelector("strong")!).color,secondary,
    buttonHeight:button.getBoundingClientRect().height,radius:style.borderRadius,statusContainsButton:!!button.closest('[role="status"]'),
    homeParentDisplay:getComputedStyle(document.querySelector(".vx-home")!.parentElement!).display,
    homeGridRow:getComputedStyle(document.querySelector(".vx-home")!).gridRow,renderer:String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)),dpr:devicePixelRatio};
  });
  await writeFile(info.outputPath("placeholder-geometry.json"),JSON.stringify(data,null,2));
  await page.screenshot({path:info.outputPath("profile-failure-centered.png"),scale:"css"});
  expect(data.renderer).toMatch(/D3D11|Direct3D11/);expect(data.renderer).not.toMatch(/swiftshader|software|llvmpipe/i);expect(data.dpr).toBe(1);
  expect.soft(data.deltaX).toBeLessThanOrEqual(2);expect.soft(data.deltaY).toBeLessThanOrEqual(2);
  expect.soft(data.color).toBe(data.secondary);expect.soft(data.statusColor).toBe(data.secondary);
  expect(data.buttonHeight).toBe(38);expect(data.radius).toBe("12px");expect(data.statusContainsButton).toBe(false);
 });
}
