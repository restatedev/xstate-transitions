import { describe, it, expect } from "vitest";
import {
  evaluateCondition,
  isValidCondition,
} from "../../src/xstate/conditions";
import type { ReturnedSnapshot } from "../../src/xstate/snapshot";

const snap = (over: Partial<ReturnedSnapshot>): ReturnedSnapshot => ({
  value: "x",
  context: {},
  status: "active",
  tags: [],
  ...over,
});

describe("isValidCondition", () => {
  it("accepts done and hasTag:*", () => {
    expect(isValidCondition("done")).toBe(true);
    expect(isValidCondition("hasTag:ready")).toBe(true);
  });
  it("rejects anything else", () => {
    expect(isValidCondition("bogus")).toBe(false);
    expect(isValidCondition("hasTags:x")).toBe(false);
    expect(isValidCondition("")).toBe(false);
  });
});

describe("evaluateCondition", () => {
  it("is pending while active with no matching tag", () => {
    expect(evaluateCondition(snap({}), "done")).toEqual({ status: "pending" });
    expect(evaluateCondition(snap({ tags: ["a"] }), "hasTag:b")).toEqual({
      status: "pending",
    });
  });

  it("resolves 'done' when the snapshot is done", () => {
    const s = snap({ status: "done", output: { ok: 1 } });
    expect(evaluateCondition(s, "done")).toEqual({
      status: "resolve",
      snapshot: s,
    });
  });

  it("resolves 'hasTag:x' when the tag is present", () => {
    const s = snap({ tags: ["x", "y"] });
    expect(evaluateCondition(s, "hasTag:x")).toEqual({
      status: "resolve",
      snapshot: s,
    });
  });

  it("rejects when the machine completes without meeting a tag condition", () => {
    const s = snap({ status: "done", tags: [] });
    expect(evaluateCondition(s, "hasTag:x")).toEqual({
      status: "reject",
      reason: "State machine completed without the condition being met",
    });
  });

  it("rejects on an error snapshot regardless of condition", () => {
    const s = snap({ status: "error" });
    expect(evaluateCondition(s, "done").status).toBe("reject");
    expect(evaluateCondition(s, "hasTag:x").status).toBe("reject");
  });

  it("prefers a matched tag even on a final state", () => {
    const s = snap({ status: "done", tags: ["End"] });
    expect(evaluateCondition(s, "hasTag:End")).toEqual({
      status: "resolve",
      snapshot: s,
    });
  });
});
