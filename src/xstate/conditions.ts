import type { ReturnedSnapshot } from "./snapshot";

/** A condition that `waitFor`/`subscribe` can wait on. */
export type Condition = "done" | `hasTag:${string}`;

/** The pure outcome of evaluating a condition against a settled snapshot. */
export type ConditionOutcome =
  | { status: "pending" }
  | { status: "resolve"; snapshot: ReturnedSnapshot }
  | { status: "reject"; reason: string };

export function isValidCondition(condition: string): condition is Condition {
  return condition === "done" || condition.startsWith("hasTag:");
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
    condition.startsWith("hasTag:") &&
    snapshot.tags.includes(condition.slice("hasTag:".length))
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
