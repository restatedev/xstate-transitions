import type { ObjectSharedContext } from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk";
import type { AnyActorLogic, AnyStateMachine } from "xstate";
import { createActor, toPromise } from "xstate";
import type { NormalizedError } from "../xstate/actors";
import { normalizeError, resolveReferencedActor } from "../xstate/actors";
import type { SpawnParams } from "../xstate/types";
import type { RestateActor } from "./promise";
import { isRestateActor } from "./promise";

/** Result of running actor logic, before translating it to XState's protocol. */
export type ActorOutcome =
  | { readonly status: "done"; readonly output?: unknown }
  | { readonly status: "error"; readonly error: NormalizedError };

type FailFastActor = Extract<RestateActor, { kind: "promise" }>;
type RetryableActor = Extract<RestateActor, { kind: "retryable" }>;
type HandlerActor = Extract<RestateActor, { kind: "handler" }>;

/**
 * Resolve an invoked/spawned actor and dispatch to the runner for its kind. Each
 * runner is self-contained; this function only picks one. The exclusive
 * actorDone/actorError handlers translate the outcome to XState's protocol.
 */
export async function runActor(
  machine: AnyStateMachine,
  params: SpawnParams,
  ctx: ObjectSharedContext,
): Promise<ActorOutcome> {
  const logic =
    typeof params.src === "string"
      ? resolveReferencedActor(machine, params.src)
      : params.src;

  if (!isRestateActor(logic)) {
    return runVanillaActor(logic, params);
  }
  switch (logic.kind) {
    case "promise":
      return runFailFastActor(logic, params, ctx);
    case "retryable":
      return runRetryableActor(logic, params, ctx);
    case "handler":
      return runHandlerActor(logic, params, ctx);
    default:
      return assertNever(logic);
  }
}

/**
 * Basic `fromPromise`: the ctx-less creator runs once inside `ctx.run` for
 * exactly-once durability. Any rejection is made terminal so `ctx.run` never
 * retries an application error — it routes straight to `onError`. (A genuine
 * infrastructure crash is still retried by Restate, since it is not an error
 * thrown by the body.)
 */
async function runFailFastActor(
  logic: FailFastActor,
  params: SpawnParams,
  ctx: ObjectSharedContext,
): Promise<ActorOutcome> {
  try {
    const output = await ctx.run(`actor:${params.id}`, async () => {
      try {
        return await logic.config({ input: params.input });
      } catch (err) {
        throw asTerminalError(err);
      }
    });
    return { status: "done", output };
  } catch (err) {
    if (err instanceof restate.TerminalError) {
      return { status: "error", error: normalizeError(err) };
    }
    throw err;
  }
}

/**
 * Retryable `fromPromise`: the ctx-less creator runs inside `ctx.run` with a
 * retry policy. A transient rejection is retried by Restate; a `TerminalError`
 * bypasses retries, and exhausting the policy fails terminally. Either way
 * `ctx.run` surfaces only a `TerminalError`, which routes to `onError`.
 */
async function runRetryableActor(
  logic: RetryableActor,
  params: SpawnParams,
  ctx: ObjectSharedContext,
): Promise<ActorOutcome> {
  try {
    const output = await ctx.run(
      `actor:${params.id}`,
      () => logic.config({ input: params.input }),
      logic.retry,
    );
    return { status: "done", output };
  } catch (err) {
    if (err instanceof restate.TerminalError) {
      return { status: "error", error: normalizeError(err) };
    }
    throw err;
  }
}

/**
 * `fromHandler`: the creator receives the Restate ctx and journals its own
 * effects, so it runs directly (wrapping it in `ctx.run` would be illegal nested
 * journaling). A `TerminalError` routes to `onError`; anything else propagates so
 * Restate retries the whole invocation under its default policy.
 */
async function runHandlerActor(
  logic: HandlerActor,
  params: SpawnParams,
  ctx: ObjectSharedContext,
): Promise<ActorOutcome> {
  try {
    const output = await logic.config({ input: params.input, ctx });
    return { status: "done", output };
  } catch (err) {
    if (err instanceof restate.TerminalError) {
      return { status: "error", error: normalizeError(err) };
    }
    throw err;
  }
}

/**
 * Vanilla xstate actor logic (child promise actors, fromTransition, etc.). Runs
 * once via createActor+toPromise; any error becomes an actor error routed to
 * `onError`.
 */
async function runVanillaActor(
  logic: unknown,
  params: SpawnParams,
): Promise<ActorOutcome> {
  try {
    const actor = createActor(logic as AnyActorLogic, {
      id: params.id,
      input: params.input,
    });
    const output = await toPromise(actor.start());
    return { status: "done", output };
  } catch (err) {
    return { status: "error", error: normalizeError(err) };
  }
}

function asTerminalError(err: unknown): restate.TerminalError {
  return err instanceof restate.TerminalError
    ? err
    : new restate.TerminalError(err instanceof Error ? err.message : String(err));
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Restate actor kind: ${JSON.stringify(value)}`);
}
