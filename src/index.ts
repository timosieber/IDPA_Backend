import { buildServer } from "./server.js";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";

const app = buildServer();

app.listen(env.PORT, () => {
  logger.info(`🚀 Backend läuft auf Port ${env.PORT}`);
});
