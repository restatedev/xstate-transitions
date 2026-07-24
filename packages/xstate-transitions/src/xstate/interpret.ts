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

import type {
  AnyEventObject,
  AnyMachineSnapshot,
  AnyStateMachine,
  SpawnExecutableActionObject,
} from "xstate";
import { isBuiltInExecutableAction } from "xstate";
import { resolveReferencedActor } from "./actors";
import { isMachine } from "./registry";
import { PARENT_ID, runInitial, runTransition, stubChildRef } from "./scope";
import { fromStored, toReturnedSnapshot, toStored } from "./snapshot";
import type {
  Action,
  Effect,
  InitInput,
  ResumeInput,
  Step,
  Target,
} from "./types";

// ---------------------------------------------------------------------------
// The pure heart of the integration. `initialStep` / `resumeStep` compute the
// next persisted state plus a list of abstract Effects from a machine, its
// persisted state, and an event. There is NO Restate dependency here; it is
// fully unit-testable with plain objects. The Restate layer executes the
// effects (see ../restate/effects.ts).
//
// XState v6 returns a `[snapshot, actions]` tuple from its pure transition API,
// where each action is an `ExecutableActionObject`. We inspect the built-in
// members (`@xstate.spawn`, `@xstate.sendTo`, `@xstate.raise`, `@xstate.cancel`,
// `@xstate.stop`) via `isBuiltInExecutableAction` and read their stable named
// fields. The `@xstate.start` action (a deferred "start this ref") is ignored:
// we run actors out-of-band through Restate rather than through XState's actor
// lifecycle.
// ---------------------------------------------------------------------------

// ===========================================================================
// Entrypoints
// ===========================================================================

/**
 * Start a brand-new instance from its initial transition.
 *
 * Runs the machine's initial transition (entry actions, initial-state resolution)
 * and returns the persisted snapshot alongside the effects to execute. Pure: no
 * side effects are performed — invoked actors, delayed events, and inter-actor
 * sends come back as {@link Effect}s for the caller to run.
 *
 * @param machine - The state machine to start.
 * @param input - The machine input, and whether this instance is a child
 *   (a child uses a parent-aware scope so entry `sendTo(parent, …)` actions
 *   resolve).
 * @returns The next persisted state, a caller-facing snapshot, and the effects.
 */
export function initialStep(machine: AnyStateMachine, input: InitInput): Step {
  const [snapshot, actions] = runInitial(machine, input.input, input.isChild);
  return finish(machine, snapshot, actions, []);
}

/**
 * Apply an event to an existing, persisted instance.
 *
 * Rehydrates the stored snapshot, re-injects stub refs for already-started
 * children, canonicalizes serialized context-held refs to those same stubs,
 * runs one full macrostep for the event, and returns the next persisted state
 * plus effects. Pure, like {@link initialStep}.
 *
 * @param machine - The state machine this instance runs.
 * @param input - The stored state, the event to apply, whether this instance is
 *   a child, and the ids of child/promise actors already started (so they are
 *   not restarted).
 * @returns The next persisted state, a caller-facing snapshot, and the effects.
 */
export function resumeStep(machine: AnyStateMachine, input: ResumeInput): Step {
  const snapshot = fromStored(machine, input.stored);
  injectStubChildren(snapshot, [
    ...input.knownChildIds,
    ...input.knownPromiseIds,
  ]);
  const [next, actions] = runTransition(
    machine,
    snapshot,
    input.event,
    input.isChild,
  );
  return finish(
    machine,
    next,
    actions,
    input.knownChildIds,
    input.knownPromiseIds,
  );
}

// ===========================================================================
// Internals
// ===========================================================================

/** The subset of an actor ref we read for routing (target/stop resolution). */
interface ActorLike {
  id?: string;
  logic?: unknown;
}

/** Build the shared result shape for both entrypoints. */
function finish(
  machine: AnyStateMachine,
  snapshot: AnyMachineSnapshot,
  actions: Action[],
  knownChildIds: readonly string[],
  knownPromiseIds: readonly string[] = [],
): Step {
  return {
    nextState: toStored(snapshot),
    returned: toReturnedSnapshot(snapshot),
    effects: interpretActions(
      machine,
      snapshot,
      actions,
      knownChildIds,
      knownPromiseIds,
    ),
  };
}

interface MutableSnapshot {
  context: unknown;
  children: Record<string, unknown>;
}

// resolveState drops live children; re-inject stub refs for known children so
// sendTo/forwardTo targeting them resolve to routable actions. Actor refs stored
// in context serialize to `{ "xstate$$type": 1, id }`; replace those markers
// with the exact same stubs so XState's child ownership checks also succeed.
function injectStubChildren(
  snapshot: AnyMachineSnapshot,
  knownChildIds: readonly string[],
): void {
  const mutable = snapshot as unknown as MutableSnapshot;
  const children = mutable.children;
  const refs = new Map<string, unknown>();
  for (const childId of knownChildIds) {
    children[childId] ??= stubChildRef(childId);
    refs.set(childId, children[childId]);
  }
  mutable.context = canonicalizeActorRefs(mutable.context, refs);
}

/** Find an XState actor id on either a serialized marker or a live ref. */
function actorRefId(value: object): string | undefined {
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== "string") return undefined;
  if (candidate["xstate$$type"] === 1) return candidate.id;
  if (candidate.ref === value && typeof candidate.send === "function") {
    return candidate.id;
  }
  return undefined;
}

/** Recursively replace persisted actor refs without mutating user context. */
function canonicalizeActorRefs(
  value: unknown,
  refs: ReadonlyMap<string, unknown>,
): unknown {
  if (typeof value !== "object" || value === null) return value;

  const actorId = actorRefId(value);
  if (actorId !== undefined && refs.has(actorId)) return refs.get(actorId);

  if (Array.isArray(value)) {
    let changed = false;
    const result = value.map((item) => {
      const next = canonicalizeActorRefs(item, refs);
      changed ||= next !== item;
      return next;
    });
    return changed ? result : value;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;

  let changed = false;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const next = canonicalizeActorRefs(item, refs);
    changed ||= next !== item;
    result[key] = next;
  }
  return changed ? result : value;
}

function interpretActions(
  machine: AnyStateMachine,
  snapshot: AnyMachineSnapshot,
  actions: Action[],
  knownChildIds: readonly string[],
  knownPromiseIds: readonly string[],
): Effect[] {
  const activeChildren = new Set(knownChildIds);
  const activePromises = new Set(knownPromiseIds);
  const effects: Effect[] = [];

  // Actors (re)started and explicitly stopped this step. XState v6 emits
  // `@xstate.spawn` for every invoke/spawn (id, resolved input, `src`/`logic`),
  // and `@xstate.stop` when a transition stops an actor via `enq.stop(ref)`.
  const spawned = new Map<string, SpawnExecutableActionObject>();
  const stoppedIds = new Set<string>();
  for (const action of actions) {
    if (!isBuiltInExecutableAction(action)) continue;
    if (action.type === "@xstate.spawn") {
      spawned.set(action.id, action);
    } else if (action.type === "@xstate.stop") {
      // Context-held refs are canonicalized before the transition. Retain the
      // explicit id so the emitted stop action tears down the durable child.
      const stoppedId = action.actor?.id;
      if (stoppedId !== undefined) stoppedIds.add(stoppedId);
    }
  }

  // 1. Stop persisted actors. An exited invoke disappears from
  //    `snapshot.children` and emits a stop action. A reentered actor stays in
  //    children but is re-spawned this step, so a fresh spawn also implies
  //    stopping the prior incarnation. Stopping here removes it from the active
  //    sets; step 2 re-adds a reentered actor as a start (stop-then-start).
  const liveChildren = childIdsOf(snapshot);
  const isStopped = (id: string): boolean =>
    !liveChildren.has(id) || spawned.has(id) || stoppedIds.has(id);
  for (const childId of knownChildIds) {
    if (isStopped(childId) && activeChildren.delete(childId)) {
      effects.push({ kind: "stopChild", childId });
    }
  }
  for (const actorId of knownPromiseIds) {
    if (isStopped(actorId) && activePromises.delete(actorId)) {
      effects.push({ kind: "stopPromise", actorId });
    }
  }

  // 2. Start newly spawned/invoked actors. The `src`/`logic` tell a child
  //    machine (its own virtual object) from a promise/handler actor (run
  //    out-of-band). A spawn that XState cancelled within this same macrostep
  //    (spawn-then-stop) is absent from the settled children; starting it would
  //    run an effect XState discarded, so only start spawns that survive.
  for (const [id, action] of spawned) {
    if (activeChildren.has(id) || activePromises.has(id)) continue;
    if (!liveChildren.has(id)) continue;

    const childMachine = resolveChildMachine(machine, action.src, action.logic);
    if (childMachine !== undefined) {
      effects.push({
        kind: "startChild",
        childId: id,
        machineId: childMachine.id,
        input: action.input,
      });
      activeChildren.add(id);
    } else {
      effects.push({
        kind: "runPromise",
        params: { id, src: action.src ?? action.logic, input: action.input },
      });
      activePromises.add(id);
    }
  }

  // 3. Sends, delayed sends, and cancellations.
  for (const action of actions) {
    const effect = toEffect(machine, action, activeChildren);
    if (effect) effects.push(effect);
  }

  return effects;
}

/** The ids of actors still active in a snapshot's `children` map. */
function childIdsOf(snapshot: AnyMachineSnapshot): ReadonlySet<string> {
  return new Set(Object.keys(snapshot.children ?? {}));
}

/**
 * Resolve a spawn/invoke `src` to a child machine, or `undefined` when it is a
 * promise/handler actor (which the Restate layer runs out-of-band).
 */
function resolveChildMachine(
  machine: AnyStateMachine,
  src: string | unknown,
  logic: unknown,
): AnyStateMachine | undefined {
  const candidate =
    typeof src === "string"
      ? resolveReferencedActor(machine, src)
      : (src ?? logic);
  return isMachine(candidate) ? candidate : undefined;
}

/** Translate one send/raise/cancel action into an Effect (or none). */
function toEffect(
  machine: AnyStateMachine,
  action: Action,
  activeChildren: ReadonlySet<string>,
): Effect | undefined {
  if (!isBuiltInExecutableAction(action)) return undefined;
  switch (action.type) {
    case "@xstate.raise": {
      // A raise without a delay is drained inside the macrostep. An explicit
      // delay (including zero) is scheduled by XState and must not be dropped.
      // A raise always targets self.
      return action.delay !== undefined
        ? scheduleSend(action.id, { type: "self" }, action.event, action.delay)
        : undefined;
    }
    case "@xstate.sendTo": {
      const target = targetOf(machine, action.target, activeChildren);
      if (!target) return undefined;
      return action.delay !== undefined
        ? scheduleSend(action.id, target, action.event, action.delay)
        : { kind: "send", target, event: action.event as AnyEventObject };
    }
    case "@xstate.cancel":
      return { kind: "cancel", sendId: action.id };
    default:
      // @xstate.spawn / @xstate.start / @xstate.stop are handled elsewhere.
      return undefined;
  }
}

function scheduleSend(
  sendId: string | undefined,
  target: Target,
  event: AnyEventObject,
  delay: number,
): Effect {
  return {
    kind: "scheduleSend",
    ...(sendId === undefined ? {} : { sendId }),
    target,
    event,
    delay,
  };
}

/** Resolve a `@xstate.sendTo` target ref to a routing destination. */
function targetOf(
  machine: AnyStateMachine,
  target: unknown,
  activeChildren: ReadonlySet<string>,
): Target | undefined {
  const ref = target as ActorLike | undefined;
  const id = ref?.id;
  if (id === PARENT_ID) return { type: "parent" };
  if (id !== undefined && activeChildren.has(id)) {
    return { type: "child", childId: id };
  }
  if (ref?.logic === machine) return { type: "self" };
  return undefined;
}
