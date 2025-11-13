import { createRequire } from "node:module";
import pino, { type LoggerOptions, type TransportSingleOptions } from "pino";
import { env, isProduction } from "../config/env.js";

const require = createRequire(import.meta.url);

const buildTransport = () => {
  if (isProduction) return undefined;
  try {
    // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
    require("pino-pretty");
    return {
      target: "pino-pretty",
      options: { colorize: true, translateTime: "SYS:standard" },
    } satisfies TransportSingleOptions;
  } catch {
    return undefined;
  }
};

const options: LoggerOptions = {
  level: isProduction ? "info" : "debug",
  base: {
    env: env.NODE_ENV,
  },
};

const transport = buildTransport();
if (transport) {
  options.transport = transport;
}

export const logger = pino(options);
