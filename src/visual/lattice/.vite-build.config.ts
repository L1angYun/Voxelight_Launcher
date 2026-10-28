import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("../../../src", import.meta.url)) } },
  build: {
    outDir: join(tmpdir(), "voxelight-lattice-build-check"),
    emptyOutDir: true,
    target: "es2022",
  },
});
