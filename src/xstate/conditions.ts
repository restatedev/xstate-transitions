import type { Condition, ConditionOutcome, ReturnedSnapshot } from "./types";

const HAS_TAG = "hasTag:";

export function isValidCondition(condition: string): condition is Condition {
  return condition === "done" || condition.startsWith(HAS_TAG);
}

/**
 * Decide whether a wait condition is met by a settled snapshot. Pure: returns
 * the decision (resolve/reject/pending); the caller performs any side effect
 * (e.g. resolving a Restate awakeable).
 */
export function evaluateCondition(
  snapshot: ReturnedSnapshot,
  condition: string,
): ConditionOutcome {
  if (snapshot.status === "error") {
    return { status: "reject", reason: "State machine returned an error" };
  }

  if (
    condition.startsWith(HAS_TAG) &&
    snapshot.tags.includes(condition.slice(HAS_TAG.length))
  ) {
    return { status: "resolve", snapshot };
  }

  if (snapshot.status === "done") {
    return condition === "done"
      ? { status: "resolve", snapshot }
      : {
          status: "reject",
          reason: "State machine completed without the condition being met",
        };
  }

  return { status: "pending" };
}
