import { prisma } from "../lib/prisma.js";

class UserService {
  async ensureUser(id: string, email?: string) {
    return prisma.user.upsert({
      where: { id },
      create: { id, email: email ?? `${id}@placeholder.local` },
      update: email ? { email } : {},
    });
  }
}

export const userService = new UserService();
