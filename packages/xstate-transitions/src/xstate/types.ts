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

import type { AnyEventObject, ExecutableEffect, SnapshotStatus } from "xstate";

// ---------------------------------------------------------------------------
// Shared types for the pure (Restate-free) layer. Kept in one self-contained
// file so the vocabulary the integration speaks — persisted state, snapshots,
// effects — is defined in a single place.
// ---------------------------------------------------------------------------

/**
 * The serializable form of a machine snapshot, persisted between requests.
 * `historyValue` is stored as node ids (not the live StateNode instances the
 * raw snapshot carries) so history survives JSON serialization.
 */
export interface StoredState {
  value: unknown;
  context: unknown;
  status: SnapshotStatus;
  output?: unknown;
  error?: unknown;
  historyValue: Record<string, string[]>;
  /** XState's pending logical timers (delayed raise/sendTo, `after`, timeouts). */
  timers?: StoredTimer[];
  /** XState's sequence for numbering delayed sends scheduled without an `id`. */
  nextTimerId?: number;
  /** The `input` each active state was entered with, keyed by state node id. */
  stateInputs?: Record<string, unknown>;
  /**
   * XState's per-source counters for generated child ids (`child:0`), so an
   * id freed by a stopped child is never handed out again.
   */
  nextActorIds?: Record<string, number>;
}

/**
 * A pending XState timer in serializable form. The live snapshot holds actor
 * refs as targets; these are persisted as routing descriptors and resolved
 * back to stub refs on rehydration.
 */
export interface StoredTimer {
  id?: string;
  seq?: number;
  delay: number;
  type: "@xstate.raise" | "@xstate.sendTo";
  event: AnyEventObject;
  target: Target;
}

/** The plain, serializable snapshot shape returned to callers. */
export interface ReturnedSnapshot {
  value: unknown;
  context: unknown;
  status: SnapshotStatus;
  output?: unknown;
  error?: unknown;
  tags: string[];
}

/** A condition that `waitFor` can wait on. */
export type Condition = "done" | `/${string}`;

/** The pure outcome of evaluating a wait condition against a settled snapshot. */
export type ConditionOutcome =
  | { status: "pending" }
  | { status: "resolve"; snapshot: ReturnedSnapshot }
  | { status: "reject"; reason: string };

/**
 * One executable effect emitted by xstate's pure transition. The interpreter
 * narrows the built-in members (`@xstate.spawn`, `@xstate.sendTo`,
 * `@xstate.raise`, `@xstate.cancel`, `@xstate.stop`) with xstate's
 * `isBuiltInExecutableEffect` and reads their stable named fields.
 */
export type Action = ExecutableEffect;

/** Where a routed event is delivered. */
export type Target =
  { type: "self" } | { type: "child"; childId: string } | { type: "parent" };

/** The spawn-action params carried to the actor runner. */
export interface SpawnParams {
  id: string;
  src?: unknown;
  input?: unknown;
  [k: string]: unknown;
}

/**
 * Something the machine wants done, described independently of Restate. `step`
 * returns these; the Restate layer executes them with a simple switch.
 */
export type Effect =
  | { kind: "runPromise"; params: SpawnParams }
  | { kind: "startChild"; childId: string; machineId: string; input: unknown }
  | { kind: "stopChild"; childId: string }
  | { kind: "stopPromise"; actorId: string }
  | { kind: "send"; target: Target; event: AnyEventObject }
  | {
      /**
       * Deliver `event` (an `xstate.timer` event) back to this instance after
       * `delay`. XState owns the pending timer in its snapshot and decides on
       * delivery whether it still fires; `sendId` is the timer's stable key, so
       * rescheduling or cancelling the same timer supersedes this delivery.
       */
      kind: "scheduleSend";
      sendId: string;
      event: AnyEventObject;
      delay: number;
    }
  | { kind: "cancel"; sendId: string };

/** The result of a pure step: the next persisted state, plus what to do next. */
export interface Step {
  nextState: StoredState;
  returned: ReturnedSnapshot;
  effects: Effect[];
}

/** Input to start a brand-new instance from its initial transition. */
export interface InitInput {
  input?: unknown;
  /** Whether this instance is a child (drives parent-aware sendParent). */
  isChild: boolean;
}

/** Input to apply an event to an existing, persisted instance. */
export interface ResumeInput {
  stored: StoredState;
  event: AnyEventObject;
  /** Whether this instance is a child (drives parent-aware sendParent). */
  isChild: boolean;
  /** Ids of children already started (to avoid re-starting them). */
  knownChildIds: readonly string[];
  /** Ids of promise actors still running out-of-band. */
  knownPromiseIds: readonly string[];
}
