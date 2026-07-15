import type { ObjectSharedContext } from "@restatedev/restate-sdk";
import { fromPromise as xstateFromPromise } from "xstate";
import { RESTATE_PROMISE_ACTOR } from "../xstate/actors";

/**
 * A Restate-aware promise-actor creator. Unlike vanilla xstate `fromPromise`,
 * the creator receives the Restate `ctx`, so it can use durable/deterministic
 * primitives (ctx.run for exactly-once side effects, ctx.date, ctx.rand).
 */
export type RestatePromiseCreator<TOutput, TInput> = (args: {
  input: TInput;
  ctx: ObjectSharedContext;
}) => TOutput | Promise<TOutput>;

/**
 * Create a Restate-aware promise actor. The returned value is real xstate
 * promise-actor logic (so `setup`/`invoke` accept it and the pure `transition()`
 * emits the usual spawnChild action), tagged with a sentinel and carrying the
 * real creator on `config`. The placeholder logic is never started in the inert
 * transition scope; the `_execute` handler detects the sentinel and runs
 * `config({ input, ctx })` out-of-band, inside a real Restate context.
 */
export function fromPromise<TOutput, TInput = unknown>(
  creator: RestatePromiseCreator<TOutput, TInput>,
) {
  const logic = xstateFromPromise<TOutput, TInput>(() =>
    Promise.reject(
      new Error(
        "A Restate promise actor must be run via the Restate _execute handler, not started directly",
      ),
    ),
  );

  return Object.assign(logic, {
    sentinel: RESTATE_PROMISE_ACTOR as typeof RESTATE_PROMISE_ACTOR,
    config: creator,
  });
}
