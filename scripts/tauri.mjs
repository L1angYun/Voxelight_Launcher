// SPDX-License-Identifier: GPL-3.0-only
import { runTauri } from "./build-runtime.mjs";

try {
  process.exitCode = await runTauri(process.argv.slice(2));
} catch (error) {
  console.error(`Tauri could not start: ${error.message}`);
  process.exitCode = 1;
}
