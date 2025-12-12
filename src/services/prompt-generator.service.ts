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

export interface RagPromptSourceInput {
  label: string;
  uri: string | null;
  type: "URL" | "TEXT" | "FILE";
  snippets: string[];
}

class PromptGeneratorService {
  private readonly client?: OpenAI;
  private static readonly TOOL_NAME = "search_knowledge_base";

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
3. Die Hauptprodukte/Services klar benennt
4. Professionell und freundlich ist
5. Auf Deutsch formuliert ist

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
        return this.sanitizeSystemPrompt(generatedPrompt);
      }

      logger.warn("Keine Antwort von OpenAI – Verwende Default-Prompt");
      return this.getDefaultPrompt();
    } catch (error) {
      logger.error({ err: error }, "Fehler bei Prompt-Generierung");
      return this.getDefaultPrompt();
    }
  }

  /**
   * Generiert einen Custom System Prompt NUR aus RAG/Wissensbasis-Auszügen.
   * Wichtig: Keine erfundenen Leistungen/Programme – nur was in den Snippets steht.
   */
  async generateSystemPromptFromRag(sources: RagPromptSourceInput[]): Promise<string> {
    if (!this.client) {
      logger.warn("OPENAI_API_KEY nicht gesetzt – Verwende Default-Prompt");
      return this.getDefaultPrompt();
    }

    const compactSources = sources
      .filter((s) => s.snippets?.some((t) => t.trim().length > 0))
      .slice(0, 10)
      .map((s) => ({
        label: s.label,
        uri: s.uri,
        type: s.type,
        snippets: s.snippets.map((t) => t.slice(0, 900)),
      }));

    const promptGenerationPrompt = [
      "Du bist ein Experte für die Erstellung von Chatbot System Prompts.",
      "",
      "Du erhältst Auszüge aus der Wissensbasis (RAG) eines Unternehmens.",
      "Erstelle daraus einen präzisen System Prompt für einen Support-Chatbot.",
      "",
      "KRITISCHE REGELN:",
      "- Erfinde KEINE Produkte/Programme/Services/Personen/Adressen.",
      "- Wenn Informationen nicht in den Auszügen stehen: Der Chatbot soll kurz nachfragen oder 'Das wissen wir aktuell nicht' sagen.",
      "- Keine Floskeln wie 'Vielen Dank für Ihre Anfrage'.",
      "- Kurze, konkrete Antworten (2–4 Sätze).",
      "- Professionell und freundlich auf Deutsch.",
      "",
      "Wissensbasis-Auszüge (Quellen + Text):",
      JSON.stringify(compactSources, null, 2),
      "",
      "FORMAT:",
      "- Der Prompt muss direkt verwendbar sein (keine Einleitung).",
      "- Enthält klare Regeln + 1–2 Beispiele, wie man auf Fragen zu Anmeldung/Kontakt reagiert (nur wenn in den Auszügen Hinweise dazu vorkommen).",
    ].join("\n");

    try {
      const completion = await this.client.chat.completions.create({
        model: env.OPENAI_COMPLETIONS_MODEL || "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "Du bist ein Experte für Chatbot-Prompt-Engineering. Erstelle präzise, effektive System Prompts ohne Halluzinationen.",
          },
          {
            role: "user",
            content: promptGenerationPrompt,
          },
        ],
        max_tokens: 900,
        temperature: 0.4,
      });

      const generatedPrompt = completion.choices[0]?.message?.content?.trim();
      if (generatedPrompt) {
        logger.info("RAG System Prompt erfolgreich generiert");
        return this.sanitizeSystemPrompt(generatedPrompt);
      }

      logger.warn("Keine Antwort von OpenAI – Verwende Default-Prompt");
      return this.getDefaultPrompt();
    } catch (error) {
      logger.error({ err: error }, "Fehler bei RAG Prompt-Generierung");
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
- Antworte professionell und freundlich auf Deutsch`;
  }

  private sanitizeSystemPrompt(prompt: string): string {
    // Das Backend nutzt im produktiven Chat-Flow aktuell keine Tool-Calls.
    // Entferne Tool-Referenzen, damit das Modell keine nicht verfügbare Fähigkeit "halluziniert".
    const tool = PromptGeneratorService.TOOL_NAME;
    const lines = prompt.split("\n");
    const filtered = lines.filter((line) => !line.toLowerCase().includes(tool.toLowerCase()));
    return filtered.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }
}

export const promptGeneratorService = new PromptGeneratorService();
