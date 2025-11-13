import { Account, Client } from "node-appwrite";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { extractBearerToken } from "../utils/token.js";
import { UnauthorizedError } from "../utils/errors.js";

export interface AuthenticatedUser {
  id: string;
  email?: string;
}

interface AppwriteConfig {
  endpoint: string;
  projectId: string;
  selfSigned: boolean;
}

export class AuthService {
  private readonly appwriteConfig?: AppwriteConfig;

  constructor() {
    if (env.APPWRITE_ENDPOINT && env.APPWRITE_PROJECT_ID) {
      this.appwriteConfig = {
        endpoint: env.APPWRITE_ENDPOINT,
        projectId: env.APPWRITE_PROJECT_ID,
        selfSigned: env.APPWRITE_SELF_SIGNED,
      };
    }
  }

  async verifyDashboardRequest(authHeader?: string | null, mockUserId?: string | null): Promise<AuthenticatedUser> {
    const token = extractBearerToken(authHeader ?? undefined);
    if (token && this.appwriteConfig) {
      try {
        const account = this.buildAccountClient(token);
        const profile = await account.get();
        return { id: profile.$id, email: profile.email };
      } catch (error) {
        logger.warn({ err: error }, "Appwrite verification failed");
        throw new UnauthorizedError("Appwrite-Authentifizierung fehlgeschlagen");
      }
    }

    if (env.ALLOW_DEBUG_HEADERS && mockUserId) {
      return { id: mockUserId };
    }

    throw new UnauthorizedError("Authorization Header oder Debug User fehlt");
  }

  private buildAccountClient(jwt: string) {
    if (!this.appwriteConfig) {
      throw new UnauthorizedError("Appwrite nicht konfiguriert");
    }

    const client = new Client()
      .setEndpoint(this.appwriteConfig.endpoint)
      .setProject(this.appwriteConfig.projectId)
      .setJWT(jwt);

    if (this.appwriteConfig.selfSigned) {
      client.setSelfSigned(true);
    }

    return new Account(client);
  }
}

export const authService = new AuthService();
