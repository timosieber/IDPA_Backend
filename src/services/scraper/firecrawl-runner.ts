import { createRequire } from "node:module";
import path from "node:path";
import FirecrawlApp from "@mendable/firecrawl-js";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import type { DatasetItem, DatasetPage, DatasetPdf, DatasetPdfPage, ScrapeOptions } from "./types.js";

// Point pdfjs-dist to its worker file so PDF parsing works in Node.js
const require = createRequire(import.meta.url);
const pdfjsDistPath = path.dirname(require.resolve("pdfjs-dist/package.json"));
GlobalWorkerOptions.workerSrc = path.join(pdfjsDistPath, "build", "pdf.worker.mjs");

// Firecrawl SDK response types
interface FirecrawlDocument {
  url?: string;
  markdown?: string;
  html?: string;
  rawHtml?: string;
  links?: string[];
  metadata?: {
    title?: string;
    description?: string;
    language?: string;
    ogTitle?: string;
    ogDescription?: string;
    ogUrl?: string;
    ogImage?: string;
    ogSiteName?: string;
    sourceURL?: string;
    statusCode?: number;
    [key: string]: unknown;
  };
}

interface FirecrawlCrawlStatusResponse {
  success: boolean;
  status?: string;
  completed?: number;
  total?: number;
  creditsUsed?: number;
  expiresAt?: string;
  data?: FirecrawlDocument[];
}

interface FirecrawlMapResponse {
  success: boolean;
  links?: string[];
}

interface FirecrawlScrapeResponse {
  success: boolean;
  markdown?: string;
  html?: string;
  links?: string[];
  metadata?: FirecrawlDocument["metadata"];
}

class FirecrawlRunner {
  private client: FirecrawlApp | null = null;

  private getClient(): FirecrawlApp {
    if (!this.client) {
      if (!env.FIRECRAWL_API_KEY) {
        throw new Error("FIRECRAWL_API_KEY is required for Firecrawl scraper");
      }
      this.client = new FirecrawlApp({ apiKey: env.FIRECRAWL_API_KEY });
    }
    return this.client;
  }

  /**
   * Main entry point - complete scraping flow:
   * 1. Map site to discover all URLs (pages + PDFs)
   * 2. Crawl all HTML pages
   * 3. Extract all PDFs
   * 4. Return combined results for vector ingestion
   */
  async run(options: ScrapeOptions): Promise<DatasetItem[]> {
    const client = this.getClient();
    const results: DatasetItem[] = [];
    const allPdfUrls = new Set<string>();

    logger.info(
      { startUrls: options.startUrls, maxDepth: options.maxDepth, maxPages: options.maxPages },
      "🚀 Starting Firecrawl scrape pipeline"
    );

    for (const startUrl of options.startUrls) {
      try {
        // ═══════════════════════════════════════════════════════════════
        // STEP 1: MAP - Discover all URLs on the site
        // ═══════════════════════════════════════════════════════════════
        logger.info({ startUrl }, "📍 Step 1: Mapping site to discover URLs...");
        const mapResponse = await this.mapSite(client, startUrl, options);
        const allUrls = mapResponse.links ?? [startUrl];

        // Separate HTML pages from PDFs
        const pageUrls = allUrls.filter(url => !this.isPdfUrl(url));
        const pdfUrls = allUrls.filter(url => this.isPdfUrl(url));

        pdfUrls.forEach(url => allPdfUrls.add(url));

        logger.info(
          { startUrl, totalUrls: allUrls.length, pages: pageUrls.length, pdfs: pdfUrls.length },
          "📍 Map completed - URLs discovered"
        );

        // ═══════════════════════════════════════════════════════════════
        // STEP 2: CRAWL - Scrape all HTML pages
        // ═══════════════════════════════════════════════════════════════
        logger.info({ startUrl, pageCount: pageUrls.length }, "📄 Step 2: Crawling HTML pages...");

        const crawlResults = await this.crawlSite(client, startUrl, options);

        // Collect any additional PDF links found during crawling
        for (const result of crawlResults) {
          if (result.type === "page") {
            const page = result as DatasetPage;
            const discoveredPdfs = (page.meta as any)?.discoveredPdfLinks as string[] | undefined;
            if (discoveredPdfs) {
              discoveredPdfs.forEach(url => allPdfUrls.add(url));
            }
          }
        }

        results.push(...crawlResults);
        logger.info(
          { startUrl, pagesScraped: crawlResults.length },
          "📄 HTML crawl completed"
        );

      } catch (error) {
        logger.error(
          { startUrl, error: error instanceof Error ? error.message : String(error) },
          "❌ Firecrawl failed for URL"
        );
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // STEP 3: EXTRACT PDFs - Download and parse all discovered PDFs
    // ═══════════════════════════════════════════════════════════════
    if (allPdfUrls.size > 0) {
      logger.info({ pdfCount: allPdfUrls.size }, "📑 Step 3: Extracting PDFs...");

      const pdfResults = await this.extractPdfs(Array.from(allPdfUrls), options);
      results.push(...pdfResults);

      logger.info(
        { totalPdfs: allPdfUrls.size, successfulPdfs: pdfResults.length },
        "📑 PDF extraction completed"
      );
    }

    logger.info(
      { totalResults: results.length, pages: results.filter(r => r.type === "page").length, pdfs: results.filter(r => r.type === "pdf").length },
      "✅ Firecrawl scrape pipeline completed"
    );

    return results;
  }

  private isPdfUrl(url: string): boolean {
    const lower = url.toLowerCase();
    return lower.endsWith(".pdf") || lower.includes(".pdf?") || lower.includes("/pdf/");
  }

  private async mapSite(
    client: FirecrawlApp,
    url: string,
    options: ScrapeOptions
  ): Promise<FirecrawlMapResponse> {
    try {
      const response = await client.map(url, {
        includeSubdomains: false,
        limit: options.maxPages ?? 100,
      }) as unknown as FirecrawlMapResponse;

      if (!response.success) {
        logger.warn({ url }, "Firecrawl map returned unsuccessful");
        return { success: false, links: [url] };
      }

      // Filter URLs based on include/exclude globs
      let links = response.links ?? [];
      if (options.includeGlobs?.length) {
        links = links.filter((link) =>
          options.includeGlobs!.some((glob) => this.matchGlob(link, glob))
        );
      }
      if (options.excludeGlobs?.length) {
        links = links.filter(
          (link) => !options.excludeGlobs!.some((glob) => this.matchGlob(link, glob))
        );
      }

      return { success: true, links };
    } catch (error) {
      logger.error({ url, error }, "Firecrawl map failed");
      return { success: false, links: [url] };
    }
  }

  private async crawlSite(
    client: FirecrawlApp,
    url: string,
    options: ScrapeOptions
  ): Promise<DatasetItem[]> {
    const results: DatasetItem[] = [];

    try {
      const crawlOpts: Record<string, unknown> = {
        limit: options.maxPages ?? 50,
        maxDiscoveryDepth: options.maxDepth ?? 2,
        scrapeOptions: {
          formats: ["markdown", "html", "rawHtml", "links"],
          onlyMainContent: false, // Get full page to find all PDF links
          includeTags: ["article", "main", "section", "div", "p", "h1", "h2", "h3", "h4", "ul", "ol", "li", "table", "a"],
          excludeTags: ["script", "style", "noscript", "iframe"],
        },
      };
      if (options.includeGlobs?.length) crawlOpts.includePaths = options.includeGlobs;
      if (options.excludeGlobs?.length) crawlOpts.excludePaths = options.excludeGlobs;

      const crawlResponse = await client.crawl(url, crawlOpts as any) as unknown as FirecrawlCrawlStatusResponse;

      // Debug: Log full response to see what Firecrawl returns
      logger.info(
        { url, response: JSON.stringify(crawlResponse).slice(0, 1000) },
        "Firecrawl crawl raw response"
      );

      // Firecrawl returns status: "completed" not success: true
      const isSuccess = crawlResponse.success === true || crawlResponse.status === "completed";
      if (!isSuccess || !crawlResponse.data) {
        logger.warn({ url, status: crawlResponse.status, success: crawlResponse.success }, "Firecrawl crawl unsuccessful");
        return results;
      }

      logger.info(
        { url, documentsReturned: crawlResponse.data.length, creditsUsed: crawlResponse.creditsUsed },
        "Firecrawl crawl API response received"
      );

      for (const doc of crawlResponse.data) {
        const converted = this.convertToDatasetPage(doc);
        if (converted) {
          results.push(converted);
        }
      }
    } catch (error) {
      logger.error({ url, error: error instanceof Error ? error.message : String(error) }, "Firecrawl crawl failed");
    }

    return results;
  }

  /**
   * Extract text from PDFs by downloading and parsing them
   */
  private async extractPdfs(pdfUrls: string[], options: ScrapeOptions): Promise<DatasetPdf[]> {
    const results: DatasetPdf[] = [];
    const maxConcurrent = options.maxConcurrency ?? 3;

    // Process PDFs in batches to avoid overwhelming the server
    for (let i = 0; i < pdfUrls.length; i += maxConcurrent) {
      const batch = pdfUrls.slice(i, i + maxConcurrent);
      const batchResults = await Promise.all(
        batch.map(url => this.extractSinglePdf(url))
      );

      for (const result of batchResults) {
        if (result) {
          results.push(result);
        }
      }

      // Small delay between batches to be respectful
      if (i + maxConcurrent < pdfUrls.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    return results;
  }

  private async extractSinglePdf(pdfUrl: string): Promise<DatasetPdf | null> {
    const startTime = Date.now();

    try {
      logger.info({ pdfUrl }, "Downloading PDF...");

      // Download PDF
      const response = await fetch(pdfUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; IDPA-Bot/1.0; +https://idpa.ch)",
        },
        signal: AbortSignal.timeout(60000), // 60s timeout
      });

      if (!response.ok) {
        logger.warn({ pdfUrl, status: response.status }, "PDF download failed");
        return null;
      }

      const contentType = response.headers.get("content-type") || "";
      const contentLength = parseInt(response.headers.get("content-length") || "0", 10);
      const lastModified = response.headers.get("last-modified");
      const etag = response.headers.get("etag");

      // Check if it's actually a PDF
      if (!contentType.includes("pdf") && !pdfUrl.toLowerCase().endsWith(".pdf")) {
        logger.warn({ pdfUrl, contentType }, "URL does not return PDF content");
        return null;
      }

      // Size limit: 50MB
      if (contentLength > 50 * 1024 * 1024) {
        logger.warn({ pdfUrl, contentLength }, "PDF too large, skipping");
        return null;
      }

      const arrayBuffer = await response.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);

      // Parse PDF using pdfjs-dist
      logger.info({ pdfUrl, bytes: uint8Array.length }, "Parsing PDF with pdfjs-dist...");

      const loadingTask = getDocument({ data: uint8Array, useSystemFonts: true });
      const pdfDoc = await loadingTask.promise;

      // Extract text page by page
      const pages: DatasetPdfPage[] = [];
      let pdfTitle: string | null = null;

      // Try to get title from metadata
      try {
        const metadata = await pdfDoc.getMetadata();
        pdfTitle = (metadata.info as Record<string, unknown>)?.Title as string | null;
      } catch {
        // Metadata extraction failed, will use URL-based title
      }

      for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
        try {
          const page = await pdfDoc.getPage(pageNum);
          const textContent = await page.getTextContent();
          const pageText = textContent.items
            .map((item: unknown) => {
              const textItem = item as { str?: string };
              return textItem.str ?? "";
            })
            .join(" ")
            .trim();

          if (pageText) {
            pages.push({ page_no: pageNum, text: pageText });
          }
        } catch (pageError) {
          logger.warn({ pdfUrl, pageNum, error: pageError }, "Failed to extract page");
        }
      }

      const totalWords = pages.reduce((sum, p) => sum + p.text.split(/\s+/).length, 0);
      const avgWordsPerPage = pdfDoc.numPages > 0 ? totalWords / pdfDoc.numPages : 0;

      // Quality check
      const textQuality = avgWordsPerPage >= 25 ? "ok" : "failed_quality";

      const elapsedMs = Date.now() - startTime;
      logger.info(
        { pdfUrl, pages: pdfDoc.numPages, words: totalWords, quality: textQuality, elapsedMs },
        "PDF parsed successfully"
      );

      const pdf: DatasetPdf = {
        type: "pdf",
        source_page: pdfUrl,
        pdf_url: pdfUrl,
        title: pdfTitle || this.extractTitleFromUrl(pdfUrl),
        fetched_at: new Date().toISOString(),
        http_head: {
          status: response.status,
          content_type: contentType,
          content_length: contentLength || uint8Array.length,
          last_modified: lastModified,
          etag: etag,
          accept_ranges: response.headers.get("accept-ranges"),
        },
        range_supported: response.headers.get("accept-ranges") === "bytes",
        bytes_loaded: uint8Array.length,
        pages,
        overall: {
          page_count: pdfDoc.numPages,
          warnings: textQuality === "failed_quality" ? ["Low text density - may be scanned/image PDF"] : [],
          aborted_due_to_budget: false,
        },
        extraction_method: "pdfjs",
        text_quality: textQuality,
      };

      return pdf;

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ pdfUrl, error: message }, "PDF extraction failed");

      // Return a failed PDF record so we track the attempt
      return {
        type: "pdf",
        source_page: pdfUrl,
        pdf_url: pdfUrl,
        title: this.extractTitleFromUrl(pdfUrl),
        fetched_at: new Date().toISOString(),
        http_head: {
          status: 0,
          content_type: "application/pdf",
          content_length: null,
          last_modified: null,
          etag: null,
          accept_ranges: null,
        },
        range_supported: false,
        bytes_loaded: 0,
        pages: [],
        overall: {
          page_count: 0,
          warnings: [`Extraction failed: ${message}`],
          aborted_due_to_budget: false,
        },
        extraction_method: "failed",
        text_quality: "failed_quality",
      };
    }
  }

  private extractTitleFromUrl(url: string): string {
    try {
      const pathname = new URL(url).pathname;
      const filename = pathname.split("/").pop() || "";
      return decodeURIComponent(filename.replace(/\.pdf$/i, "").replace(/[-_]/g, " "));
    } catch {
      return "PDF Document";
    }
  }

  private convertToDatasetPage(doc: FirecrawlDocument): DatasetPage | null {
    const url = doc.url || doc.metadata?.sourceURL || doc.metadata?.ogUrl;
    if (!url) {
      logger.warn({ doc: JSON.stringify(doc).slice(0, 200) }, "Firecrawl document missing URL");
      return null;
    }

    // Skip PDFs that might have been returned
    if (this.isPdfUrl(url)) {
      return null;
    }

    const mainText = doc.markdown || "";
    const rawHtml = doc.rawHtml || doc.html || "";
    if (!mainText.trim()) {
      logger.warn({ url }, "Firecrawl document has no content");
      return null;
    }

    const headings = this.extractHeadingsFromMarkdown(mainText);
    const links = (doc.links ?? []).map((href) => ({
      href,
      canonical_href: href,
      anchor_text: "",
      context_snippet: "",
    }));

    // Collect PDF links from both the links array and by scanning HTML/markdown for PDF URLs
    const pdfLinks = (doc.links ?? []).filter((link) => this.isPdfUrl(link));

    // Also extract PDF links from raw HTML and markdown (catches links Firecrawl might miss)
    const extractedPdfLinks = this.extractPdfLinksFromContent(rawHtml + " " + mainText, url);
    extractedPdfLinks.forEach(link => {
      if (!pdfLinks.includes(link)) {
        pdfLinks.push(link);
      }
    });

    const page: DatasetPage = {
      type: "page",
      page_url: url,
      canonical_url: doc.metadata?.ogUrl || url,
      title: doc.metadata?.title || doc.metadata?.ogTitle || null,
      main_text: mainText,
      headings,
      links,
      fetched_at: new Date().toISOString(),
      meta: {
        description: doc.metadata?.description || doc.metadata?.ogDescription,
        og: {
          title: doc.metadata?.ogTitle,
          description: doc.metadata?.ogDescription,
          image: doc.metadata?.ogImage,
          url: doc.metadata?.ogUrl,
          siteName: doc.metadata?.ogSiteName,
        },
        statusCode: doc.metadata?.statusCode,
        firecrawl: true,
        discoveredPdfLinks: pdfLinks.length > 0 ? pdfLinks : undefined,
      },
      lang: {
        declared: doc.metadata?.language,
        detected: doc.metadata?.language,
      },
    };

    return page;
  }

  private extractHeadingsFromMarkdown(markdown: string): { h1: string[]; h2: string[]; h3: string[] } {
    const h1: string[] = [];
    const h2: string[] = [];
    const h3: string[] = [];

    const lines = markdown.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("### ")) {
        h3.push(trimmed.slice(4).trim());
      } else if (trimmed.startsWith("## ")) {
        h2.push(trimmed.slice(3).trim());
      } else if (trimmed.startsWith("# ")) {
        h1.push(trimmed.slice(2).trim());
      }
    }

    return { h1, h2, h3 };
  }

  private matchGlob(url: string, glob: string): boolean {
    const regexPattern = glob
      .replace(/\*\*/g, ".*")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, ".");
    try {
      return new RegExp(regexPattern).test(url);
    } catch {
      return false;
    }
  }

  /**
   * Extract PDF links from HTML content and markdown
   * This catches PDF links that Firecrawl's link extraction might miss
   */
  private extractPdfLinksFromContent(content: string, baseUrl: string): string[] {
    const pdfLinks: string[] = [];

    // Patterns to find PDF URLs in content
    const patterns = [
      // href="...pdf"
      /href=["']([^"']*\.pdf[^"']*)/gi,
      // src="...pdf"
      /src=["']([^"']*\.pdf[^"']*)/gi,
      // data-href="...pdf"
      /data-href=["']([^"']*\.pdf[^"']*)/gi,
      // Markdown links [text](url.pdf)
      /\]\(([^)]*\.pdf[^)]*)\)/gi,
      // Plain URLs ending in .pdf
      /(https?:\/\/[^\s"'<>]*\.pdf)/gi,
      // Relative URLs like /sites/default/files/...pdf
      /(\/sites\/default\/files\/[^\s"'<>]*\.pdf)/gi,
      // Generic file paths with .pdf
      /(\/[^\s"'<>]*\/[^\s"'<>]*\.pdf)/gi,
    ];

    const baseUrlObj = new URL(baseUrl);
    const seenUrls = new Set<string>();

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        let pdfUrl = match[1];
        if (!pdfUrl) continue;

        // Clean up the URL
        pdfUrl = pdfUrl.trim();

        // Skip data URIs
        if (pdfUrl.startsWith("data:")) continue;

        // Resolve relative URLs
        try {
          if (pdfUrl.startsWith("//")) {
            pdfUrl = `${baseUrlObj.protocol}${pdfUrl}`;
          } else if (pdfUrl.startsWith("/")) {
            pdfUrl = `${baseUrlObj.origin}${pdfUrl}`;
          } else if (!pdfUrl.startsWith("http")) {
            pdfUrl = new URL(pdfUrl, baseUrl).href;
          }

          // Normalize and dedupe
          const normalizedUrl = pdfUrl.split("#")[0] ?? pdfUrl; // Remove hash
          if (normalizedUrl && !seenUrls.has(normalizedUrl) && this.isPdfUrl(normalizedUrl)) {
            seenUrls.add(normalizedUrl);
            pdfLinks.push(normalizedUrl);
          }
        } catch {
          // Invalid URL, skip
        }
      }
    }

    if (pdfLinks.length > 0) {
      logger.info({ baseUrl, pdfCount: pdfLinks.length, pdfs: pdfLinks.slice(0, 5) }, "Extracted PDF links from content");
    }

    return pdfLinks;
  }
}

export const firecrawlRunner = new FirecrawlRunner();
