// Local RAG pipeline smoke test with offline-friendly defaults.
// Forces memory vector store + mock LLM to avoid network calls in constrained environments.

process.env.VECTOR_DB_PROVIDER = "memory";
process.env.MOCK_LLM = "1";

import crypto from "node:crypto";

async function runTest() {
  console.log("Bootstrapping test-pipeline...");
  const { KnowledgeService } = await import("./services/knowledge.service.ts");
  const { ChatService } = await import("./services/chat.service.ts");

  console.log("🚀 Starte RAG System Test...");

  // 1. Scraper Test (mocked)
  console.log("\n--- Schritt 1: Scraper Mock ---");
  const scrapedData = {
    markdownContent:
      "# Willkommen bei IDPA Test\n\nDas ist ein Test-Dokument.\n\n## Wichtige Info\nDas Geheimnis lautet: 'RAG funktioniert super'.",
    metadata: {
      title: "IDPA Test Page",
      sourceUrl: "https://test.local",
      type: "web" as const,
      datePublished: new Date().toISOString(),
      chatbotId: "test-bot",
    },
  };
  console.log("✅ Scraper-Daten vorbereitet.");

  // 2. Ingestion Test
  console.log("\n--- Schritt 2: Ingestion & Contextual Chunking ---");
  const knowledgeService = new KnowledgeService();
  await knowledgeService.processIngestion({
    content: scrapedData.markdownContent,
    metadata: scrapedData.metadata,
  });
  console.log("✅ Ingestion abgeschlossen.");

  // 3. DB Check
  console.log("\n--- Schritt 3: Vektor-DB Inspektion ---");
  const chatService = new ChatService();
  const vector = mockEmbedding("Geheimnis");
  const rawResults = await (chatService as any).vectorStore.similaritySearch({
    chatbotId: "test-bot",
    vector,
    topK: 2,
  });

  rawResults.forEach((doc: any, i: number) => {
    console.log(`\n[Chunk ${i + 1}]`);
    console.log(`Preview: ${String(doc.content).substring(0, 100)}...`);
    if (String(doc.content).includes("[Kontext:")) {
      console.log("✅ SUCCESS: Contextual Header gefunden!");
    } else {
      console.log("❌ WARNING: Kein Contextual Header gefunden!");
    }
  });

  // 4. Retrieval Test
  console.log("\n--- Schritt 4: Chat Antwort ---");
  const response = await chatService.generateResponse({
    chatbotId: "test-bot",
    message: "Wie lautet das Geheimnis?",
    history: [],
  });

  console.log("\n🤖 Bot Antwort:", response.answer);
}

function mockEmbedding(text: string): number[] {
  const hash = crypto.createHash("sha256").update(text).digest();
  return Array.from(hash).map((byte) => (byte / 255) * 2 - 1);
}

runTest().catch((err) => {
  console.error("❌ Test-Pipeline fehlgeschlagen:", err);
  if (err?.stack) console.error(err.stack);
  process.exit(1);
});
