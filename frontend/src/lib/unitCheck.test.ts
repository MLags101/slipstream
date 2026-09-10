import { describe, expect, it } from "vitest";
import { formatLength, unitHint } from "./unitCheck";

describe("unitHint", () => {
  it("flags a meters-exported frame read as mm and suggests m", () => {
    const h = unitHint([0.2475, 0.2815, 0.0425], "mm");
    expect(h).not.toBeNull();
    expect(h!.sizeM).toBeCloseTo(0.0002815, 7);
    expect(h!.suggest).toBe("m");
  });

  it("stays quiet for plausible sizes", () => {
    expect(unitHint([171, 211, 42], "mm")).toBeNull();
    expect(unitHint([4.5, 1.8, 1.4], "m")).toBeNull();
    expect(unitHint([6, 3, 1], "in")).toBeNull();
  });

  it("flags a mm model read as meters and suggests mm", () => {
    const h = unitHint([450, 200, 120], "m");
    expect(h!.suggest).toBe("mm");
  });

  it("ignores degenerate input", () => {
    expect(unitHint([0, 0, 0], "mm")).toBeNull();
    expect(unitHint([1, 1, 1], "furlong")).toBeNull();
  });
});

describe("formatLength", () => {
  it("picks a readable unit", () => {
    expect(formatLength(0.00028)).toBe("0.28 mm");
    expect(formatLength(0.042)).toBe("4.2 cm");
    expect(formatLength(450)).toBe("450 m");
  });
});
