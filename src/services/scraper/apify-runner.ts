import { BadRequestError, ServiceUnavailableError } from "../../utils/errors.js";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { buildScraperInputPayload } from "./input-utils.js";
import type { DatasetItem, ScrapeOptions } from "./types.js";

// Fallback-Timeout für unsere eigene Anfrage (2 Stunden)
const RUN_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const PAGE_SIZE = 50;
const POLL_INTERVAL_MS = 2000;

const trimTrailingSlashes = (url: string) => url.replace(/\/+$/, "");

type ApifyRunStatus = "READY" | "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMED-OUT" | "ABORTING" | "ABORTED";

type ApifyRun = {
  id: string;
  status: ApifyRunStatus;
  defaultDatasetId?: string | null;
};

const asApifyRun = (input: unknown): ApifyRun | null => {
  if (!input || typeof input !== "object") return null;
  const anyInput = input as any;
  const data = anyInput.data ?? anyInput;
  if (!data || typeof data !== "object") return null;
  if (typeof data.id !== "string") return null;
  if (typeof data.status !== "string") return null;
  return {
    id: data.id,
    status: data.status as ApifyRunStatus,
    defaultDatasetId: typeof data.defaultDatasetId === "string" ? data.defaultDatasetId : null,
  };
};

export class ApifyScraperRunner {
  private getConfig() {
    if (!env.SCRAPER_APIFY_ACTOR_ID || !env.SCRAPER_APIFY_API_TOKEN) {
      throw new ServiceUnavailableError(
        "Apify Scraper ist nicht konfiguriert. Bitte setze SCRAPER_APIFY_ACTOR_ID und SCRAPER_APIFY_API_TOKEN in den Umgebungsvariablen."
      );
    }
    return {
      actorId: env.SCRAPER_APIFY_ACTOR_ID,
      token: env.SCRAPER_APIFY_API_TOKEN,
      baseUrl: trimTrailingSlashes(env.SCRAPER_APIFY_BASE_URL ?? "https://api.apify.com/v2"),
    };
  }

  private async startRun(config: { actorId: string; token: string; baseUrl: string }, inputPayload: unknown, signal: AbortSignal): Promise<ApifyRun> {
    const url = new URL(`${config.baseUrl}/acts/${encodeURIComponent(config.actorId)}/runs`);
    url.searchParams.set("token", config.token);

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(inputPayload),
      signal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error({ actor: config.actorId, statusCode: response.status, body: errorBody }, "Apify Run konnte nicht gestartet werden");
      throw new ServiceUnavailableError(`Apify Run-Start fehlgeschlagen (Status ${response.status})`);
    }

    const json = (await response.json()) as unknown;
    const run = asApifyRun(json);
    if (!run) {
      logger.warn({ actor: config.actorId, response: json }, "Apify Run-Start lieferte unerwartetes Format");
      throw new ServiceUnavailableError("Apify Run-Start lieferte unerwartetes Format");
    }

    return run;
  }

  private async getRun(config: { token: string; baseUrl: string }, runId: string, signal: AbortSignal): Promise<ApifyRun> {
    const url = new URL(`${config.baseUrl}/actor-runs/${encodeURIComponent(runId)}`);
    url.searchParams.set("token", config.token);

    const response = await fetch(url, { method: "GET", signal });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      logger.error({ runId, statusCode: response.status, body }, "Apify Run Status konnte nicht geladen werden");
      throw new ServiceUnavailableError(`Apify Run Status fehlgeschlagen (Status ${response.status})`);
    }

    const json = (await response.json()) as unknown;
    const run = asApifyRun(json);
    if (!run) {
      logger.warn({ runId, response: json }, "Apify Run Status lieferte unerwartetes Format");
      throw new ServiceUnavailableError("Apify Run Status lieferte unerwartetes Format");
    }
    return run;
  }

  private async waitForRunFinished(config: { token: string; baseUrl: string }, runId: string, signal: AbortSignal): Promise<ApifyRun> {
    const deadline = Date.now() + RUN_TIMEOUT_MS;
    // Poll until terminal state or timeout
    while (Date.now() < deadline) {
      const run = await this.getRun(config, runId, signal);
      if (run.status === "SUCCEEDED" || run.status === "FAILED" || run.status === "ABORTED" || run.status === "TIMED-OUT") {
        return run;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new ServiceUnavailableError("Apify Scraper Timeout überschritten");
  }

  private async fetchDatasetItems(config: { token: string; baseUrl: string }, datasetId: string, signal: AbortSignal): Promise<DatasetItem[]> {
    const datasetItems: DatasetItem[] = [];
    let offset = 0;

    while (true) {
      const url = new URL(`${config.baseUrl}/datasets/${encodeURIComponent(datasetId)}/items`);
      url.searchParams.set("token", config.token);
      url.searchParams.set("format", "json");
      url.searchParams.set("clean", "1");
      url.searchParams.set("limit", String(PAGE_SIZE));
      url.searchParams.set("offset", String(offset));

      const response = await fetch(url, { method: "GET", signal });
      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        logger.error({ datasetId, statusCode: response.status, offset, limit: PAGE_SIZE, body: errorBody }, "Apify Dataset Items konnten nicht geladen werden");
        throw new ServiceUnavailableError(`Apify Dataset Items fehlgeschlagen (Status ${response.status})`);
      }

      const json = (await response.json()) as unknown;
      if (!Array.isArray(json)) {
        logger.warn({ datasetId, offset, limit: PAGE_SIZE, response: json }, "Apify Dataset Items lieferten unerwartetes Format");
        throw new ServiceUnavailableError("Apify Dataset Items lieferten keine Liste");
      }

      const pages = json.filter((item): item is DatasetItem => item?.type === "page");
      datasetItems.push(...pages);
      logger.info({ datasetId, offset, limit: PAGE_SIZE, received: json.length, pages: pages.length }, "Apify Dataset Chunk geladen");

      if (json.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    return datasetItems;
  }

  async run(options: ScrapeOptions): Promise<DatasetItem[]> {
    if (!options.startUrls.length) {
      throw new BadRequestError("Mindestens eine Start-URL ist erforderlich");
    }

    const config = this.getConfig();
    const extras = env.PERPLEXITY_API_KEY ? { perplexityApiKey: env.PERPLEXITY_API_KEY } : undefined;
    const inputPayload = buildScraperInputPayload(options, extras);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);

    try {
      logger.info({ actor: config.actorId }, "Apify Scraper Run wird gestartet");
      const started = await this.startRun(config, inputPayload, controller.signal);
      logger.info({ actor: config.actorId, runId: started.id }, "Apify Run gestartet");

      const finished = await this.waitForRunFinished(config, started.id, controller.signal);
      logger.info({ actor: config.actorId, runId: finished.id, status: finished.status }, "Apify Run beendet");

      if (finished.status !== "SUCCEEDED") {
        throw new ServiceUnavailableError(`Apify Run endete mit Status ${finished.status}`);
      }

      const datasetId = finished.defaultDatasetId;
      if (!datasetId) {
        throw new ServiceUnavailableError("Apify Run hatte kein defaultDatasetId");
      }

      const datasetItems = await this.fetchDatasetItems(config, datasetId, controller.signal);
      logger.info({ actor: config.actorId, runId: finished.id, pages: datasetItems.length }, "Apify Dataset geladen");
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
