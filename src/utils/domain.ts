import { BadRequestError } from "./errors.js";

export const normalizeHostname = (domain: string) => {
  try {
    const normalized = new URL(domain.startsWith("http") ? domain : `https://${domain}`).hostname.toLowerCase();
    if (!normalized) {
      throw new BadRequestError("Ungültige Domain");
    }
    return normalized.replace(/^www\./, "");
  } catch (error) {
    throw new BadRequestError("Ungültige Domain");
  }
};
