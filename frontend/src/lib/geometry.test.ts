import { describe, expect, it } from "vitest";
import {
  toMeshArrays,
  boundsOf,
  UNIT_TO_METERS,
  defaultPropPlacements,
} from "./geometry";

describe("geometry", () => {
  it("converts flat arrays and picks Uint16 for small meshes", () => {
    const m = toMeshArrays([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]);
    expect(m.vertexCount).toBe(3);
    expect(m.positions).toBeInstanceOf(Float32Array);
    expect(m.indices).toBeInstanceOf(Uint16Array);
    expect(Array.from(m.indices)).toEqual([0, 1, 2]);
  });

  it("picks Uint32 indices above 65535 vertices", () => {
    const n = 65536;
    const positions = new Array(n * 3).fill(0);
    const m = toMeshArrays(positions, [0, 1, n - 1]);
    expect(m.indices).toBeInstanceOf(Uint32Array);
  });

  it("rejects malformed arrays", () => {
    expect(() => toMeshArrays([0, 0], [0, 1, 2])).toThrow(/positions/);
    expect(() => toMeshArrays([0, 0, 0], [0, 1])).toThrow(/indices/);
    expect(() => toMeshArrays([0, 0, 0], [0, 1, 5])).toThrow(/out of range/);
  });

  it("computes bounds, center, and framing radius", () => {
    const b = boundsOf([-1, -2, -3, 1, 2, 3]);
    expect(b.min).toEqual([-1, -2, -3]);
    expect(b.max).toEqual([1, 2, 3]);
    expect(b.center).toEqual([0, 0, 0]);
    expect(b.size).toEqual([2, 4, 6]);
    expect(b.radius).toBeCloseTo(Math.hypot(2, 4, 6) / 2);
  });

  it("places four rotors on the bbox corners, on the top face", () => {
    // 200 x 100 x 40 model centred at the origin.
    const p = defaultPropPlacements([0, 0, 0], [200, 100, 40], 4);
    expect(p).toHaveLength(4);
    for (const r of p) {
      expect(Math.abs(r.x)).toBeCloseTo(85); // 0.85 * 100
      expect(Math.abs(r.y)).toBeCloseTo(42.5); // 0.85 * 50
      expect(r.z).toBeCloseTo(20); // top face
    }
    // all four quadrants, no two rotors stacked
    const quadrants = new Set(p.map((r) => `${Math.sign(r.x)}${Math.sign(r.y)}`));
    expect(quadrants.size).toBe(4);
  });

  it("respects a model that is not centred on the origin", () => {
    const p = defaultPropPlacements([75, 10, 5], [200, 100, 40], 4);
    expect(p.map((r) => r.x).sort((a, b) => a - b)[0]).toBeCloseTo(-10); // 75 - 85
    expect(p.every((r) => r.z === 25)).toBe(true);
  });

  it("sizes rotors so neighbours do not overlap", () => {
    const p = defaultPropPlacements([0, 0, 0], [200, 200, 40], 4);
    const spacing = Math.abs(p[0].x - p[1].x) || Math.abs(p[0].y - p[1].y);
    expect(p[0].d).toBeLessThan(spacing);
    expect(p[0].d).toBeGreaterThan(0);
  });

  it("spreads six rotors around the perimeter without duplicates", () => {
    const p = defaultPropPlacements([0, 0, 0], [200, 200, 40], 6);
    expect(p).toHaveLength(6);
    const keys = new Set(p.map((r) => `${r.x},${r.y}`));
    expect(keys.size).toBe(6);
  });

  it("unit factors match the contract's declared units", () => {
    expect(UNIT_TO_METERS.mm).toBe(0.001);
    expect(UNIT_TO_METERS.cm).toBe(0.01);
    expect(UNIT_TO_METERS.m).toBe(1);
    expect(UNIT_TO_METERS.in).toBe(0.0254);
  });
});
