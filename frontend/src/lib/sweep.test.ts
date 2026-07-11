import { describe, expect, it } from "vitest";
import { commonRange, sweepPositions } from "./sweep";

describe("sweepPositions", () => {
  it("spans the bbox widened by ±20% of the extent", () => {
    const pos = sweepPositions(-1, 1, 12); // extent 2 -> ±0.4
    expect(pos).toHaveLength(12);
    expect(pos[0]).toBeCloseTo(-1.4);
    expect(pos[11]).toBeCloseTo(1.4);
  });

  it("is evenly spaced and monotonic", () => {
    const pos = sweepPositions(0, 0.1, 12);
    const step = pos[1] - pos[0];
    for (let i = 1; i < pos.length; i++) {
      expect(pos[i]).toBeGreaterThan(pos[i - 1]);
      expect(pos[i] - pos[i - 1]).toBeCloseTo(step, 10);
    }
  });

  it("handles an offset bbox", () => {
    const pos = sweepPositions(0.2, 0.7, 5); // extent 0.5 -> ±0.1
    expect(pos[0]).toBeCloseTo(0.1);
    expect(pos[4]).toBeCloseTo(0.8);
    expect(pos[2]).toBeCloseTo(0.45); // midpoint
  });

  it("degenerate extent yields identical positions", () => {
    const pos = sweepPositions(0.5, 0.5, 4);
    expect(pos).toHaveLength(4);
    for (const p of pos) expect(p).toBeCloseTo(0.5);
  });
});

describe("commonRange", () => {
  it("takes the union of frame ranges", () => {
    expect(
      commonRange([
        [2, 10],
        [0, 8],
        [3, 15],
      ]),
    ).toEqual([0, 15]);
  });

  it("single range passes through", () => {
    expect(commonRange([[1, 2]])).toEqual([1, 2]);
  });

  it("empty input falls back to [0, 1]", () => {
    expect(commonRange([])).toEqual([0, 1]);
  });
});
