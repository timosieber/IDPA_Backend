import type { AuthenticatedUser } from "../services/auth.service.js";

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

export {};
