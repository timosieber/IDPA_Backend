import pino, { type LoggerOptions, type TransportSingleOptions } from "pino";
import { env, isProduction } from "../config/env.js";

const transport = isProduction
  ? undefined
  : ({
      target: "pino-pretty",
      options: { colorize: true, translateTime: "SYS:standard" },
    } satisfies TransportSingleOptions);

const options: LoggerOptions = {
  level: isProduction ? "info" : "debug",
  base: {
    env: env.NODE_ENV,
  },
};

if (transport) {
  options.transport = transport;
}

export const logger = pino(options);
