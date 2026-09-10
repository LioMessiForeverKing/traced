import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.live.test.ts"],
    setupFiles: ["test/live-env.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
