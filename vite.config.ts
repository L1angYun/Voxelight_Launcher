import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Rust and installer outputs contain HTML/DLLs. Watching them can restart
    // the UI during compilation and hit files locked by the Windows linker.
    watch: {
      ignored: [
        "**/src-tauri/**",
        "**/bin/**",
        "**/obj/**",
        "**/.vs/**",
        "**/releases/**",
        "**/_backup/**",
      ],
    },
  },
  build: {
    target: "es2022",
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "skin-renderer",
              test: /node_modules[\\/](three|skinview3d|skinview-utils)[\\/]/,
            },
            {
              name: "motion",
              test: /node_modules[\\/](motion|motion-dom|motion-utils|framer-motion)[\\/]/,
            },
          ],
        },
      },
    },
  },
});
