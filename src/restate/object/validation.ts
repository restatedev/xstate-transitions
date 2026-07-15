import * as restate from "@restatedev/restate-sdk";
import type { AnyEventObject } from "xstate";
import { isValidCondition } from "../../xstate/conditions";
import { parseContract, publicEventProblem } from "../contracts";
import type { StandardSchema } from "../types";

/** Parse a public event contract and reject reserved XState lifecycle events. */
export function parsePublicEvent<E extends AnyEventObject>(
  schema: StandardSchema<E> | undefined,
  event: E,
): E {
  const result = schema
    ? parseContract(schema, event)
    : { ok: true as const, value: event };
  if (!result.ok) {
    throw new restate.TerminalError(result.message, {
      errorCode: result.kind === "invalid" ? 400 : 500,
    });
  }

  validatePublicEvent(result.value);
  return result.value;
}

/** Reject malformed or reserved events arriving through the public handler. */
export function validatePublicEvent(
  event: unknown,
): asserts event is AnyEventObject {
  const problem = publicEventProblem(event);
  if (problem !== undefined) {
    throw new restate.TerminalError(problem, { errorCode: 400 });
  }
}

/** Reject (400) an unsupported wait condition. */
export function validateCondition(condition: string): void {
  if (!isValidCondition(condition)) {
    throw new restate.TerminalError("Invalid subscription condition", {
      errorCode: 400,
    });
  }
}

export function validateFinalStateTTL(value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError("finalStateTTL must be a finite, non-negative number");
  }
}
