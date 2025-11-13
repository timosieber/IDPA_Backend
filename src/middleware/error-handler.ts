import type { ErrorRequestHandler } from "express";
import { logger } from "../lib/logger.js";
import { HttpError } from "../utils/errors.js";

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    logger.warn({ err }, "Handled HttpError");
    return res.status(err.statusCode).json({ error: err.message, details: err.details });
  }

  logger.error({ err }, "Unhandled error");
  return res.status(500).json({ error: "Internal Server Error" });
};
