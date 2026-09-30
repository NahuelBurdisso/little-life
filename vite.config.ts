/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { configDefaults } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    watch: {
      // Agent worktrees (.claude/worktrees/*, each a full checkout with a
      // node_modules junction) and the SQLite files under data/ (rewritten every
      // tick, plus saves and test-worker copies) are not client sources. With
      // dozens of worktrees the watcher crawled them all: the dev server sat at
      // 100% CPU and single modules took 20–36 s to serve.
      ignored: ["**/.claude/**", "**/data/**"],
    },
  },
  test: {
    // `setupInitialize.test.ts` calls setupRouter.initialize, which clears every
    // table. Without this override `server/db` falls back to the DATABASE_PATH in
    // .env and `npm test` destroys the running simulation's world.
    env: { DATABASE_PATH: "./data/test.db" },
    globalSetup: "./server/db/testSetup.ts",
    // Repoints each worker at its own copy so parallel files don't contend on
    // one WAL file. Must stay a setupFile: server/db reads DATABASE_PATH at
    // import time, and setupFiles are the last hook that runs before that.
    setupFiles: "./server/db/testWorker.ts",
    // Agent worktrees live under .claude/worktrees/ with full copies of the
    // test suite. Without this, `npm test` at the root collected every copy
    // (241 files instead of ~46) and ran other branches' half-finished code.
    exclude: [...configDefaults.exclude, ".claude/**"],
  },
});
