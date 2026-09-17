import { describe, expect, it } from "vitest";
import type { RunResult } from "../api";
import {
  CUSTOM_PRESET,
  LAYER_PRESETS,
  layerLabel,
  presetIdFor,
  yPlusRows,
  yPlusText,
} from "./layers";

const result = (over: Partial<RunResult>): RunResult =>
  ({
    cd: 0.3,
    cl: 0,
    cs: 0,
    drag_N: 1,
    lift_N: 0,
    side_N: 0,
    frontal_area_m2: 0.1,
    wind_speed: 15,
    rho: 1.225,
    iterations: 500,
    mesh_cells: 1e6,
    runtime_s: 100,
    cd_std_last20pct: 0.001,
    drag_pressure_N: null,
    drag_viscous_N: null,
    stopped_early: false,
    ...over,
  }) as RunResult;

describe("presetIdFor", () => {
  it("treats no config as the standard preset", () => {
    expect(presetIdFor(undefined)).toBe("standard");
    expect(presetIdFor({})).toBe("standard");
  });

  it("round-trips every preset", () => {
    for (const p of LAYER_PRESETS) {
      expect(presetIdFor(p.settings ?? {})).toBe(p.id);
    }
  });

  it("ignores the ground flag, which is its own checkbox", () => {
    expect(presetIdFor({ ground: true })).toBe("standard");
    expect(presetIdFor({ count: 6, expansion: 1.2, final_thickness: 0.4, ground: true }))
      .toBe("fine");
  });

  it("treats an explicit default as the default", () => {
    expect(presetIdFor({ count: 3, expansion: 1.2, final_thickness: 0.3 })).toBe(
      "standard",
    );
  });

  it("falls back to custom for anything else", () => {
    expect(presetIdFor({ count: 5 })).toBe(CUSTOM_PRESET);
    expect(presetIdFor({ count: 6, expansion: 1.9 })).toBe(CUSTOM_PRESET);
  });
});

describe("layerLabel", () => {
  it("describes the default stack", () => {
    expect(layerLabel(undefined)).toBe("3 layers, ratio 1.2");
  });

  it("says plainly when layers are off", () => {
    expect(layerLabel({ count: 0 })).toBe("no boundary layers");
  });

  it("notes floor layers", () => {
    expect(layerLabel({ count: 6, ground: true })).toBe("6 layers, ratio 1.2 + floor");
  });

  it("uses the singular for one layer", () => {
    expect(layerLabel({ count: 1 })).toBe("1 layer, ratio 1.2");
  });
});

describe("yPlusText", () => {
  it("is null when the run has no y+ (solved before the feature)", () => {
    expect(yPlusText(result({}))).toBeNull();
    expect(yPlusText(result({ y_plus: null }))).toBeNull();
  });

  it("confirms an in-band y+", () => {
    const t = yPlusText(
      result({
        y_plus: { model: { min: 20, max: 180, average: 60 } },
        y_plus_verdict: "ok",
      }),
    );
    expect(t).toContain("60");
    expect(t).toContain("valid");
  });

  it("explains a low y+ and says which way to move", () => {
    const t = yPlusText(
      result({
        y_plus: { model: { min: 0.5, max: 172, average: 13.2 } },
        y_plus_verdict: "low",
      }),
    );
    expect(t).toContain("13.2");
    expect(t).toContain("viscous sublayer");
    expect(t).toContain("raise it");
  });

  it("explains a high y+", () => {
    const t = yPlusText(
      result({
        y_plus: { model: { min: 120, max: 4100, average: 2980 } },
        y_plus_verdict: "high",
      }),
    );
    expect(t).toContain("2980");
    expect(t).toContain("Add layers");
  });
});

describe("yPlusRows", () => {
  it("is empty without data", () => {
    expect(yPlusRows(result({}))).toEqual([]);
  });

  it("puts the model patch first", () => {
    const rows = yPlusRows(
      result({
        y_plus: {
          ground: { min: 1, max: 2, average: 1.5 },
          model: { min: 3, max: 4, average: 3.5 },
        },
      }),
    );
    expect(rows.map((r) => r.patch)).toEqual(["model", "ground"]);
    expect(rows[0].average).toBe(3.5);
  });
});
