import { buildServer } from "./server.js";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";

// Handle uncaught errors
process.on("uncaughtException", (error) => {
  // eslint-disable-next-line no-console
  console.error("=== ❌ UNCAUGHT EXCEPTION ===", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  // eslint-disable-next-line no-console
  console.error("=== ❌ UNHANDLED REJECTION ===", reason);
  process.exit(1);
});

// eslint-disable-next-line no-console
console.log("=== IDPA Backend: All imports successful ===");
// eslint-disable-next-line no-console
console.log("=== Environment: NODE_ENV =", env.NODE_ENV, ", PORT =", env.PORT, "===");

try {
  // eslint-disable-next-line no-console
  console.log("=== Building server... ===");
  logger.info("Initializing server...");

  const app = buildServer();

  // eslint-disable-next-line no-console
  console.log("=== Server built, starting to listen on port", env.PORT, "===");

  app.listen(env.PORT, () => {
    logger.info(`🚀 Backend läuft auf Port ${env.PORT}`);
    // eslint-disable-next-line no-console
    console.log(`=== ✅ Backend successfully started on port ${env.PORT} ===`);
  });
} catch (error) {
  logger.fatal({ err: error }, "Failed to start server");
  // eslint-disable-next-line no-console
  console.error("=== ❌ FATAL ERROR ===", error);
  process.exit(1);
}
