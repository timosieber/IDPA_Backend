import { prisma } from "../lib/prisma.js";

const TOOL_NAME = "search_knowledge_base";

const sanitizeSystemPrompt = (prompt: string): string => {
  const lines = prompt.split("\n");
  const filtered = lines.filter((line) => !line.toLowerCase().includes(TOOL_NAME.toLowerCase()));
  return filtered.join("\n").replace(/\n{3,}/g, "\n\n").trim();
};

async function main() {
  const args = new Set(process.argv.slice(2));
  const apply = args.has("--apply");

  const chatbots = await prisma.chatbot.findMany({
    select: { id: true, name: true, systemPrompt: true },
    where: { systemPrompt: { not: null } },
  });

  const toUpdate = chatbots
    .map((bot) => {
      const systemPrompt = bot.systemPrompt ?? "";
      if (!systemPrompt.toLowerCase().includes(TOOL_NAME.toLowerCase())) return null;
      const sanitized = sanitizeSystemPrompt(systemPrompt);
      if (sanitized === systemPrompt.trim()) return null;
      return { id: bot.id, name: bot.name, before: systemPrompt, after: sanitized };
    })
    .filter((x): x is NonNullable<typeof x> => Boolean(x));

  if (!toUpdate.length) {
    // eslint-disable-next-line no-console
    console.log(`✅ Keine Chatbot-Prompts enthalten "${TOOL_NAME}".`);
    return;
  }

  // eslint-disable-next-line no-console
  console.log(`🔎 Gefunden: ${toUpdate.length} Chatbot(s) mit "${TOOL_NAME}" im systemPrompt.`);

  if (!apply) {
    // eslint-disable-next-line no-console
    console.log("Dry-run: mit `--apply` werden die Prompts aktualisiert.");
    // eslint-disable-next-line no-console
    console.log("Beispiele:");
    toUpdate.slice(0, 5).forEach((u) => {
      // eslint-disable-next-line no-console
      console.log(`- ${u.name} (${u.id})`);
    });
    return;
  }

  const chunkSize = 50;
  for (let i = 0; i < toUpdate.length; i += chunkSize) {
    const chunk = toUpdate.slice(i, i + chunkSize);
    await prisma.$transaction(
      chunk.map((u) =>
        prisma.chatbot.update({
          where: { id: u.id },
          data: { systemPrompt: u.after },
        }),
      ),
    );
  }

  // eslint-disable-next-line no-console
  console.log(`✅ Aktualisiert: ${toUpdate.length} Chatbot(s).`);
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("❌ sanitize-chatbot-prompts fehlgeschlagen:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });

