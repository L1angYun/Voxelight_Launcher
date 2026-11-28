// SPDX-License-Identifier: GPL-3.0-only
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["setup/src/**/*.test.{ts,tsx}"],
    environment: "node",
    // Vitest resolves this from the repository root, not from this config file.
    setupFiles: ["./setup/src/test/setup.tsx"],
  },
});
