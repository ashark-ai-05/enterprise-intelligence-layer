import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as ort from "onnxruntime-web";
import type { Embedder } from "./types.js";

interface TokenizerFile {
  model: {
    vocab: Record<string, number>;
    unk_token: string;
    continuing_subword_prefix: string;
  };
}

const MODEL_NAME = "Xenova/all-MiniLM-L6-v2";
const DEFAULT_MODEL_ROOT = fileURLToPath(
  new URL("../../models", import.meta.url),
);

function normalize(text: string): string {
  return text
    .replaceAll(String.fromCharCode(0), "")
    .replaceAll("�", "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
}

function basicTokens(text: string): string[] {
  return normalize(text).match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu) ?? [];
}

class WordPieceTokenizer {
  private readonly vocab: Record<string, number>;
  private readonly unknownId: number;
  private readonly prefix: string;

  constructor(file: TokenizerFile) {
    this.vocab = file.model.vocab;
    this.unknownId = this.vocab[file.model.unk_token] ?? 100;
    this.prefix = file.model.continuing_subword_prefix;
  }

  encode(text: string, maxTokens: number): number[] {
    const pieces: number[] = [101];
    for (const token of basicTokens(text)) {
      if (pieces.length >= maxTokens - 1) break;
      let start = 0;
      const tokenPieces: number[] = [];
      while (start < token.length) {
        let end = token.length;
        let id: number | undefined;
        while (start < end) {
          const candidate = `${start === 0 ? "" : this.prefix}${token.slice(start, end)}`;
          id = this.vocab[candidate];
          if (id !== undefined) break;
          end -= 1;
        }
        if (id === undefined) {
          tokenPieces.length = 0;
          tokenPieces.push(this.unknownId);
          break;
        }
        tokenPieces.push(id);
        start = end;
      }
      for (const id of tokenPieces) {
        if (pieces.length >= maxTokens - 1) break;
        pieces.push(id);
      }
    }
    pieces.push(102);
    return pieces;
  }
}

export interface LocalWasmEmbedderOptions {
  modelRoot?: string;
  maxTokens?: number;
}

export class LocalWasmEmbedder implements Embedder {
  readonly id = `local:${MODEL_NAME}:q8:wasm:v1`;
  readonly dimension = 384;
  readonly maxTokens: number;
  private readonly modelRoot: string;
  private tokenizerPromise: Promise<WordPieceTokenizer> | undefined;
  private sessionPromise: Promise<ort.InferenceSession> | undefined;

  constructor(options: LocalWasmEmbedderOptions = {}) {
    this.modelRoot = options.modelRoot ?? DEFAULT_MODEL_ROOT;
    this.maxTokens = options.maxTokens ?? 128;
    if (!Number.isInteger(this.maxTokens) || this.maxTokens < 2) {
      throw new Error("maxTokens must be an integer of at least 2");
    }
  }

  private tokenizer(): Promise<WordPieceTokenizer> {
    this.tokenizerPromise ??= readFile(
      `${this.modelRoot}/${MODEL_NAME}/tokenizer.json`,
      "utf8",
    ).then(
      (content) => new WordPieceTokenizer(JSON.parse(content) as TokenizerFile),
    );
    return this.tokenizerPromise;
  }

  private session(): Promise<ort.InferenceSession> {
    if (!this.sessionPromise) {
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      this.sessionPromise = readFile(
        `${this.modelRoot}/${MODEL_NAME}/onnx/model_quantized.onnx`,
      ).then((model) =>
        ort.InferenceSession.create(model, { executionProviders: ["wasm"] }),
      );
    }
    return this.sessionPromise;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const tokenizer = await this.tokenizer();
    const encoded = texts.map((text) => tokenizer.encode(text, this.maxTokens));
    const width = Math.max(...encoded.map((tokens) => tokens.length));
    const size = texts.length * width;
    const ids = new BigInt64Array(size);
    const mask = new BigInt64Array(size);
    const types = new BigInt64Array(size);
    for (const [row, tokens] of encoded.entries()) {
      for (const [column, token] of tokens.entries()) {
        const offset = row * width + column;
        ids[offset] = BigInt(token);
        mask[offset] = 1n;
      }
    }
    const dimensions: [number, number] = [texts.length, width];
    const session = await this.session();
    const output = await session.run({
      input_ids: new ort.Tensor("int64", ids, dimensions),
      attention_mask: new ort.Tensor("int64", mask, dimensions),
      token_type_ids: new ort.Tensor("int64", types, dimensions),
    });
    const hidden = output.last_hidden_state;
    if (!hidden || !(hidden.data instanceof Float32Array)) {
      throw new Error("MiniLM did not return a float32 last_hidden_state");
    }
    const vectors: Float32Array[] = [];
    for (let row = 0; row < texts.length; row += 1) {
      const vector = new Float32Array(this.dimension);
      let tokenCount = 0;
      for (let token = 0; token < width; token += 1) {
        if (mask[row * width + token] === 0n) continue;
        tokenCount += 1;
        const start = (row * width + token) * this.dimension;
        for (let dimension = 0; dimension < this.dimension; dimension += 1) {
          vector[dimension] =
            (vector[dimension] ?? 0) + (hidden.data[start + dimension] ?? 0);
        }
      }
      let magnitude = 0;
      for (let dimension = 0; dimension < vector.length; dimension += 1) {
        vector[dimension] = (vector[dimension] ?? 0) / tokenCount;
        magnitude += (vector[dimension] ?? 0) ** 2;
      }
      magnitude = Math.sqrt(magnitude);
      if (!Number.isFinite(magnitude) || magnitude === 0) {
        throw new Error("MiniLM returned a zero or invalid vector");
      }
      for (let dimension = 0; dimension < vector.length; dimension += 1) {
        vector[dimension] = (vector[dimension] ?? 0) / magnitude;
      }
      vectors.push(vector);
    }
    return vectors;
  }
}
