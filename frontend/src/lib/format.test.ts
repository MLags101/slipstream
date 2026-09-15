import { describe, expect, it } from "vitest";
import { shortRunId } from "./format";

describe("shortRunId", () => {
  it("keeps the random suffix of a run id", () => {
    expect(shortRunId("20260914-215705-ab50d5")).toBe("ab50d5");
  });

  it("falls back to the whole id when there is no dash", () => {
    expect(shortRunId("abc123")).toBe("abc123");
  });
});
