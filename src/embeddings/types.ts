export interface Embedder {
  readonly id: string;
  readonly dimension: number;
  readonly maxTokens: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}
