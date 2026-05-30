import app from "./app";
import { logger } from "./lib/logger";
import { startBot } from "./bot/index";

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

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

if (process.env["NODE_ENV"] === "production") {
  const startBotWithRetry = async () => {
    try {
      await startBot();
    } catch (err) {
      logger.error({ err }, "Failed to start bot, restarting in 10 seconds...");
      setTimeout(startBotWithRetry, 10000);
    }
  };
  startBotWithRetry();
} else {
  logger.info("Development mode: Telegram bot polling disabled to avoid conflict with production");
}
