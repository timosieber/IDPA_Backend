export const chunkText = (text: string, chunkSize = 800, overlap = 100) => {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];

  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    const end = Math.min(start + chunkSize, normalized.length);
    chunks.push(normalized.slice(start, end).trim());
    if (end === normalized.length) break;
    start = end - overlap;
    if (start < 0) start = 0;
  }
  return chunks;
};
