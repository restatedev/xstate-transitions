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
import { fromPromise as xstateFromPromise } from "xstate";

/**
 * Sentinel marking one of our Restate-managed actors ({@link fromPromise},
 * {@link fromHandler}). The pure XState layer never inspects it; only the
 * Restate execution layer (`run-actor.ts`) does.
 */
export const RESTATE_ACTOR = "restate.actor";

/**
 * Retry policy for a retryable {@link fromPromise}. Structurally a subset of the
 * Restate SDK's `RunOptions`, so it is passed straight through to `ctx.run`.
 * Intervals are milliseconds; omitted fields fall back to Restate's defaults.
 */
export type RetryPolicy = {
  readonly maxRetryAttempts?: number;
  readonly maxRetryDuration?: number;
  readonly initialRetryInterval?: number;
  readonly maxRetryInterval?: number;
  readonly retryIntervalFactor?: number;
};

/**
 * Options for {@link fromPromise}.
 *
 * - omitted / `retry: false` — any rejection is terminal and routes to the
 *   invoking state's `onError` (fail-fast, like vanilla xstate `fromPromise`).
 * - `retry: true` — transient rejections are retried by Restate using its
 *   default policy; a `TerminalError` bypasses retries.
 * - `retry: <policy>` — as above, with a bounded/custom policy.
 */
export type FromPromiseOptions = {
  readonly retry?: boolean | RetryPolicy;
};

/** A ctx-less promise creator (basic / retryable {@link fromPromise}). */
export type PromiseCreator<TOutput, TInput> = (args: {
  readonly input: TInput;
}) => TOutput | Promise<TOutput>;

/** A ctx-aware creator ({@link fromHandler}) that journals its own effects. */
export type HandlerCreator<TOutput, TInput> = (args: {
  readonly input: TInput;
  readonly ctx: ObjectSharedContext;
}) => TOutput | Promise<TOutput>;

/** The kinds of Restate-managed actor, each run by a dedicated runner. */
export type RestateActorKind = "promise" | "retryable" | "handler";

/**
 * The runtime tag attached to xstate actor logic so `run-actor.ts` knows how to
 * execute it. A discriminated union — one member per {@link RestateActorKind}:
 *
 * - `promise`   — ctx-less, fail-fast (any rejection is terminal).
 * - `retryable` — ctx-less, retried per `retry` policy.
 * - `handler`   — ctx-aware; receives the Restate `ctx`.
 */
export type RestateActor =
  | {
      readonly sentinel: typeof RESTATE_ACTOR;
      readonly kind: "promise";
      readonly config: (args: { input: unknown }) => unknown;
    }
  | {
      readonly sentinel: typeof RESTATE_ACTOR;
      readonly kind: "retryable";
      readonly retry: RetryPolicy;
      readonly config: (args: { input: unknown }) => unknown;
    }
  | {
      readonly sentinel: typeof RESTATE_ACTOR;
      readonly kind: "handler";
      readonly config: (args: {
        input: unknown;
        ctx: ObjectSharedContext;
      }) => unknown;
    };

const ACTOR_KINDS: ReadonlySet<RestateActorKind> = new Set([
  "promise",
  "retryable",
  "handler",
]);

/** True when `logic` is one of our Restate-managed actors. */
export function isRestateActor(logic: unknown): logic is RestateActor {
  if (typeof logic !== "object" || logic === null) return false;
  const candidate = logic as {
    sentinel?: unknown;
    kind?: unknown;
    config?: unknown;
  };
  // Verify `config` is callable too: the predicate claims it, so a mistagged
  // value must not pass and blow up later when we invoke config().
  return (
    candidate.sentinel === RESTATE_ACTOR &&
    ACTOR_KINDS.has(candidate.kind as RestateActorKind) &&
    typeof candidate.config === "function"
  );
}

// Placeholder xstate logic body. Our actors never run in the inert transition
// scope; the executeActor handler runs the real `config` out-of-band. If one is
// ever started directly, fail loudly instead of hanging.
const rejectDirectStart = () =>
  Promise.reject(
    new Error(
      "A Restate actor must be run by the internal 'executeActor' handler, not started directly.",
    ),
  );

/**
 * A ctx-less Restate promise actor.
 *
 * The creator receives only `{ input }`. It runs out-of-band inside `ctx.run`,
 * so its result is journaled exactly-once and replay-safe.
 *
 * By default any rejection is terminal and routes to `onError` (fail-fast). Pass
 * `{ retry: true }` (or a policy) to retry transient rejections via Restate's
 * `ctx.run` retry; throw a `TerminalError` to fail without retrying.
 */
export function fromPromise<TOutput, TInput = unknown>(
  creator: PromiseCreator<TOutput, TInput>,
  options?: FromPromiseOptions,
) {
  const logic = xstateFromPromise<TOutput, TInput>(rejectDirectStart);
  const retry = options?.retry ?? false;
  if (retry === false) {
    return Object.assign(logic, {
      sentinel: RESTATE_ACTOR,
      kind: "promise",
      config: creator,
    });
  }
  return Object.assign(logic, {
    sentinel: RESTATE_ACTOR,
    kind: "retryable",
    retry: retry === true ? {} : retry,
    config: creator,
  });
}

/**
 * A ctx-aware Restate actor.
 *
 * Unlike {@link fromPromise}, the creator receives the Restate `ctx` and is
 * responsible for journaling its own side effects (`ctx.run`, `ctx.date`,
 * `ctx.rand`, nested calls). It runs directly, not wrapped in `ctx.run` — that
 * would be illegal nested journaling. A `TerminalError` routes to `onError`; any
 * other error propagates so Restate retries the whole invocation under its
 * default policy.
 */
export function fromHandler<TOutput, TInput = unknown>(
  creator: HandlerCreator<TOutput, TInput>,
) {
  const logic = xstateFromPromise<TOutput, TInput>(rejectDirectStart);
  return Object.assign(logic, {
    sentinel: RESTATE_ACTOR,
    kind: "handler",
    config: creator,
  });
}
