import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { UnauthorizedError } from "./errors.js";

interface SessionPayload {
  sessionId: string;
  chatbotId: string;
}

export const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

export const signSessionToken = (payload: SessionPayload) =>
  jwt.sign(payload, env.JWT_SECRET, { expiresIn: `${env.SESSION_TTL_MINUTES}m` });

export const verifySessionToken = (token: string) => {
  try {
    return jwt.verify(token, env.JWT_SECRET) as SessionPayload;
  } catch {
    throw new UnauthorizedError("Session-Token ungültig oder abgelaufen");
  }
};

export const extractBearerToken = (header?: string | null) => {
  if (!header) return undefined;
  const [scheme, value] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !value) return undefined;
  return value;
};
