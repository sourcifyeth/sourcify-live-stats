import { Broadcaster } from "./broadcaster";
import { loadConfig } from "./config";
import { createApp } from "./http";
import logger, { setLogLevel } from "./logger";
import { startSubscriber } from "./pubsub";
import { LiveState } from "./state";

function main(): void {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  const state = new LiveState();
  const broadcaster = new Broadcaster(state, logger, config);
  broadcaster.start();

  const app = createApp({
    state,
    broadcaster,
    maxConnections: config.maxConnections,
  });
  const server = app.listen(config.port, () => {
    logger.info("HTTP server started", { port: config.port });
  });

  const subscriber = startSubscriber({
    projectId: config.projectId,
    subscription: config.subscription,
    logger,
    onMatch: (match) => state.add(match),
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down", { signal });
    try {
      await subscriber.close();
    } catch (error) {
      logger.error("Failed to close Pub/Sub subscription", { error });
    }
    // End open streams first, or server.close() waits for them forever.
    broadcaster.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

try {
  main();
} catch (error) {
  logger.error("Failed to start", { error });
  process.exit(1);
}
