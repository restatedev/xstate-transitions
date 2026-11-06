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
  SpawnExecutableEffect,
} from "xstate";
import { isBuiltInExecutableEffect } from "xstate";
import { referenceInlineActor, resolveReferencedActor } from "./actors";
import { isMachine } from "./registry";
import {
  PARENT_ID,
  childAddress,
  childIdAt,
  createTransitionScope,
  runInitial,
  runTransition,
  stubChildRef,
  type StubStatus,
} from "./scope";
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
// XState v6 returns a `[snapshot, effects]` tuple from its pure transition API,
// where each effect is an `ExecutableEffect`. We inspect the built-in members
// (`@xstate.spawn`, `@xstate.sendTo`, `@xstate.raise`, `@xstate.cancel`,
// `@xstate.stop`) via `isBuiltInExecutableEffect` and read their stable named
// fields. The `@xstate.start` effect (a deferred "start this ref") is ignored:
// we run actors out-of-band through Restate rather than through XState's actor
// lifecycle.
//
// Delays: XState tracks every pending timer (delayed raise/sendTo, `after`,
// state/actor timeouts) in the snapshot and fires one when it receives an
// `xstate.timer` event carrying the timer's key. A delayed effect therefore
// becomes a durable delivery of that `xstate.timer` event back to this
// instance; on delivery XState pops the timer and raises its event or emits an
// immediate `@xstate.sendTo`, which is routed like any other send. Cancelled or
// replaced timers are gone from the snapshot, so a superseded delivery is a
// no-op.
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
  const scope = createTransitionScope(machine, input.isChild);
  const [snapshot, actions] = runInitial(machine, input.input, scope);
  return finish(machine, scope.self.address, snapshot, actions, []);
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
  const scope = createTransitionScope(machine, input.isChild, snapshot);
  injectStubChildren(
    snapshot,
    scope.self,
    [...input.knownChildIds, ...input.knownPromiseIds],
    terminatedChild(input.event),
  );
  const [next, actions] = runTransition(machine, snapshot, input.event, scope);
  return finish(
    machine,
    scope.self.address,
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
  selfAddress: string,
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
      selfAddress,
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
  timers: readonly { target: unknown }[];
}

// resolveState drops live children; re-inject stub refs for known children so
// sendTo/forwardTo targeting them resolve to routable actions. Actor refs stored
// in context use XState's serialized actor marker; replace the markers that
// address one of these children with the exact same stubs so XState's child
// ownership checks also succeed. A marker for one of this instance's children
// that is no longer active becomes a stopped stub, so stopping it again is the
// same no-op it is for a live actor.
function injectStubChildren(
  snapshot: AnyMachineSnapshot,
  self: { address: string },
  knownChildIds: readonly string[],
  terminated: { id: string; status: StubStatus } | undefined,
): void {
  const mutable = snapshot as unknown as MutableSnapshot;
  // XState freezes the empty `children` record produced by
  // `resolveState`. Replace it with a mutable copy before restoring stubs.
  const children = { ...mutable.children };
  const byAddress = new Map<string, unknown>();
  for (const childId of knownChildIds) {
    const status = terminated?.id === childId ? terminated.status : "active";
    children[childId] ??= stubChildRef(childId, self, status);
    byAddress.set(childAddress(self.address, childId), children[childId]);
  }
  mutable.children = children;
  const resolve = (address: string): unknown => {
    const known = byAddress.get(address);
    if (known !== undefined) return known;
    const childId = childIdAt(self.address, address);
    if (childId === undefined) return undefined;
    const stopped = stubChildRef(childId, self, "stopped");
    byAddress.set(address, stopped);
    return stopped;
  };
  mutable.context = canonicalizeActorRefs(mutable.context, resolve);
  // Timers restored with a child target point at the same canonical stubs.
  mutable.timers = mutable.timers.map((timer) => {
    const target = timer.target as { id?: unknown } | "self";
    const childId = target === "self" ? undefined : target.id;
    return typeof childId === "string" && Object.hasOwn(children, childId)
      ? { ...timer, target: children[childId] }
      : timer;
  });
}

/**
 * The child whose completion `event` reports, if any. Its stub reports that
 * terminal status while the event is applied, so (as for a live child) its id
 * is free to be respawned while the completion is handled.
 */
function terminatedChild(
  event: AnyEventObject,
): { id: string; status: StubStatus } | undefined {
  const actorId = (event as { actorId?: unknown }).actorId;
  if (typeof actorId !== "string") return undefined;
  switch (event.type) {
    case "xstate.done.actor":
      return { id: actorId, status: "done" };
    case "xstate.error.actor":
      return { id: actorId, status: "error" };
    default:
      return undefined;
  }
}

/**
 * The address in XState's serialized actor ref (`{ $actor, incarnation? }`),
 * or in a live ref, or `undefined` for anything else. Refs are matched by full
 * address: a ref from another instance can end in the same id as one of ours.
 */
function actorRefAddress(value: object): string | undefined {
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.$actor === "string") {
    const onlyMarkerKeys = Object.keys(candidate).every(
      (key) => key === "$actor" || key === "incarnation",
    );
    return onlyMarkerKeys ? candidate.$actor : undefined;
  }
  if (
    typeof candidate.address === "string" &&
    candidate.ref === value &&
    typeof candidate.send === "function"
  ) {
    return candidate.address;
  }
  return undefined;
}

/**
 * Recursively replace persisted actor refs without mutating user context.
 * `resolve` maps an actor address to its stand-in ref, or `undefined` to keep
 * the ref as it is.
 */
function canonicalizeActorRefs(
  value: unknown,
  resolve: (address: string) => unknown,
): unknown {
  if (typeof value !== "object" || value === null) return value;

  const address = actorRefAddress(value);
  const replacement = address === undefined ? undefined : resolve(address);
  if (replacement !== undefined) return replacement;

  if (Array.isArray(value)) {
    let changed = false;
    const result = value.map((item) => {
      const next = canonicalizeActorRefs(item, resolve);
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
    const next = canonicalizeActorRefs(item, resolve);
    changed ||= next !== item;
    result[key] = next;
  }
  return changed ? result : value;
}

/**
 * Translate XState's effects for one step into durable {@link Effect}s, given
 * the child and promise actors that were active before the step.
 */
function interpretActions(
  machine: AnyStateMachine,
  selfAddress: string,
  snapshot: AnyMachineSnapshot,
  actions: Action[],
  knownChildIds: readonly string[],
  knownPromiseIds: readonly string[],
): Effect[] {
  const activeChildren = new Set(knownChildIds);
  const activePromises = new Set(knownPromiseIds);
  const effects: Effect[] = [];
  // The children XState settled on at the end of the step.
  const settled = (snapshot.children ?? {}) as Record<string, unknown>;

  const stop = (id: string): void => {
    if (activeChildren.delete(id)) {
      effects.push({ kind: "stopChild", childId: id });
    } else if (activePromises.delete(id)) {
      effects.push({ kind: "stopPromise", actorId: id });
    }
  };

  // Effects are translated in the order XState emitted them, so a send that
  // precedes a stop (or follows a start) in the step reaches the child.
  for (const action of actions) {
    if (isBuiltInExecutableEffect(action) && action.type === "@xstate.spawn") {
      // A fresh spawn under an active id replaces the prior incarnation
      // (a reentered invoke, or a respawn after the child finished).
      stop(action.id);
      // Start only the incarnation XState kept: a spawn stopped later in the
      // same step, or superseded by a later spawn of the same id, never ran.
      if (settled[action.id] !== action.actor) continue;
      const start = startEffect(machine, action);
      effects.push(start);
      const active =
        start.kind === "startChild" ? activeChildren : activePromises;
      active.add(action.id);
      continue;
    }
    if (isBuiltInExecutableEffect(action) && action.type === "@xstate.stop") {
      // Context-held refs are canonicalized before the transition, so the
      // stopped actor carries the durable child's id.
      const stoppedId = action.actor?.id;
      if (stoppedId !== undefined) stop(stoppedId);
      continue;
    }
    const effect = toEffect(machine, selfAddress, action, activeChildren);
    if (effect) effects.push(effect);
  }

  // Actors XState dropped without a stop effect (a child removed once its
  // completion was handled) are torn down too.
  for (const id of [...activeChildren, ...activePromises]) {
    if (!Object.hasOwn(settled, id)) stop(id);
  }

  return effects;
}

/**
 * The effect that starts a spawned actor. The `src`/`logic` tell a child
 * machine (its own virtual object) from a promise/handler actor (run
 * out-of-band).
 */
function startEffect(
  machine: AnyStateMachine,
  action: SpawnExecutableEffect,
): Effect {
  const childMachine = resolveChildMachine(machine, action.src, action.logic);
  if (childMachine !== undefined) {
    return {
      kind: "startChild",
      childId: action.id,
      machineId: childMachine.id,
      input: action.input,
    };
  }
  // The runner resolves `src` by name in another Restate call, so inline
  // invoke logic travels as a reference to its invoke definition.
  const src =
    typeof action.src === "string"
      ? action.src
      : (referenceInlineActor(machine, action.src) ?? action.src);
  return {
    kind: "runPromise",
    params: { id: action.id, src, input: action.input },
  };
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

/** XState's `xstate.timer` event type, which fires a pending timer by key. */
const XSTATE_TIMER = "xstate.timer";

/** The key XState matches a timer by: `{ id }`, `{ seq }` or `{ event }`. */
type TimerKey =
  { id: string } | { seq: number } | { event: Record<string, unknown> };

/** The fields of a delayed raise/sendTo or a cancel that identify a timer. */
interface TimerFields {
  id?: string | undefined;
  seq?: number | undefined;
  event?: unknown;
}

/** The identifying fields of a built-in timer event (mirrors XState). */
function builtInTimerIdentity(
  event: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  switch (event?.type) {
    case "xstate.after":
      return { type: event.type, delay: event.delay, stateId: event.stateId };
    case "xstate.timeout.state":
      return { type: event.type, stateId: event.stateId };
    case "xstate.timeout.actor":
      return { type: event.type, actorId: event.actorId };
    default:
      return undefined;
  }
}

/**
 * The key of the timer a delayed effect schedules or a cancel targets, as
 * XState resolves it: an explicit `id`, else the sequence number XState
 * assigns to an unnamed delayed send, else the identity of a built-in timer
 * event (`after`, timeouts).
 */
function timerKeyOf(fields: TimerFields): TimerKey | undefined {
  if (fields.id !== undefined) return { id: fields.id };
  if (fields.seq !== undefined) return { seq: fields.seq };
  const event = fields.event as Record<string, unknown> | undefined;
  if (event === undefined) return undefined;
  return { event: builtInTimerIdentity(event) ?? event };
}

/** A stable string form of a timer key, used as the durable send id. */
function timerSendId(key: TimerKey): string {
  if ("id" in key) return JSON.stringify(["id", key.id]);
  if ("seq" in key) return JSON.stringify(["seq", key.seq]);
  return JSON.stringify(["event", key.event]);
}

/** Schedule the `xstate.timer` delivery that fires a pending XState timer. */
function scheduleTimer(action: TimerFields, delay: number): Effect {
  const key = timerKeyOf(action);
  if (key === undefined) {
    throw new Error("XState emitted a delayed effect without a timer key.");
  }
  return {
    kind: "scheduleSend",
    sendId: timerSendId(key),
    event: { type: XSTATE_TIMER, ...key },
    delay,
  };
}

/** Translate one send/raise/cancel effect into an Effect (or none). */
function toEffect(
  machine: AnyStateMachine,
  selfAddress: string,
  action: Action,
  activeChildren: ReadonlySet<string>,
): Effect | undefined {
  if (!isBuiltInExecutableEffect(action)) return undefined;
  switch (action.type) {
    case "@xstate.raise": {
      // A raise without a delay is drained inside the macrostep. An explicit
      // delay (including zero) is a pending XState timer and must not be
      // dropped.
      return action.delay !== undefined
        ? scheduleTimer(action, action.delay)
        : undefined;
    }
    case "@xstate.sendTo": {
      // A delayed send is a timer on this instance; its target is resolved
      // when it fires, as the immediate send XState emits then.
      if (action.delay !== undefined) {
        return scheduleTimer(action, action.delay);
      }
      const target = targetOf(
        machine,
        selfAddress,
        action.target,
        activeChildren,
      );
      if (!target) return undefined;
      return { kind: "send", target, event: action.event as AnyEventObject };
    }
    case "@xstate.cancel": {
      // XState already removed the timer from the snapshot. Cancelling the
      // durable delivery is cleanup: a stale delivery would be a no-op.
      const key = timerKeyOf(action);
      return key === undefined
        ? undefined
        : { kind: "cancel", sendId: timerSendId(key) };
    }
    default:
      // @xstate.spawn / @xstate.start / @xstate.stop are handled elsewhere.
      // @xstate.terminate and @xstate.deadLetter are runtime bookkeeping for
      // live actors and have no durable counterpart.
      return undefined;
  }
}

/** Resolve a `@xstate.sendTo` target ref to a routing destination. */
function targetOf(
  machine: AnyStateMachine,
  selfAddress: string,
  target: unknown,
  activeChildren: ReadonlySet<string>,
): Target | undefined {
  if (typeof target !== "object" || target === null) return undefined;
  // A serialized ref XState could not resolve (e.g. one received from another
  // instance) routes only if it addresses this instance or one of its own
  // active children exactly.
  if (typeof (target as { $actor?: unknown }).$actor === "string") {
    const address = actorRefAddress(target);
    if (address === undefined) return undefined;
    if (address === selfAddress) return { type: "self" };
    const childId = childIdAt(selfAddress, address);
    return childId !== undefined && activeChildren.has(childId)
      ? { type: "child", childId }
      : undefined;
  }
  // A live ref comes from this instance's own transition: its parent, one of
  // its children, or itself.
  const { id, logic } = target as ActorLike;
  if (id === PARENT_ID) return { type: "parent" };
  if (id !== undefined && activeChildren.has(id)) {
    return { type: "child", childId: id };
  }
  if (logic === machine) return { type: "self" };
  return undefined;
}
