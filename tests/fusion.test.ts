import { describe, expect, it } from "vitest";
import {
  type Arm,
  type ArmHit,
  DEFAULT_K,
  applyDiversityCap,
  rrf,
} from "../src/fusion/rrf.js";

const hit = (id: string, source?: string, container?: string): ArmHit => ({
  id,
  ...(source === undefined ? {} : { source }),
  ...(container === undefined ? {} : { container }),
});

const arm = (name: string, ids: string[], weight?: number): Arm => ({
  name,
  hits: ids.map((id) => hit(id)),
  ...(weight === undefined ? {} : { weight }),
});

describe("rrf", () => {
  it("scores a single arm as 1/(k+rank)", () => {
    const [first, second] = rrf([arm("lexical", ["a", "b"])]);
    expect(first!.id).toBe("a");
    expect(first!.score).toBeCloseTo(1 / (DEFAULT_K + 1), 12);
    expect(second!.score).toBeCloseTo(1 / (DEFAULT_K + 2), 12);
  });

  it("sums contributions across arms", () => {
    const fused = rrf([
      arm("lexical", ["a", "b"]),
      arm("semantic", ["b", "a"]),
    ]);
    const expected = 1 / (DEFAULT_K + 1) + 1 / (DEFAULT_K + 2);
    for (const item of fused) expect(item.score).toBeCloseTo(expected, 12);
  });

  it("ranks a document agreed on by two arms above one that leads a single arm", () => {
    // 'agreed' is 2nd in both arms; 'solo' is 1st in one arm and absent from the other.
    // This is the whole point of rank fusion: corroboration beats a single strong opinion.
    const fused = rrf([
      arm("lexical", ["solo", "agreed"]),
      arm("semantic", ["other", "agreed"]),
    ]);
    expect(fused[0]!.id).toBe("agreed");
  });

  it("never compares raw scores across arms — only ranks", () => {
    // Both arms return the same ids in the same order. Whatever the underlying
    // engines' score scales were, fusion cannot see them, so the result is
    // identical to doubling one arm.
    const twoArms = rrf([arm("a", ["x", "y"]), arm("b", ["x", "y"])]);
    const oneArmDoubleWeight = rrf([arm("a", ["x", "y"], 2)]);
    expect(twoArms.map((f) => f.id)).toEqual(
      oneArmDoubleWeight.map((f) => f.id),
    );
    expect(twoArms[0]!.score).toBeCloseTo(oneArmDoubleWeight[0]!.score, 12);
  });

  it("applies per-arm weights", () => {
    const fused = rrf([arm("strong", ["b"], 10), arm("weak", ["a"], 1)]);
    expect(fused.map((f) => f.id)).toEqual(["b", "a"]);
  });

  it("is deterministic across permutations of equally-scored input", () => {
    // Three arms, each contributing one distinct id at rank 1: all scores equal.
    const forward = rrf([arm("a", ["z"]), arm("b", ["y"]), arm("c", ["x"])]);
    // Ties resolve by first-contributing-arm order, so declaration order decides.
    expect(forward.map((f) => f.id)).toEqual(["z", "y", "x"]);

    const reordered = rrf([arm("c", ["x"]), arm("b", ["y"]), arm("a", ["z"])]);
    expect(reordered.map((f) => f.id)).toEqual(["x", "y", "z"]);

    // Repeated calls on identical input never differ.
    expect(rrf([arm("a", ["z"]), arm("b", ["y"])])).toEqual(
      rrf([arm("a", ["z"]), arm("b", ["y"])]),
    );
  });

  it("breaks ties within one arm position by id, totally and stably", () => {
    const fused = rrf([arm("a", ["m"]), arm("a2", ["n"])]);
    expect(fused.map((f) => f.id)).toEqual(["m", "n"]);
  });

  it("counts a duplicate id within one arm only once", () => {
    const withDuplicate = rrf([
      { name: "sloppy", hits: [hit("a"), hit("a"), hit("b")] },
    ]);
    expect(withDuplicate.map((f) => f.id)).toEqual(["a", "b"]);
    expect(withDuplicate[0]!.score).toBeCloseTo(1 / (DEFAULT_K + 1), 12);
    // 'b' is at position 3, so it keeps rank 3 — deduping must not renumber ranks.
    expect(withDuplicate[1]!.score).toBeCloseTo(1 / (DEFAULT_K + 3), 12);
  });

  it("degrades gracefully when an arm is unavailable", () => {
    // The vector arm returning nothing (no embeddings yet, model mismatch) must
    // not error — results narrow, they do not disappear.
    const fused = rrf([arm("lexical", ["a", "b"]), arm("semantic", [])]);
    expect(fused.map((f) => f.id)).toEqual(["a", "b"]);
  });

  it("returns nothing for no arms and for empty arms", () => {
    expect(rrf([])).toEqual([]);
    expect(rrf([arm("empty", [])])).toEqual([]);
  });

  it("records per-arm contributions for explain output", () => {
    const [top] = rrf([arm("lexical", ["a"]), arm("semantic", ["a"])]);
    expect(top!.contributions).toHaveLength(2);
    expect(top!.contributions.map((c) => c.arm)).toEqual([
      "lexical",
      "semantic",
    ]);
    expect(top!.contributions.every((c) => c.rank === 1)).toBe(true);
    const summed = top!.contributions.reduce((total, c) => total + c.score, 0);
    expect(summed).toBeCloseTo(top!.score, 12);
  });

  it("truncates each arm independently with perArmLimit", () => {
    const fused = rrf([arm("a", ["1", "2", "3"]), arm("b", ["4", "5", "6"])], {
      perArmLimit: 1,
    });
    expect(fused.map((f) => f.id).sort()).toEqual(["1", "4"]);
  });

  it("rejects a non-positive k rather than producing a division artefact", () => {
    expect(() => rrf([arm("a", ["x"])], { k: 0 })).toThrow(RangeError);
    expect(() => rrf([arm("a", ["x"])], { k: -1 })).toThrow(RangeError);
  });
});

describe("applyDiversityCap", () => {
  const fusedOf = (...hits: ArmHit[]) => rrf([{ name: "single", hits }]);

  it("stops one source from filling the page", () => {
    const fused = fusedOf(
      hit("j1", "jira"),
      hit("j2", "jira"),
      hit("j3", "jira"),
      hit("c1", "confluence"),
    );
    const capped = applyDiversityCap(fused, { maxPerSource: 2 });
    expect(capped.slice(0, 3).map((f) => f.id)).toEqual(["j1", "j2", "c1"]);
  });

  it("demotes rather than discards, so a dominated result set still fills", () => {
    const fused = fusedOf(
      hit("j1", "jira"),
      hit("j2", "jira"),
      hit("j3", "jira"),
    );
    const capped = applyDiversityCap(fused, { maxPerSource: 1 });
    expect(capped.map((f) => f.id)).toEqual(["j1", "j2", "j3"]);
  });

  it("caps per container independently of source", () => {
    const fused = fusedOf(
      hit("a", "confluence", "ARCH"),
      hit("b", "confluence", "ARCH"),
      hit("c", "confluence", "PLATFORM"),
    );
    const capped = applyDiversityCap(fused, { maxPerContainer: 1 });
    expect(capped.slice(0, 2).map((f) => f.id)).toEqual(["a", "c"]);
  });

  it("leaves hits with no source or container uncapped", () => {
    const fused = fusedOf(hit("a"), hit("b"), hit("c"));
    expect(
      applyDiversityCap(fused, { maxPerSource: 1 }).map((f) => f.id),
    ).toEqual(["a", "b", "c"]);
  });

  it("preserves fused order when no cap applies", () => {
    const fused = fusedOf(hit("a", "confluence"), hit("b", "jira"));
    expect(applyDiversityCap(fused, {}).map((f) => f.id)).toEqual(["a", "b"]);
  });

  it("applies the final limit after demotion", () => {
    const fused = fusedOf(
      hit("j1", "jira"),
      hit("j2", "jira"),
      hit("c1", "confluence"),
    );
    const capped = applyDiversityCap(fused, { maxPerSource: 1, limit: 2 });
    expect(capped.map((f) => f.id)).toEqual(["j1", "c1"]);
  });
});
