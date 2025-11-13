import { PrismaClient } from "@prisma/client";
import { logger } from "./logger.js";

export const prisma = new PrismaClient({
  log: ["error", "warn"],
});

process.on("SIGINT", async () => {
  await prisma.$disconnect();
  logger.info("Prisma disconnected");
  process.exit(0);
});
