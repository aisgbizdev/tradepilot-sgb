import { existsSync, readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

// Tests need a disposable Postgres (see db-test in compose.yaml). Values come
// from .env.test; a DATABASE_URL already set in the shell still wins.
const envFile = new URL("./.env.test", import.meta.url);
const fileEnv: Record<string, string> = {};
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith("#")) fileEnv[m[1]!] = m[2]!;
  }
}

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
    pool: "forks",
    fileParallelism: false,
    env: {
      DATABASE_URL: process.env.DATABASE_URL ?? fileEnv.DATABASE_URL ?? "",
      PGSSLMODE: process.env.PGSSLMODE ?? fileEnv.PGSSLMODE ?? "disable",
      // Disable web-push delivery during tests so the regression suite cannot
      // fan out real push notifications to non-test users.
      VAPID_PUBLIC_KEY: "",
      VAPID_PRIVATE_KEY: "",
    },
  },
});
