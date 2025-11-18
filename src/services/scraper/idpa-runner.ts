import { mkdtemp, rm, writeFile, mkdir, readdir, readFile, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { BadRequestError, ServiceUnavailableError } from "../../utils/errors.js";
import { buildScraperInputPayload } from "./input-utils.js";
import type { DatasetItem, ScrapeOptions } from "./types.js";

const TMP_PREFIX = "idpa-scraper-";

class IdpaScraperRunner {
  private ensureConfigured() {
    if (!env.SCRAPER_DIR) {
      throw new ServiceUnavailableError("SCRAPER_DIR ist nicht gesetzt – Scraper kann nicht gestartet werden");
    }
    return env.SCRAPER_DIR;
  }

  async run(options: ScrapeOptions): Promise<DatasetItem[]> {
    if (!options.startUrls.length) {
      throw new BadRequestError("Mindestens eine Start-URL ist erforderlich");
    }

    const scraperDir = this.ensureConfigured();
    const storageDir = await mkdtemp(path.join(os.tmpdir(), TMP_PREFIX));
    const cleanupTasks: Array<Promise<void>> = [];

    try {
      await access(scraperDir).catch(() => {
        throw new ServiceUnavailableError(`Scraper-Verzeichnis ${scraperDir} wurde nicht gefunden`);
      });
      const keyValueStoreDir = path.join(storageDir, "key_value_stores", "default");
      const datasetDir = path.join(storageDir, "datasets", "default");
      const requestQueueDir = path.join(storageDir, "request_queues", "default");

      await Promise.all([
        mkdir(keyValueStoreDir, { recursive: true }),
        mkdir(datasetDir, { recursive: true }),
        mkdir(requestQueueDir, { recursive: true }),
      ]);

      const extras = env.PERPLEXITY_API_KEY ? { perplexityApiKey: env.PERPLEXITY_API_KEY } : undefined;
      const inputPayload = buildScraperInputPayload(options, extras);

      const inputPath = path.join(keyValueStoreDir, "INPUT.json");
      await writeFile(inputPath, JSON.stringify(inputPayload, null, 2), "utf-8");

      await this.executeScraperProcess(scraperDir, storageDir);

      const datasetItems = await this.readDataset(datasetDir);
      return datasetItems;
    } finally {
      cleanupTasks.push(rm(storageDir, { recursive: true, force: true }));
      await Promise.allSettled(cleanupTasks);
    }
  }

  private executeScraperProcess(scraperDir: string, storageDir: string) {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(
        "node",
        ["--loader", "ts-node/esm", "src/main.ts"],
        {
          cwd: scraperDir,
          env: {
            ...process.env,
            CRAWLEE_STORAGE_DIR: storageDir,
            APIFY_LOCAL_STORAGE_DIR: storageDir,
            APIFY_DEFAULT_KEY_VALUE_STORE_ID: "default",
            APIFY_DEFAULT_DATASET_ID: "default",
            PERPLEXITY_API_KEY: env.PERPLEXITY_API_KEY ?? process.env.PERPLEXITY_API_KEY,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      child.stdout.on("data", (data) => {
        const text = data.toString().trim();
        if (text) logger.info({ component: "IDPA-Scraper" }, text);
      });
      child.stderr.on("data", (data) => {
        const text = data.toString().trim();
        if (text) logger.warn({ component: "IDPA-Scraper" }, text);
      });

      child.once("error", (error) => {
        logger.error({ error }, "Scraper process konnte nicht gestartet werden");
        reject(new ServiceUnavailableError("Scraper Prozess konnte nicht gestartet werden"));
      });

      child.once("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new ServiceUnavailableError(`Scraper Prozess endete mit Exit Code ${code}`));
        }
      });
    });
  }

  private async readDataset(datasetDir: string): Promise<DatasetItem[]> {
    const files = (await readdir(datasetDir).catch(() => [])).filter((file) => file.endsWith(".json")).sort();
    const items: DatasetItem[] = [];
    for (const file of files) {
      const raw = await readFile(path.join(datasetDir, file), "utf-8");
      try {
        const parsed = JSON.parse(raw);
        if (parsed.type === "page") {
          items.push(parsed as DatasetItem);
        }
      } catch (error) {
        logger.warn({ file, error }, "Konnte Dataset-Datei nicht parsen");
      }
    }
    return items;
  }
}

export const idpaScraperRunner = new IdpaScraperRunner();
