/*
 * Copyright (c) 2025-2026 - Restate Software, Inc., Restate GmbH
 *
 * This file is part of the Restate SDK for Node.js/TypeScript,
 * which is released under the MIT license.
 *
 * You can find a copy of the license in file LICENSE in the root
 * directory of this repository or package, or at
 * https://github.com/restatedev/sdk-typescript/blob/main/LICENSE
 */

import { describe, expect, it } from "vitest";
import {
  evaluateCondition,
  isValidCondition,
} from "../../src/xstate/conditions";
import type { ReturnedSnapshot } from "../../src/xstate/types";

const snap = (over: Partial<ReturnedSnapshot>): ReturnedSnapshot => ({
  value: "x",
  context: {},
  status: "active",
  tags: [],
  ...over,
});

describe("isValidCondition", () => {
  it("accepts done and RFC 6901 paths", () => {
    expect(isValidCondition("done")).toBe(true);
    expect(isValidCondition("/ready")).toBe(true);
    expect(isValidCondition("/nested/value")).toBe(true);
    expect(isValidCondition("/a~1b/m~0n")).toBe(true);
    expect(isValidCondition("/")).toBe(true);
  });

  it("rejects unsupported and incorrectly escaped conditions", () => {
    expect(isValidCondition("")).toBe(false);
    expect(isValidCondition(undefined)).toBe(false);
    expect(isValidCondition(42)).toBe(false);
    expect(isValidCondition("ready")).toBe(false);
    expect(isValidCondition("hasTag:ready")).toBe(false);
    expect(isValidCondition("/bad~2escape")).toBe(false);
    expect(isValidCondition("/trailing~")).toBe(false);
  });
});

describe("evaluateCondition", () => {
  it("keeps done pending while the machine is active", () => {
    expect(evaluateCondition(snap({}), "done")).toEqual({
      status: "pending",
    });
  });

  it("resolves done when the snapshot is done", () => {
    const s = snap({ status: "done", output: { ok: true } });
    expect(evaluateCondition(s, "done")).toEqual({
      status: "resolve",
      snapshot: s,
    });
  });

  it("uses context paths rather than XState tags", () => {
    expect(
      evaluateCondition(snap({ context: {}, tags: ["ready"] }), "/ready"),
    ).toEqual({ status: "pending" });
  });

  it.each([
    ["false", false],
    ["zero", 0],
    ["empty string", ""],
    ["null", null],
  ])("treats an existing %s value as resolved", (_label, value) => {
    const s = snap({ context: { result: value } });
    expect(evaluateCondition(s, "/result")).toEqual({
      status: "resolve",
      snapshot: s,
    });
  });

  it("resolves nested, escaped, and array paths", () => {
    const s = snap({
      context: {
        nested: { "a/b": { "m~n": [false] } },
      },
    });
    expect(evaluateCondition(s, "/nested/a~1b/m~0n/0")).toEqual({
      status: "resolve",
      snapshot: s,
    });
  });

  it("does not accept leading-zero or out-of-range array indices", () => {
    const s = snap({ context: { values: ["present"] } });
    expect(evaluateCondition(s, "/values/01")).toEqual({
      status: "pending",
    });
    expect(evaluateCondition(s, "/values/1")).toEqual({
      status: "pending",
    });
    expect(evaluateCondition(s, "/values/-")).toEqual({
      status: "pending",
    });
  });

  it("rejects when the machine completes before a marker exists", () => {
    const s = snap({ status: "done", context: {} });
    expect(evaluateCondition(s, "/result")).toEqual({
      status: "reject",
      reason: "State machine completed without the condition being met",
    });
  });

  it("rejects error snapshots for unresolved conditions", () => {
    const s = snap({ status: "error", context: {} });
    expect(evaluateCondition(s, "done")).toEqual({
      status: "reject",
      reason: "State machine returned an error",
    });
    expect(evaluateCondition(s, "/result")).toEqual({
      status: "reject",
      reason: "State machine returned an error",
    });
  });

  it("prefers an existing path even on a terminal snapshot", () => {
    const s = snap({ status: "done", context: { result: null } });
    expect(evaluateCondition(s, "/result")).toEqual({
      status: "resolve",
      snapshot: s,
    });
  });
});
