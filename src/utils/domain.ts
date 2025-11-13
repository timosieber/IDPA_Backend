import { BadRequestError, ForbiddenError } from "./errors.js";

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

export const ensureDomainAllowed = (origin: string | undefined, allowedDomains: string[]) => {
  if (!origin) {
    throw new ForbiddenError("Origin Header fehlt");
  }

  const normalizedOrigin = normalizeHostname(origin);
  if (!allowedDomains.length) {
    throw new ForbiddenError("Keine Domains freigeschaltet");
  }

  const match = allowedDomains.some((domain) => normalizedOrigin === domain || normalizedOrigin.endsWith(`.${domain}`));
  if (!match) {
    throw new ForbiddenError(`Domain ${normalizedOrigin} ist für diesen Chatbot nicht freigegeben`);
  }
};
