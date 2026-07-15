import type { ResumeInput } from "../../xstate/types";
import type { ChildRecord } from "../types";

export type KnownActors = Pick<
  ResumeInput,
  "knownChildIds" | "knownPromiseIds"
>;

/** Classify persisted actor records for XState snapshot restoration. */
export function classifyKnownActors(
  children: Readonly<Record<string, ChildRecord>>,
  actorExecutions: Readonly<Record<string, string>>,
): KnownActors {
  const knownChildIds = Object.keys(children);
  const knownPromiseIds = Object.keys(actorExecutions).filter(
    (actorId) => !Object.hasOwn(children, actorId),
  );

  return { knownChildIds, knownPromiseIds };
}
