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

import type { ObjectSharedContext } from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk";
import type { AnyActorLogic, AnyStateMachine } from "xstate";
import { createActor, toPromise } from "xstate";
import type { NormalizedError } from "../xstate/actors";
import { normalizeError, resolveReferencedActor } from "../xstate/actors";
import type { SpawnParams } from "../xstate/types";
import type { RestateActor, RetryPolicy } from "./promise";
import { isRestateActor } from "./promise";

/** Result of running actor logic, before translating it to XState's protocol. */
export type ActorOutcome =
  | { readonly status: "done"; readonly output?: unknown }
  | { readonly status: "error"; readonly error: NormalizedError };

type PromiseActor = Extract<RestateActor, { kind: "promise" }>;
type HandlerActor = Extract<RestateActor, { kind: "handler" }>;

/**
 * Resolve an invoked/spawned actor and dispatch to the runner for its kind. The
 * exclusive actorDone/actorError handlers translate the outcome to XState's
 * protocol.
 *
 * Vanilla xstate logic and a `fromPromise` without a retry policy share the same
 * `runOnce` wrapper — they differ only in how their body is invoked (the xstate
 * actor lifecycle vs. calling our `config` directly).
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
    return runOnce(ctx, params, () => runVanilla(logic, params));
  }
  switch (logic.kind) {
    case "promise":
      return runPromise(ctx, params, logic);
    case "handler":
      return runHandler(ctx, params, logic);
    default:
      return assertNever(logic);
  }
}

/**
 * A ctx-less `fromPromise`. Without a retry policy it is fail-fast — its body
 * runs exactly once and any rejection routes to `onError`. With a retry policy
 * it runs under Restate's `ctx.run` retry instead.
 */
function runPromise(
  ctx: ObjectSharedContext,
  params: SpawnParams,
  logic: PromiseActor,
): Promise<ActorOutcome> {
  const body = () => logic.config({ input: params.input });
  return logic.retry === undefined
    ? runOnce(ctx, params, body)
    : runRetryable(ctx, params, body, logic.retry);
}

/**
 * Run a ctx-less actor `body` exactly once inside `ctx.run`, journaling its
 * outcome for replay-safety. A rejection is captured as the run's result rather
 * than rethrown, so `ctx.run` never retries an application error — it settles to
 * `onError` with the original error preserved. A genuine infrastructure crash is
 * still retried, since it is not an error the body reported.
 *
 * Shared by vanilla xstate actors and a `fromPromise` without a retry policy,
 * which differ only in `body`.
 */
function runOnce(
  ctx: ObjectSharedContext,
  params: SpawnParams,
  body: () => unknown,
): Promise<ActorOutcome> {
  return ctx.run(`actor:${params.id}`, async (): Promise<ActorOutcome> => {
    try {
      return { status: "done", output: await body() };
    } catch (err) {
      return { status: "error", error: normalizeError(err) };
    }
  });
}

/** Run vanilla xstate actor logic through the xstate actor lifecycle. */
function runVanilla(logic: unknown, params: SpawnParams): Promise<unknown> {
  const actor = createActor(logic as AnyActorLogic, {
    id: params.id,
    input: params.input,
  });
  return toPromise(actor.start());
}

/**
 * A `fromPromise` that opted into retries: the ctx-less `body` runs inside
 * `ctx.run` with a retry policy. A transient rejection is retried by Restate; a
 * `TerminalError` bypasses retries, and exhausting the policy fails terminally.
 * Either way `ctx.run` surfaces only a `TerminalError`, which routes to
 * `onError`; anything else is a Restate control signal we must rethrow.
 */
async function runRetryable(
  ctx: ObjectSharedContext,
  params: SpawnParams,
  body: () => unknown,
  retry: RetryPolicy,
): Promise<ActorOutcome> {
  try {
    const output = await ctx.run(`actor:${params.id}`, body, retry);
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
async function runHandler(
  ctx: ObjectSharedContext,
  params: SpawnParams,
  logic: HandlerActor,
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

function assertNever(value: never): never {
  throw new Error(`Unhandled Restate actor kind: ${JSON.stringify(value)}`);
}
