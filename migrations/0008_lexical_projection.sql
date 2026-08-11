ALTER TABLE resource_chunks
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce(text, ''))) STORED;

CREATE INDEX resource_chunks_search_vector_idx
  ON resource_chunks USING GIN (search_vector)
  WHERE deleted_at IS NULL;
