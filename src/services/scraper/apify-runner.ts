import { BadRequestError, ServiceUnavailableError } from "../../utils/errors.js";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { buildScraperInputPayload } from "./input-utils.js";
import type { DatasetItem, ScrapeOptions } from "./types.js";

// Timeout für Scraper-Runs: 30 Minuten (große Websites brauchen mehr Zeit)
const RUN_TIMEOUT_MS = 30 * 60 * 1000;

const trimTrailingSlashes = (url: string) => url.replace(/\/+$/, "");

export class ApifyScraperRunner {
  private getConfig() {
    if (!env.SCRAPER_APIFY_ACTOR_ID || !env.SCRAPER_APIFY_API_TOKEN) {
      throw new ServiceUnavailableError("Apify Scraper ist nicht konfiguriert");
    }
    return {
      actorId: env.SCRAPER_APIFY_ACTOR_ID,
      token: env.SCRAPER_APIFY_API_TOKEN,
      baseUrl: trimTrailingSlashes(env.SCRAPER_APIFY_BASE_URL ?? "https://api.apify.com/v2"),
    };
  }

  async run(options: ScrapeOptions): Promise<DatasetItem[]> {
    if (!options.startUrls.length) {
      throw new BadRequestError("Mindestens eine Start-URL ist erforderlich");
    }

    const config = this.getConfig();
    const extras = env.PERPLEXITY_API_KEY ? { perplexityApiKey: env.PERPLEXITY_API_KEY } : undefined;
    const inputPayload = buildScraperInputPayload(options, extras);

    const requestUrl = new URL(`${config.baseUrl}/acts/${encodeURIComponent(config.actorId)}/run-sync-get-dataset-items`);
    requestUrl.searchParams.set("token", config.token);
    requestUrl.searchParams.set("format", "json");
    requestUrl.searchParams.set("clean", "1");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);

    try {
      logger.info({ actor: config.actorId }, "Apify Scraper gestartet");
      const response = await fetch(requestUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(inputPayload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        logger.error(
          { actor: config.actorId, statusCode: response.status, body: errorBody },
          "Apify Scraper schlug fehl",
        );
        throw new ServiceUnavailableError(`Apify Scraper antwortete mit Status ${response.status}`);
      }

      const json = (await response.json()) as unknown;
      if (!Array.isArray(json)) {
        logger.warn({ actor: config.actorId, response: json }, "Apify Scraper lieferte unerwartetes Format");
        throw new ServiceUnavailableError("Apify Scraper lieferte keine Dataset-Liste");
      }

      const datasetItems = json.filter((item): item is DatasetItem => item?.type === "page");
      logger.info({ actor: config.actorId, pages: datasetItems.length }, "Apify Scraper erfolgreich abgeschlossen");
      return datasetItems;
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        throw new ServiceUnavailableError("Apify Scraper Timeout überschritten");
      }
      if (error instanceof ServiceUnavailableError) {
        throw error;
      }
      logger.error({ error }, "Apify Scraper Anfrage fehlgeschlagen");
      throw new ServiceUnavailableError("Apify Scraper Anfrage fehlgeschlagen");
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const apifyScraperRunner = new ApifyScraperRunner();
