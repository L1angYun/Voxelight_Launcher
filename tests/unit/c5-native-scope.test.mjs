import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../../', import.meta.url));
const read=(p)=>readFileSync(resolve(root,p),'utf8');
const permissions=()=>JSON.parse(read('src-tauri/capabilities/default.json')).permissions;

test('H03 provides scoped known HTTPS URLs and no raw OS path opener to the renderer',()=>{
   const grants=permissions();
   const open=grants.find(entry=>typeof entry==='object' && entry.identifier==='opener:allow-open-url');
   assert.ok(open, 'known HTTPS URL scopes must be explicit; unscoped command cannot open the device site');
   assert.ok(open.allow.some(({url})=>url==='https://microsoft.com/devicelogin'));
   assert.ok(open.allow.some(({url})=>url==='https://github.com/L1angYun/Voxelight_Launcher'));
   assert.ok(open.allow.every(({url})=>url.startsWith('https://') && !url.startsWith('https://*')));
   assert.ok(!grants.includes('opener:allow-open-path'));
   assert.match(read('src/features/library/InstanceOverview.tsx'), /command\("open_folder",\s*\{\s*kind:\s*"instance",\s*instanceId: instance\.id/);
});

test('H03 desktop scope covers the real CurseForge Minecraft project routes without a host-wide grant',()=>{
   const opener=permissions().find(entry=>typeof entry==='object' && entry.identifier==='opener:allow-open-url');
   const curseforge=opener.allow.filter(({url})=>/curseforge\.com/i.test(url)).map(({url})=>url);
   assert.deepEqual(curseforge.sort(), [
      'https://www.curseforge.com/minecraft/mc-mods/*',
      'https://www.curseforge.com/minecraft/modpacks/*',
      'https://www.curseforge.com/minecraft/shaders/*',
      'https://www.curseforge.com/minecraft/texture-packs/*',
      'https://www.curseforge.com/projects/*',
   ]);
});

test('H10 every custom command is classified and privileged file access checks a native purpose grant',()=>{
   const file='src-tauri/permissions/launcher.toml';
   assert.ok(existsSync(resolve(root,file)), 'Tauri must enforce a custom command permission manifest for the app');
   const grouped=read(file), capabilities=permissions();
   const allowed=[...grouped.matchAll(/commands\.allow\s*=\s*\[([\s\S]*?)\]/g)]
      .flatMap(([,group])=>[...group.matchAll(/"([a-z0-9_]+)"/g)].map(([,name])=>name));
   const namespaces=[...grouped.matchAll(/^identifier = "(launcher-[a-z-]+)"/gm)].map(([,scope])=>scope);
   assert.ok(namespaces.length>=8 && namespaces.every(scope=>capabilities.includes(scope)));
   const registered=[...read('src-tauri/src/lib.rs').split('generate_handler![')[1].split('])')[0].matchAll(/\w+::(\w+)/g)].map(([,name])=>name);
   assert.equal(new Set(allowed).size,allowed.length);
   assert.deepEqual([...allowed].sort(),[...registered].sort());
   assert.ok(!capabilities.includes('dialog:allow-open') && !capabilities.includes('dialog:allow-save'));
   const usage=[['auth_commands','upload_account_skin','Skin'],['appearance','set_launcher_background','Background'],['appearance','export_launcher_config','PresetWrite'],['appearance','import_launcher_config','PresetRead'],['instances','export_instance_zip','InstanceArchive'],['content','backup_world','WorldWrite'],['content','import_world','WorldRead'],['modpacks','import_modpack','PackRead'],['modpacks','export_modrinth_modpack','PackWrite'],['processes','export_diagnostics','Diagnostics']];
   for(const [file,command,purpose] of usage){
      const source=read(`src-tauri/src/${file}.rs`).split(`fn ${command}(`)[1];
      assert.ok(new RegExp(`grants\\s*\\.\\s*consume\\(\\s*PathUse::${purpose}\\s*,`).test(source?.slice(0,1100) ?? ''), `${command} must consume native ${purpose} authority before work`);
   }
   assert.match(read('src-tauri/src/commands.rs'),/authorize_changed_config_paths/);
});
