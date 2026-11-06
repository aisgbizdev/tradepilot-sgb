import app from "./app";
import { logger } from "./lib/logger";
import { startBackgroundJobs, stopBackgroundJobs } from "./lib/jobs";
import { pool } from "./lib/db";
import net from "node:net";

// Node >= 20 enables "happy eyeballs" (autoSelectFamily) by default. On hosts
// with broken/unreachable IPv6 it makes outbound fetch() calls (e.g. Yahoo
// Finance) fail with ETIMEDOUT / "fetch failed". Equivalent to running with
// NODE_OPTIONS=--no-network-family-autoselection, but set here so it ships with
// the code and does not depend on per-host env. Opt back in with
// NETWORK_FAMILY_AUTOSELECTION=true.
if (
  process.env["NETWORK_FAMILY_AUTOSELECTION"] !== "true" &&
  typeof net.setDefaultAutoSelectFamily === "function"
) {
  net.setDefaultAutoSelectFamily(false);
}

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  startBackgroundJobs();
});

let shuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Received shutdown signal, closing server");

  const forceExit = setTimeout(() => {
    logger.error("Forced exit after shutdown timeout");
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  // Stop background jobs first so no new queries are issued mid-shutdown,
  // then wait (with cap) for any in-flight job tick to settle before we
  // close the HTTP server and drain the pool.
  stopBackgroundJobs(5000)
    .catch((err) => {
      logger.error({ err }, "Error stopping background jobs");
    })
    .finally(() => {
      server.close((err) => {
        if (err) logger.error({ err }, "Error closing HTTP server");
        pool
          .end()
          .then(() => {
            logger.info("Database pool drained, exiting cleanly");
            process.exit(0);
          })
          .catch((poolErr) => {
            logger.error({ err: poolErr }, "Error draining DB pool");
            process.exit(1);
          });
      });
    });
}

process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled promise rejection");
});

process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception");
});
