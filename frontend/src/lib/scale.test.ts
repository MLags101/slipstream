import { describe, expect, it } from "vitest";
import { formatTick, linearTicks, logTicks } from "./scale";

describe("linearTicks", () => {
  it("produces exact ticks with no floating-point drift", () => {
    // The mesh sweep chart: cells in millions, 0.256 -> 0.619.
    const t = linearTicks(0.256439, 0.619349, 5);
    expect(t.ticks).toEqual([0.2, 0.3, 0.4, 0.5, 0.6, 0.7]);
    expect(t.decimals).toBe(1);
    expect(t.ticks.map((v) => formatTick(v, t.decimals))).toEqual([
      "0.2", "0.3", "0.4", "0.5", "0.6", "0.7",
    ]);
  });

  it("labels a narrow range distinctly", () => {
    // Cd 1.1588 -> 1.1652 used to print "1.16" four times.
    const t = linearTicks(1.1588, 1.1652, 4);
    const labels = t.ticks.map((v) => formatTick(v, t.decimals));
    expect(new Set(labels).size).toBe(labels.length);
    expect(t.decimals).toBe(3);
    expect(labels[0]).toBe("1.158");
  });

  it("covers the range and keeps integer steps integral", () => {
    const t = linearTicks(0, 500, 5);
    expect(t.ticks[0]).toBeLessThanOrEqual(0);
    expect(t.ticks[t.ticks.length - 1]).toBeGreaterThanOrEqual(500);
    expect(t.decimals).toBe(0);
    expect(t.ticks.every(Number.isInteger)).toBe(true);
  });

  it("handles a degenerate or invalid range", () => {
    const flat = linearTicks(2, 2, 5);
    expect(flat.ticks.length).toBeGreaterThan(1);
    expect(linearTicks(NaN, 1)).toEqual({ ticks: [0, 1], min: 0, max: 1, decimals: 0 });
  });

  it("never emits negative zero", () => {
    const t = linearTicks(-0.3, 0.3, 6);
    expect(t.ticks.some((v) => Object.is(v, -0))).toBe(false);
    expect(t.ticks).toContain(0);
  });
});

describe("formatTick", () => {
  it("keeps large values compact", () => {
    expect(formatTick(25000, 0)).toBe("25.0k");
    expect(formatTick(250, 0)).toBe("250");
  });
});

describe("logTicks", () => {
  it("still reports decade ticks", () => {
    expect(logTicks(0.002, 3)).toMatchObject({ ticks: [0.001, 0.01, 0.1, 1, 10], decimals: 0 });
  });
});
