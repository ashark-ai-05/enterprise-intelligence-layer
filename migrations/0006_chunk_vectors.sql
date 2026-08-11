CREATE TABLE chunk_vectors (
  chunk_id uuid NOT NULL REFERENCES resource_chunks(id) ON DELETE CASCADE,
  model_id text NOT NULL,
  dimension integer NOT NULL CHECK (dimension > 0),
  embedding float4[] NOT NULL,
  content_hash text NOT NULL,
  embedded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chunk_id, model_id),
  CHECK (array_length(embedding, 1) = dimension)
);

CREATE INDEX chunk_vectors_model_idx
  ON chunk_vectors (model_id, chunk_id);
