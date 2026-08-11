import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PGlite startup and the real WASM model can contend for CPU when Vitest
    // runs files in parallel on a small CI runner. Keep the timeout explicit
    // while preserving file parallelism and the production-shaped smoke test.
    testTimeout: 15_000,
    hookTimeout: 20_000,
  },
});
