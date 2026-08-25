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

import type { Condition, ConditionOutcome, ReturnedSnapshot } from "./types";

const SNAPSHOT_CONTEXT_PREFIX = "/context";
const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/;
const INVALID_ESCAPE = /~(?:[^01]|$)/;

/** Whether a value is a supported wait condition. */
export function isValidCondition(condition: unknown): condition is Condition {
  if (condition === "done") return true;
  if (typeof condition !== "string") return false;
  return condition.startsWith("/") && !INVALID_ESCAPE.test(condition);
}

/**
 * Decide whether a wait condition is met by a settled snapshot. `done` checks
 * the snapshot status; an RFC 6901 path checks existence in machine context.
 */
export function evaluateCondition(
  snapshot: ReturnedSnapshot,
  condition: Condition,
): ConditionOutcome {
  if (condition === "done") {
    if (snapshot.status === "done") {
      return { status: "resolve", snapshot };
    }
    if (snapshot.status === "error") {
      return { status: "reject", reason: "State machine returned an error" };
    }
    if (snapshot.status !== "active") {
      return {
        status: "reject",
        reason: "State machine stopped before completing",
      };
    }
    return { status: "pending" };
  }

  if (jsonPointerExists(snapshot, `${SNAPSHOT_CONTEXT_PREFIX}${condition}`)) {
    return { status: "resolve", snapshot };
  }

  if (snapshot.status === "error") {
    return { status: "reject", reason: "State machine returned an error" };
  }

  if (snapshot.status !== "active") {
    return {
      status: "reject",
      reason: "State machine completed without the condition being met",
    };
  }

  return { status: "pending" };
}

/** Return true only when every pointer token resolves to a concrete value. */
function jsonPointerExists(document: unknown, pointer: string): boolean {
  let current = document;

  for (const encodedToken of pointer.slice(1).split("/")) {
    const token = encodedToken.replaceAll("~1", "/").replaceAll("~0", "~");

    if (Array.isArray(current)) {
      if (!ARRAY_INDEX.test(token)) return false;
      const index = Number(token);
      if (!Number.isSafeInteger(index) || index >= current.length) return false;
      current = current[index];
      continue;
    }

    if (typeof current !== "object" || current === null) return false;
    if (!Object.hasOwn(current, token)) return false;
    current = (current as Record<string, unknown>)[token];
  }

  return true;
}
