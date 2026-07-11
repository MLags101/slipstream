import { describe, expect, it } from "vitest";
import { toMeshArrays, boundsOf, UNIT_TO_METERS } from "./geometry";

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

  it("unit factors match the contract's declared units", () => {
    expect(UNIT_TO_METERS.mm).toBe(0.001);
    expect(UNIT_TO_METERS.cm).toBe(0.01);
    expect(UNIT_TO_METERS.m).toBe(1);
    expect(UNIT_TO_METERS.in).toBe(0.0254);
  });
});
