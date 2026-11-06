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
import { createActor } from "xstate";
import { reachableMachines } from "./registry";
import type { Action } from "./types";

// ---------------------------------------------------------------------------
// This module groups all the "fake" actor plumbing needed to drive a machine
// through XState's PURE transition API in a stateless setting:
//   - FAKE_PARENT: a stand-in parent ref so a child's `sendTo(parent, …)`
//     resolves to a routable `@xstate.sendTo` action instead of a communication
//     error.
//   - stubChildRef: stand-in child refs (re-injected after resolveState drops
//     live children) so `sendTo`/`forwardTo` targeting a child resolve.
//   - createTransitionScope / runInitial / runTransition: pure transition
//     entry points over an inert scope the integration builds itself, so the
//     scope's `self` is known before the transition runs.
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
  readonly address: string;
  _parent: unknown;
  _snapshot: AnyMachineSnapshot | undefined;
  system: MutableActorSystem;
}

/**
 * The inert actor scope xstate's transition functions expect (v6 shape, mirror
 * of core's internal `createInertActorScope`).
 */
export interface ActorScope {
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

/** The internals of a machine we drive directly with our own scope. */
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

// An inert scope has no parent, so a child's `sendTo(parent, …)` (v6's
// replacement for `sendParent`) would push a communication-error event instead
// of a routable action. Giving a child instance's throwaway actor a fake
// `_parent` makes XState resolve those into ordinary `@xstate.sendTo` actions
// whose `target.id` is #_parent, which the integration routes to the parent
// object. It is also the restored target of a pending timer that sends to the
// parent. Its `address` roots the addresses XState gives a child instance and
// that instance's own children.
const FAKE_PARENT = {
  id: PARENT_ID,
  address: PARENT_ID,
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

/** One segment of an XState actor address, escaped as XState escapes it. */
function addressSegment(id: string): string {
  return id.replaceAll("%", "%25").replaceAll("/", "%2F");
}

/** Undo {@link addressSegment}. */
function decodeAddressSegment(segment: string): string {
  return segment.replaceAll("%2F", "/").replaceAll("%25", "%");
}

/** The address XState gives a child of the instance at `parentAddress`. */
export function childAddress(parentAddress: string, childId: string): string {
  return `${parentAddress}/${addressSegment(childId)}`;
}

/**
 * The id of the direct child that `address` names under `parentAddress`, or
 * `undefined` when it names some other actor.
 */
export function childIdAt(
  parentAddress: string,
  address: string,
): string | undefined {
  const prefix = `${parentAddress}/`;
  if (!address.startsWith(prefix)) return undefined;
  const segment = address.slice(prefix.length);
  return segment.includes("/") ? undefined : decodeAddressSegment(segment);
}

/**
 * The status a child stub reports. A child whose completion is being applied
 * reports `done`/`error`, which frees its id for a respawn in the same step,
 * as XState does for a live child.
 */
export type StubStatus = "active" | "stopped" | "done" | "error";

/**
 * A minimal stand-in for a child actor ref. `resolveState` drops live children,
 * so before transitioning we re-inject one of these per persisted child so that
 * `sendTo`/`forwardTo` targeting the child resolves to a routable action instead
 * of a communication error. XState also reads its active status and `ref`
 * identity during child ownership checks. `toJSON` emits XState's actor-ref
 * marker (`{ $actor: address }`) when Restate persists the planned snapshot.
 * The stub itself is never run.
 *
 * `parent` is the transition scope's `self`. XState accepts stopping an actor
 * whose `_parent` is `self` even when it is no longer among the children,
 * which is how a stale ref to an already-stopped child (`status: "stopped"`)
 * stays a harmless no-op, as it is for a live actor.
 */
export function stubChildRef(
  id: string,
  parent: { address: string },
  status: StubStatus = "active",
): unknown {
  const address = childAddress(parent.address, id);
  const ref = {
    id,
    address,
    sessionId: id,
    send: () => {},
    _send: () => {},
    getSnapshot: () => ({ status }),
    on: () => ({ unsubscribe: () => {} }),
    _parent: parent,
    _processingStatus: status === "active" ? 1 : 2,
    toJSON: () => ({ $actor: address }),
    ref: undefined as unknown,
  };
  ref.ref = ref;
  return ref;
}

/**
 * The microstep bound applied to machines that do not set their own
 * `options.maxIterations`. XState v6 leaves macrosteps unbounded by default, so
 * a cycle of eventless transitions or raised events would spin until the
 * handler runs out of memory; bounding it surfaces an `InfiniteTransitionError`
 * that fails the invocation instead.
 */
export const DEFAULT_MAX_ITERATIONS = 1000;

const guardedRoots = new WeakSet<AnyStateMachine>();

/**
 * Bound the macrosteps of the machine and every machine it can spawn, unless
 * one chose its own bound. Spawning a child machine computes the child's
 * initial snapshot inside the parent's step, so an unbounded child would
 * exhaust memory there.
 */
function guardInfiniteLoops(machine: AnyStateMachine): void {
  if (guardedRoots.has(machine)) return;
  for (const reachable of reachableMachines(machine)) {
    // `options` is the machine's own copy of its config options.
    const options = (reachable as { options?: { maxIterations?: number } })
      .options;
    if (options !== undefined) {
      options.maxIterations ??= DEFAULT_MAX_ITERATIONS;
    }
  }
  guardedRoots.add(machine);
}

/**
 * The inert actor scope an instance transitions in. Building it ourselves
 * (rather than letting xstate's `transition()` build one internally) gives the
 * integration the scope's `self` before the transition runs: its `address`
 * anchors persisted actor refs, and it is the parent of re-injected child
 * stubs. A child instance's actor gets a fake parent so `sendTo(parent, …)`
 * resolves to a routable action.
 */
export function createTransitionScope(
  machine: AnyStateMachine,
  isChild: boolean,
  snapshot?: AnyMachineSnapshot,
): ActorScope {
  // `createActor` eagerly computes an initial snapshot, so the loop bound must
  // be in place before it runs.
  guardInfiniteLoops(machine);
  const self = createActor(machine) as unknown as MutableActor;
  if (isChild) self._parent = FAKE_PARENT;
  // Actors with a systemId are registered during that eager computation, then
  // registered again when the transition runs in this scope. XState's own
  // inert scope replaces the system for the same reason; removing the eager
  // entries gives this scope equivalent isolation.
  const all = self.system.getAll?.();
  if (all) {
    for (const actor of Object.values(all)) {
      self.system._unregister?.(actor);
    }
  }
  // XState consults `self._snapshot` for child ownership and id allocation.
  // Drop createActor's eagerly computed initial snapshot for an initial step,
  // or replace it with the rehydrated snapshot for a resumed step.
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

/** Compute the initial transition in `scope`. */
export function runInitial(
  machine: AnyStateMachine,
  input: unknown,
  scope: ActorScope,
): [AnyMachineSnapshot, Action[]] {
  return internalsOf(machine).initialTransition(input, scope);
}

/** Compute a transition in `scope`. */
export function runTransition(
  machine: AnyStateMachine,
  snapshot: AnyMachineSnapshot,
  event: unknown,
  scope: ActorScope,
): [AnyMachineSnapshot, Action[]] {
  return internalsOf(machine).transition(snapshot, event, scope);
}
