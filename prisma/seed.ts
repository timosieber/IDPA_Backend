import { PrismaClient } from "../src/generated/prisma/index.js";

const prisma = new PrismaClient();

async function main() {
  const demoUser = await prisma.user.upsert({
    where: { id: "demo-user" },
    update: {},
    create: { id: "demo-user", email: "demo@example.com" },
  });

  await prisma.chatbot.upsert({
    where: { id: "demo-chatbot" },
    update: {},
    create: {
      id: "demo-chatbot",
      userId: demoUser.id,
      name: "Demo Bot",
      description: "Hilfreicher Demo-Chatbot",
      allowedDomains: ["localhost"],
      model: "gpt-4o-mini",
      status: "ACTIVE",
    },
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
