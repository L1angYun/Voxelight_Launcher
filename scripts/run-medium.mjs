// SPDX-License-Identifier: GPL-3.0-only
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execute, repairExecutables } from "./build-runtime.mjs";

export async function runMedium(executable, args, options = {}) {
  if (!executable) throw new Error("The development runner requires an executable path.");
  const code = await repairExecutables([executable], options);
  if (code !== 0) return code;
  return (options.execute ?? execute)(executable, args, options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await runMedium(process.argv[2], process.argv.slice(3)); } catch (error) {
    console.error(`The launcher could not start at Medium integrity: ${error.message}`);
    process.exitCode = 1;
  }
}
