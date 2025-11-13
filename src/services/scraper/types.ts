export interface ScrapeOptions {
  startUrls: string[];
  maxDepth?: number;
  maxPages?: number;
  respectRobotsTxt?: boolean;
  includeGlobs?: string[];
  excludeGlobs?: string[];
  maxConcurrency?: number;
  rateLimitPerHost?: number;
  allowFullDownload?: boolean;
}

export interface DatasetLink {
  href: string;
  canonical_href: string;
  anchor_text: string;
  context_snippet: string;
}

export interface DatasetHeadings {
  h1: string[];
  h2: string[];
  h3: string[];
}

export interface DatasetPdfPage {
  page_no: number;
  text: string;
}

export interface DatasetPdf {
  type: "pdf";
  source_page: string;
  pdf_url: string;
  title: string;
  http_head: {
    status: number;
    content_type: string;
    content_length: number | null;
    last_modified: string | null;
    etag: string | null;
    accept_ranges: string | null;
  };
  range_supported: boolean;
  bytes_loaded: number;
  pages: DatasetPdfPage[];
  overall: {
    page_count: number;
    warnings: string[];
    aborted_due_to_budget: boolean;
  };
  perplexity_content?: string;
  extraction_method?: "pdfjs" | "perplexity";
}

export interface DatasetPage {
  type: "page";
  page_url: string;
  canonical_url: string;
  title: string | null;
  main_text: string;
  headings: DatasetHeadings;
  links: DatasetLink[];
  fetched_at: string;
  meta: Record<string, unknown>;
  lang: Record<string, unknown>;
  pdfs?: DatasetPdf[];
}

export type DatasetItem = DatasetPage;
