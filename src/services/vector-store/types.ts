export interface VectorMetadata {
  chatbotId: string;
  knowledgeSourceId: string;
  chunkIndex: number;
  label: string;
}

export interface VectorMatch {
  id: string;
  score: number;
  metadata: VectorMetadata;
  content: string;
}

export interface VectorStore {
  upsertEmbedding(args: {
    vectorId?: string;
    vector: number[];
    metadata: VectorMetadata;
    content: string;
  }): Promise<string>;

  similaritySearch(args: { chatbotId: string; vector: number[]; topK: number }): Promise<VectorMatch[]>;

  deleteByKnowledgeSource(args: { chatbotId: string; knowledgeSourceId: string }): Promise<void>;
}
