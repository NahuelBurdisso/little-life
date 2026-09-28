/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
  },
});
