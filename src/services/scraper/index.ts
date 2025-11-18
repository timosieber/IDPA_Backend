import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { apifyScraperRunner } from "./apify-runner.js";
import { idpaScraperRunner } from "./idpa-runner.js";
import type { DatasetItem, ScrapeOptions } from "./types.js";

const useApifyRunner = Boolean(env.SCRAPER_APIFY_ACTOR_ID && env.SCRAPER_APIFY_API_TOKEN);

if (useApifyRunner) {
  logger.info({ actor: env.SCRAPER_APIFY_ACTOR_ID }, "Apify Scraper Runner aktiviert");
} else {
  logger.info({ scraperDir: env.SCRAPER_DIR }, "Lokaler IDPA Scraper Runner aktiviert");
}

type Runner = {
  run(options: ScrapeOptions): Promise<DatasetItem[]>;
};

const runner: Runner = useApifyRunner ? apifyScraperRunner : idpaScraperRunner;

export const scraperRunner = runner;
