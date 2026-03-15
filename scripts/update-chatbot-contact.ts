/**
 * Script to update chatbot contact information in the theme JSON field.
 *
 * Usage: npx tsx scripts/update-chatbot-contact.ts
 *
 * Make sure DATABASE_URL is set in your environment.
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const CHATBOT_ID = "cmku3lyc50003t3015w6l8fzp";

// BBZ Solothurn-Grenchen Kontaktdaten
const CONTACT_INFO = {
  contactPhone: "032 627 78 04",
  contactEmail: "info@bbzsogr.ch",
  contactUrl: "https://bbzsogr.so.ch",
};

async function main() {
  console.log(`Updating chatbot ${CHATBOT_ID} with contact info...`);

  const chatbot = await prisma.chatbot.findUnique({
    where: { id: CHATBOT_ID },
  });

  if (!chatbot) {
    console.error(`Chatbot ${CHATBOT_ID} not found!`);
    process.exit(1);
  }

  console.log(`Found chatbot: ${chatbot.name}`);
  console.log(`Current theme:`, chatbot.theme);

  // Merge contact info into existing theme
  const currentTheme = (chatbot.theme as Record<string, any>) || {};
  const updatedTheme = {
    ...currentTheme,
    ...CONTACT_INFO,
  };

  const updated = await prisma.chatbot.update({
    where: { id: CHATBOT_ID },
    data: {
      theme: updatedTheme,
    },
  });

  console.log(`Updated theme:`, updated.theme);
  console.log("Done!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
