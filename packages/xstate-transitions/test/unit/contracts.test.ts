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
import type { StandardSchema } from "../../src";
import { parseContract, publicEventProblem } from "../../src/restate/contracts";

describe("runtime contracts", () => {
  it("returns transformed Standard Schema output", () => {
    const schema = standardSchema<number>((value) =>
      typeof value === "string"
        ? { value: Number(value) }
        : { issues: [{ message: "Expected a string" }] },
    );

    expect(parseContract(schema, "42")).toEqual({ ok: true, value: 42 });
  });

  it("formats validation issues with Standard Schema paths", () => {
    const schema = standardSchema<never>(() => ({
      issues: [
        {
          message: "Expected a number",
          path: ["items", { key: 2 }, "amount"],
        },
      ],
    }));

    expect(parseContract(schema, {})).toEqual({
      ok: false,
      kind: "invalid",
      message:
        "Standard schema validation failed:\n* (at /items/2/amount) Expected a number",
    });
  });

  it("reports asynchronous validation explicitly", () => {
    const schema = standardSchema<string>(async () => ({ value: "parsed" }));

    expect(parseContract(schema, "input")).toEqual({
      ok: false,
      kind: "async",
      message: "Async Standard Schema validation is not supported.",
    });
  });

  it.each([
    [undefined, "object with a non-empty string 'type'"],
    [{}, "object with a non-empty string 'type'"],
    [{ type: "" }, "object with a non-empty string 'type'"],
    [{ type: "xstate.done.actor.work" }, "reserved for internal delivery"],
    [{ type: "SUBMIT" }, undefined],
  ])("classifies public event %#", (event, expected) => {
    const problem = publicEventProblem(event);
    if (expected === undefined) {
      expect(problem).toBeUndefined();
    } else {
      expect(problem).toContain(expected);
    }
  });
});

function standardSchema<T>(
  validate: StandardSchema<T>["~standard"]["validate"],
): StandardSchema<T> {
  return {
    "~standard": { version: 1, vendor: "test", validate },
  };
}
