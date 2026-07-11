import { describe, expect, it } from "vitest";
import {
  viridis,
  divergingBWR,
  linearNorm,
  symmetricNorm,
  fieldToVertexColors,
  sampleStops,
  type RGB,
} from "./colormaps";

describe("colormaps", () => {
  it("viridis endpoints are dark purple and bright yellow", () => {
    const [r0, g0, b0] = viridis(0);
    expect(r0).toBeCloseTo(0x44 / 255, 2);
    expect(g0).toBeCloseTo(0x01 / 255, 2);
    expect(b0).toBeCloseTo(0x54 / 255, 2);
    const [r1, g1, b1] = viridis(1);
    expect(r1).toBeCloseTo(0xfd / 255, 2);
    expect(g1).toBeCloseTo(0xe7 / 255, 2);
    expect(b1).toBeCloseTo(0x25 / 255, 2);
  });

  it("clamps out-of-range and non-finite t", () => {
    expect(viridis(-5)).toEqual(viridis(0));
    expect(viridis(5)).toEqual(viridis(1));
    expect(viridis(NaN)).toEqual(viridis(0));
  });

  it("diverging midpoint is near-neutral", () => {
    const [r, g, b] = divergingBWR(0.5);
    expect(Math.abs(r - g)).toBeLessThan(0.05);
    expect(Math.abs(g - b)).toBeLessThan(0.05);
    expect(r).toBeGreaterThan(0.8); // light neutral
  });

  it("sampleStops interpolates linearly between two stops", () => {
    const stops: RGB[] = [
      [0, 0, 0],
      [1, 1, 1],
    ];
    expect(sampleStops(stops, 0.25)).toEqual([0.25, 0.25, 0.25]);
  });

  it("linearNorm maps [min,max] to [0,1] and clamps", () => {
    const n = linearNorm(10, 20);
    expect(n(10)).toBe(0);
    expect(n(20)).toBe(1);
    expect(n(15)).toBeCloseTo(0.5);
    expect(n(0)).toBe(0);
    expect(n(99)).toBe(1);
  });

  it("linearNorm degenerate range returns midpoint", () => {
    expect(linearNorm(5, 5)(5)).toBe(0.5);
  });

  it("symmetricNorm always centers 0 at t=0.5", () => {
    const n = symmetricNorm(-2, 6); // asymmetric range
    expect(n(0)).toBe(0.5);
    expect(n(6)).toBe(1);
    expect(n(-6)).toBe(0); // symmetric arm from max magnitude
    expect(n(-2)).toBeCloseTo(0.5 - 2 / 12);
  });

  it("fieldToVertexColors packs one RGB triple per value", () => {
    const colors = fieldToVertexColors([0, 1], viridis, linearNorm(0, 1));
    expect(colors.length).toBe(6);
    expect(colors[0]).toBeCloseTo(viridis(0)[0], 5);
    expect(colors[3]).toBeCloseTo(viridis(1)[0], 5);
  });
});
