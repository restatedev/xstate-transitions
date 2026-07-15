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

import type { StandardSchema, StandardSchemaIssue } from "./types";

export type ContractParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly kind: "invalid" | "async";
      readonly message: string;
    };

/** Run a Standard Schema contract without coupling validation to Restate. */
export function parseContract<T>(
  schema: StandardSchema<T>,
  value: unknown,
): ContractParseResult<T> {
  const result = schema["~standard"].validate(value);
  if (isPromiseLike(result)) {
    return {
      ok: false,
      kind: "async",
      message: "Async Standard Schema validation is not supported.",
    };
  }
  if (result.issues !== undefined) {
    return {
      ok: false,
      kind: "invalid",
      message: `Standard schema validation failed:\n${result.issues
        .map(formatSchemaIssue)
        .join("\n")}`,
    };
  }
  return { ok: true, value: result.value };
}

/** Explain why a value cannot enter the public machine-event boundary. */
export function publicEventProblem(event: unknown): string | undefined {
  if (
    typeof event !== "object" ||
    event === null ||
    !("type" in event) ||
    typeof event.type !== "string" ||
    event.type.length === 0
  ) {
    return "A machine event must be an object with a non-empty string 'type'.";
  }
  if (event.type.startsWith("xstate.")) {
    return "Event types beginning with 'xstate.' are reserved for internal delivery.";
  }
  return undefined;
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

function formatSchemaIssue(issue: StandardSchemaIssue): string {
  if (!issue.path || issue.path.length === 0) return `* ${issue.message}`;
  const path = issue.path
    .map((part) =>
      typeof part === "object" && part !== null && "key" in part
        ? String(part.key)
        : String(part),
    )
    .join("/");
  return `* (at /${path}) ${issue.message}`;
}
