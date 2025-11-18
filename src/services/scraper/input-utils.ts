import type { ScrapeOptions } from "./types.js";

const ensureArray = (values?: string[]) => Array.from(new Set(values ?? [])).filter(Boolean);

export const DEFAULT_SCRAPER_INPUT = {
  respectRobotsTxt: true,
  includeGlobs: [] as string[],
  excludeGlobs: [] as string[],
  maxDepth: 2,
  maxPages: undefined as number | undefined,
  maxConcurrency: 6,
  rateLimitPerHost: 5,
  rangeChunkSize: 65536,
  maxPdfBytesTotal: 16 * 1024 * 1024,
  allowFullDownload: false,
  timeoutHtmlMs: 45000,
  timeoutHeadMs: 15000,
  timeoutPdfOpenMs: 45000,
  doImageHead: true,
  doImageRangeMeta: false,
};

export const buildScraperInputPayload = (
  options: ScrapeOptions,
  extras?: { perplexityApiKey?: string },
) => {
  const normalizedUrls = ensureArray(options.startUrls).map((url) => ({ url }));

  const inputPayload = {
    ...DEFAULT_SCRAPER_INPUT,
    startUrls: normalizedUrls,
    maxDepth: options.maxDepth ?? DEFAULT_SCRAPER_INPUT.maxDepth,
    maxPages: options.maxPages ?? DEFAULT_SCRAPER_INPUT.maxPages,
    respectRobotsTxt: options.respectRobotsTxt ?? DEFAULT_SCRAPER_INPUT.respectRobotsTxt,
    includeGlobs: ensureArray(options.includeGlobs),
    excludeGlobs: ensureArray(options.excludeGlobs),
    maxConcurrency: options.maxConcurrency ?? DEFAULT_SCRAPER_INPUT.maxConcurrency,
    rateLimitPerHost: options.rateLimitPerHost ?? DEFAULT_SCRAPER_INPUT.rateLimitPerHost,
    allowFullDownload: options.allowFullDownload ?? DEFAULT_SCRAPER_INPUT.allowFullDownload,
  };

  if (extras?.perplexityApiKey) {
    return {
      ...inputPayload,
      perplexityApiKey: extras.perplexityApiKey,
    };
  }

  return inputPayload;
};
