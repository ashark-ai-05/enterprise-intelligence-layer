/**
 * Query classification.
 *
 * The classifier moves arm *weights*. It never removes an arm from the fan-out.
 *
 * That restraint is the whole design: a router that cuts arms is a router whose
 * mistakes are invisible, because the arm that would have found the answer was
 * never asked. Weighting a wrong guess costs a few positions; cutting an arm on
 * a wrong guess costs the result entirely.
 *
 * → docs/06-retrieval.md
 */

export type QueryShape =
  | "issue-key" // PHX-4471
  | "path" // src/payments/retry.ts
  | "identifier" // camelCase, snake_case, Foo::bar, doThing(
  | "quoted-phrase" // "exact wording"
  | "error-string" // NullPointerException, ECONNREFUSED
  | "natural-language";

export interface Classification {
  readonly shape: QueryShape;
  /** Arm name → weight multiplier. Absent arms default to 1. */
  readonly weights: Readonly<Record<string, number>>;
  /** Extracted literal, when the shape implies one worth looking up directly. */
  readonly literal?: string;
}

const ISSUE_KEY = /^[A-Z][A-Z0-9]{1,9}-\d+$/;
const PATH_LIKE = /^[\w.@-]+(\/[\w.@-]+)+(\.\w+)?$/;
const IDENTIFIER =
  /^(?:[a-z]+(?:[A-Z][a-z0-9]*)+|[a-z0-9]+(?:_[a-z0-9]+)+|\w+::\w+|\w+\()/;
const ERROR_STRING = /(?:^|\s)(?:[A-Z]\w*(?:Error|Exception)|E[A-Z]{4,})\b/;

/**
 * Classify a query by shape.
 *
 * Cheap, deterministic, no model. Order matters: the most specific shapes are
 * tested first, because an issue key is also a valid identifier and a path is
 * also a plausible phrase.
 */
export function classify(text: string): Classification {
  const trimmed = text.trim();

  if (ISSUE_KEY.test(trimmed)) {
    return {
      shape: "issue-key",
      literal: trimmed,
      // An exact key is a lookup, not a search. Lexical dominates; semantic is
      // near-useless but stays in the fan-out in case the key appears in prose.
      weights: {
        "lexical-strict": 6,
        "lexical-loose": 1,
        semantic: 0.2,
        federated: 3,
      },
    };
  }

  if (/^".+"$/s.test(trimmed)) {
    return {
      shape: "quoted-phrase",
      literal: trimmed.slice(1, -1),
      weights: {
        "lexical-strict": 5,
        "lexical-loose": 0.5,
        semantic: 0.5,
        federated: 2,
      },
    };
  }

  if (PATH_LIKE.test(trimmed)) {
    return {
      shape: "path",
      literal: trimmed,
      weights: { "code-lexical": 5, "lexical-strict": 2, semantic: 0.3 },
    };
  }

  if (IDENTIFIER.test(trimmed) && !trimmed.includes(" ")) {
    return {
      shape: "identifier",
      literal: trimmed,
      weights: { "code-lexical": 4, "lexical-strict": 2, semantic: 0.5 },
    };
  }

  if (ERROR_STRING.test(trimmed)) {
    return {
      shape: "error-string",
      // Error strings appear verbatim in code, in tickets and in runbooks, so
      // every lexical arm matters and none dominates.
      weights: {
        "lexical-strict": 3,
        "code-lexical": 3,
        semantic: 0.8,
        federated: 2,
      },
    };
  }

  return {
    shape: "natural-language",
    // The case embeddings exist for. Lexical still runs: enterprise jargon and
    // acronyms are exactly what a general-purpose model has never seen.
    weights: {
      semantic: 2,
      "lexical-loose": 1.5,
      "lexical-strict": 1,
      "graph-expand": 1,
    },
  };
}

/** Weight for an arm under a classification. Unlisted arms participate at 1. */
export function weightFor(
  classification: Classification,
  armName: string,
): number {
  return classification.weights[armName] ?? 1;
}
