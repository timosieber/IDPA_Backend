import OpenAI from "openai";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

interface ScrapedPageData {
  title?: string | null;
  meta?: {
    description?: string;
    keywords?: string | null;
  };
  headings?: {
    h1?: string[];
    h2?: string[];
    h3?: string[];
  };
  main_text?: string | null;
}

class PromptGeneratorService {
  private readonly client?: OpenAI;

  constructor() {
    if (env.OPENAI_API_KEY) {
      this.client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    }
  }

  /**
   * Generiert einen Custom System Prompt basierend auf gescrapten Website-Daten
   */
  async generateSystemPrompt(scrapedPages: ScrapedPageData[]): Promise<string> {
    if (!this.client) {
      logger.warn("OPENAI_API_KEY nicht gesetzt – Verwende Default-Prompt");
      return this.getDefaultPrompt();
    }

    // Extrahiere die wichtigsten Infos aus allen Seiten
    const companyInfo = this.extractCompanyInfo(scrapedPages);

    const promptGenerationPrompt = `Du bist ein Experte für die Erstellung von Chatbot System Prompts.

Analysiere die folgenden Informationen über ein Unternehmen und erstelle einen präzisen, effektiven System Prompt für deren Support-Chatbot.

UNTERNEHMENS-INFORMATIONEN:
Firma: ${companyInfo.companyName}
Beschreibung: ${companyInfo.description}
Hauptprodukte/Services: ${companyInfo.products.join(", ")}
Branche: ${companyInfo.industry}
Zielgruppe: ${companyInfo.targetAudience}
Wichtige Keywords: ${companyInfo.keywords.join(", ")}

WICHTIGE FEATURES:
${companyInfo.features.map(f => `- ${f}`).join("\n")}

Erstelle einen System Prompt, der:
1. Die Unternehmensperspektive nutzt ("wir", "uns", "unser")
2. Kurze, präzise Antworten fördert (max 2-3 Sätze)
3. Das search_knowledge_base Tool erwähnt
4. Die Hauptprodukte/Services klar benennt
5. Professionell und freundlich ist
6. Auf Deutsch formuliert ist

FORMAT:
Der Prompt sollte direkt verwendbar sein (keine Einleitung wie "Hier ist der Prompt:").
Verwende klare Anweisungen und konkrete Beispiele.`;

    try {
      const completion = await this.client.chat.completions.create({
        model: env.OPENAI_COMPLETIONS_MODEL || "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "Du bist ein Experte für Chatbot-Prompt-Engineering. Erstelle präzise, effektive System Prompts.",
          },
          {
            role: "user",
            content: promptGenerationPrompt,
          },
        ],
        max_tokens: 800,
        temperature: 0.7,
      });

      const generatedPrompt = completion.choices[0]?.message?.content?.trim();

      if (generatedPrompt) {
        logger.info("System Prompt erfolgreich generiert");
        return generatedPrompt;
      }

      logger.warn("Keine Antwort von OpenAI – Verwende Default-Prompt");
      return this.getDefaultPrompt();
    } catch (error) {
      logger.error({ err: error }, "Fehler bei Prompt-Generierung");
      return this.getDefaultPrompt();
    }
  }

  /**
   * Extrahiert strukturierte Unternehmens-Informationen aus gescrapten Daten
   */
  private extractCompanyInfo(scrapedPages: ScrapedPageData[]) {
    const firstPage = scrapedPages[0] || {};

    // Company Name aus Title extrahieren
    const companyName = firstPage.title?.split("|")[0]?.split("-")[0]?.trim() || "Unternehmen";

    // Description aus Meta-Daten
    const description = firstPage.meta?.description || "";

    // Alle Headings sammeln
    const allHeadings = scrapedPages.flatMap(page => [
      ...(page.headings?.h1 || []),
      ...(page.headings?.h2 || []),
      ...(page.headings?.h3 || []),
    ]);

    // Keywords extrahieren (aus description und headings)
    const textForKeywords = [
      description,
      ...allHeadings.slice(0, 10),
    ].join(" ");

    const keywords = this.extractKeywords(textForKeywords);

    // Produkte/Services aus Headings identifizieren
    const products = this.identifyProducts(allHeadings);

    // Branche identifizieren
    const industry = this.identifyIndustry(textForKeywords);

    // Zielgruppe identifizieren
    const targetAudience = this.identifyTargetAudience(textForKeywords);

    // Features sammeln
    const features = allHeadings
      .filter(h =>
        h.includes("Funktion") ||
        h.includes("Feature") ||
        h.includes("Vorteil") ||
        h.includes("Management") ||
        h.includes("Tracking")
      )
      .slice(0, 5);

    return {
      companyName,
      description,
      products,
      industry,
      targetAudience,
      keywords,
      features,
    };
  }

  private extractKeywords(text: string): string[] {
    const commonWords = new Set([
      "und", "oder", "der", "die", "das", "mit", "für", "auf", "im", "in", "zu", "von",
      "den", "dem", "des", "ein", "eine", "ist", "sind", "werden", "wird", "sich",
      "haben", "hat", "kann", "können", "machen", "macht", "alle", "was", "wie",
    ]);

    const words = text
      .toLowerCase()
      .replace(/[^\w\säöüß-]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 3 && !commonWords.has(w));

    // Häufigste Wörter zählen
    const wordCount = new Map<string, number>();
    words.forEach(w => wordCount.set(w, (wordCount.get(w) || 0) + 1));

    return Array.from(wordCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([word]) => word);
  }

  private identifyProducts(headings: string[]): string[] {
    const productKeywords = [
      "zeiterfassung", "gps", "tracking", "management", "dashboard",
      "software", "app", "plattform", "lösung", "system", "tool",
    ];

    const products = headings
      .filter(h =>
        productKeywords.some(kw => h.toLowerCase().includes(kw)) &&
        h.length < 50
      )
      .slice(0, 5);

    return products.length > 0 ? products : ["Hauptprodukt"];
  }

  private identifyIndustry(text: string): string {
    const lowerText = text.toLowerCase();

    if (lowerText.includes("baustell") || lowerText.includes("handwerk")) {
      return "Baubranche / Handwerk";
    }
    if (lowerText.includes("zeiterfassung") || lowerText.includes("personal")) {
      return "HR / Zeitmanagement";
    }
    if (lowerText.includes("software") || lowerText.includes("digital")) {
      return "Software / Digitale Lösungen";
    }

    return "Dienstleistungen";
  }

  private identifyTargetAudience(text: string): string {
    const lowerText = text.toLowerCase();

    if (lowerText.includes("handwerk") || lowerText.includes("betrieb")) {
      return "Handwerksbetriebe";
    }
    if (lowerText.includes("unternehmen") || lowerText.includes("firma")) {
      return "Unternehmen";
    }
    if (lowerText.includes("schweiz")) {
      return "Schweizer Unternehmen";
    }

    return "Geschäftskunden";
  }

  private getDefaultPrompt(): string {
    return `Du bist ein hilfreicher Support-Chatbot.

Wichtige Regeln:
- Sprich aus Unternehmensperspektive (wir, uns, unser)
- Halte Antworten kurz und präzise (max 2-3 Sätze)
- Nutze das search_knowledge_base Tool für Informationen
- Antworte professionell und freundlich auf Deutsch`;
  }
}

export const promptGeneratorService = new PromptGeneratorService();
