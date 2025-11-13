declare module "@mozilla/readability" {
  interface ReadabilityResult {
    title?: string;
    byline?: string;
    dir?: string;
    content?: string;
    textContent?: string;
    length?: number;
    excerpt?: string;
  }

  export class Readability {
    constructor(document: Document, options?: Record<string, unknown>);
    parse(): ReadabilityResult | null;
  }
}
