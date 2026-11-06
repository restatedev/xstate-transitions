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

import type { AnyMachineSnapshot, AnyStateMachine } from "xstate";
import { createActor, initialTransition, transition } from "xstate";
import type { Action } from "./types";

// ---------------------------------------------------------------------------
// This module groups all the "fake" actor plumbing needed to drive a machine
// through XState's PURE transition API in a stateless setting:
//   - FAKE_PARENT: a stand-in parent ref so a child's `sendTo(parent, …)`
//     resolves to a routable `@xstate.sendTo` action instead of a communication
//     error.
//   - stubChildRef: stand-in child refs (re-injected after resolveState drops
//     live children) so `sendTo`/`forwardTo` targeting a child resolve.
//   - runInitial / runTransition: pure transition entry points, using a
//     parent-aware actor scope for child machines.
// None of this imports Restate; it is all pure XState.
//
// The casts here reach into xstate internals that its public types do not
// expose. The shapes we touch are named below so the reaches are explicit.
// ---------------------------------------------------------------------------

/** xstate's SpecialTargets.Parent id — the `id` of a routed sendTo(parent) target. */
export const PARENT_ID = "#_parent";

/** The subset of a live actor system we mutate/read when building a scope. */
interface MutableActorSystem {
  _sendInspectionEvent?: () => void;
  _unregister?: (actor: unknown) => void;
  getAll?: () => Record<string, unknown>;
}

interface MutableActor {
  _parent: unknown;
  _snapshot: AnyMachineSnapshot | undefined;
  system: MutableActorSystem;
}

/**
 * The inert actor scope xstate's transition functions expect (v6 shape, mirror
 * of core's internal `createInertActorScope`).
 */
interface ActorScope {
  self: MutableActor;
  system: unknown;
  actionExecutor: () => void;
  defer: () => void;
  id: string;
  logger: () => void;
  sessionId: string;
  stopChild: () => void;
  emit: () => void;
}

/** The internals of a machine we drive directly with a parent-aware scope. */
interface MachineInternals {
  initialTransition: (
    input: unknown,
    scope: ActorScope,
  ) => [AnyMachineSnapshot, Action[]];
  transition: (
    snapshot: AnyMachineSnapshot,
    event: unknown,
    scope: ActorScope,
  ) => [AnyMachineSnapshot, Action[]];
}

const internalsOf = (machine: AnyStateMachine): MachineInternals =>
  machine as unknown as MachineInternals;

// The pure transition() API builds an inert scope with no parent, so a child's
// `sendTo(parent, …)` (v6's replacement for `sendParent`) would push a
// communication-error event instead of a routable action. Giving the throwaway
// actor a fake `_parent` makes XState resolve those into ordinary
// `@xstate.sendTo` actions whose `target.id` is #_parent, which the integration
// routes to the parent object. It is also the restored target of a pending
// timer that sends to the parent.
const FAKE_PARENT = {
  id: PARENT_ID,
  sessionId: PARENT_ID,
  send: () => {},
  _send: () => {},
  _parent: undefined,
  getSnapshot: () => undefined,
  on: () => ({ unsubscribe: () => {} }),
  start: () => {},
  stop: () => {},
};

/** The stand-in parent ref, for restoring timers that target the parent. */
export const parentRef: unknown = FAKE_PARENT;

/**
 * A minimal stand-in for a child actor ref. `resolveState` drops live children,
 * so before transitioning we re-inject one of these per persisted child so that
 * `sendTo`/`forwardTo` targeting the child resolves to a routable action instead
 * of a communication error. XState also reads its active status and `ref`
 * identity during child ownership checks. `toJSON` emits XState's actor-ref
 * marker (`{ $actor }`) when Restate persists the planned snapshot. The stub itself is never
 * run.
 */
export function stubChildRef(id: string): unknown {
  const ref = {
    id,
    sessionId: id,
    send: () => {},
    _send: () => {},
    getSnapshot: () => ({ status: "active" }),
    on: () => ({ unsubscribe: () => {} }),
    _parent: undefined,
    _processingStatus: 1,
    toJSON: () => ({ $actor: id }),
    ref: undefined as unknown,
  };
  ref.ref = ref;
  return ref;
}

/** Build an inert scope whose actor has a fake parent. */
function parentScope(
  machine: AnyStateMachine,
  snapshot?: AnyMachineSnapshot,
): ActorScope {
  const self = createActor(machine) as unknown as MutableActor;
  self._parent = FAKE_PARENT;
  // createActor eagerly computes an initial snapshot. Actors with a systemId
  // are registered during that construction, then registered again when we
  // explicitly call initialTransition/transition below. XState's own inert
  // scope replaces the system for the same reason; removing the eager entries
  // gives this parent-aware scope equivalent isolation.
  const all = self.system.getAll?.();
  if (all) {
    for (const actor of Object.values(all)) {
      self.system._unregister?.(actor);
    }
  }
  // XState consults `self._snapshot` for child ownership and id allocation.
  // Drop createActor's eagerly computed initial snapshot for an initial step,
  // or replace it with the rehydrated snapshot for a resumed child step.
  self._snapshot = snapshot;
  self.system._sendInspectionEvent = () => {};
  return {
    self,
    system: self.system,
    actionExecutor: () => {},
    defer: () => {},
    id: "",
    logger: () => {},
    sessionId: "",
    stopChild: () => {},
    emit: () => {},
  };
}

/**
 * The microstep bound applied to machines that do not set their own
 * `options.maxIterations`. XState v6 leaves macrosteps unbounded by default, so
 * a cycle of eventless transitions or raised events would spin until the
 * handler runs out of memory; bounding it surfaces an `InfiniteTransitionError`
 * that fails the invocation instead.
 */
export const DEFAULT_MAX_ITERATIONS = 1000;

/** Bound the machine's macrosteps unless it chose its own bound. */
function guardInfiniteLoops(machine: AnyStateMachine): void {
  // `options` is the machine's own copy of its config options.
  const options = (machine as { options?: { maxIterations?: number } }).options;
  if (options !== undefined) {
    options.maxIterations ??= DEFAULT_MAX_ITERATIONS;
  }
}

/**
 * Compute the initial transition. For a child machine, uses a parent-aware scope
 * so entry `sendTo(parent, …)` actions resolve; for a root, uses xstate's
 * built-in `initialTransition`.
 */
export function runInitial(
  machine: AnyStateMachine,
  input: unknown,
  asChild: boolean,
): [AnyMachineSnapshot, Action[]] {
  guardInfiniteLoops(machine);
  if (!asChild) {
    return initialTransition(machine, input) as [AnyMachineSnapshot, Action[]];
  }
  return internalsOf(machine).initialTransition(input, parentScope(machine));
}

/**
 * Compute a transition. For a child machine, uses a parent-aware scope; for a
 * root, uses xstate's built-in `transition`.
 */
export function runTransition(
  machine: AnyStateMachine,
  snapshot: AnyMachineSnapshot,
  event: unknown,
  asChild: boolean,
): [AnyMachineSnapshot, Action[]] {
  guardInfiniteLoops(machine);
  if (!asChild) {
    return transition(machine, snapshot, event as never) as [
      AnyMachineSnapshot,
      Action[],
    ];
  }
  return internalsOf(machine).transition(
    snapshot,
    event,
    parentScope(machine, snapshot),
  );
}
