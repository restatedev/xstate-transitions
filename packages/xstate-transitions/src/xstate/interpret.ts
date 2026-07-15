import type {
  AnyEventObject,
  AnyMachineSnapshot,
  AnyStateMachine,
} from "xstate";
import { isMachine } from "./registry";
import { PARENT_ID, runInitial, runTransition, stubChildRef } from "./scope";
import { fromStored, toReturnedSnapshot, toStored } from "./snapshot";
import type {
  Action,
  Effect,
  InitInput,
  ResumeInput,
  SpawnParams,
  Step,
  Target,
} from "./types";

// ---------------------------------------------------------------------------
// The pure heart of the integration. `initialStep` / `resumeStep` compute the
// next persisted state plus a list of abstract Effects from a machine, its
// persisted state, and an event. There is NO Restate dependency here; it is
// fully unit-testable with plain objects. The Restate layer executes the
// effects (see ../restate/effects.ts).
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
 *   (a child uses a parent-aware scope so entry `sendParent` actions resolve).
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
 * children (so `sendTo`/`forwardTo` targeting them resolve), runs one full
 * macrostep for the event, and returns the next persisted state plus effects.
 * Pure, like {@link initialStep}.
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

// The executable actions xstate emits carry loosely-typed params. These local
// views describe the fields we read, narrowed once per case rather than inline.
interface RaiseParams {
  event: AnyEventObject;
  id?: string;
  delay?: number;
}
interface SendToParams extends RaiseParams {
  to?: unknown;
  targetId?: string;
}
interface CancelParams {
  sendId: string;
}
/** A child entry as it appears on a snapshot's `children` map. */
interface ChildRef {
  id?: string;
  logic?: unknown;
  src?: unknown;
  options?: { input?: unknown };
}
/** A `sendTo` target given as an actor ref rather than a string id. */
interface RefLike {
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

// resolveState drops live children; re-inject stub refs for known children so
// sendTo/forwardTo targeting them resolve to routable actions.
function injectStubChildren(
  snapshot: AnyMachineSnapshot,
  knownChildIds: readonly string[],
): void {
  const children = snapshot.children as Record<string, unknown>;
  for (const childId of knownChildIds) {
    children[childId] ??= stubChildRef(childId);
  }
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
  const effects = stopActorEffects(actions, activeChildren, activePromises);
  effects.push(
    ...startActorEffects(snapshot, actions, activeChildren, activePromises),
  );
  for (const action of actions) {
    const effect = toEffect(machine, action, activeChildren, activePromises);
    if (effect) effects.push(effect);
  }
  return effects;
}

/** Stop persisted actors before considering starts in the next snapshot. */
function stopActorEffects(
  actions: Action[],
  activeChildren: Set<string>,
  activePromises: Set<string>,
): Effect[] {
  const effects: Effect[] = [];
  for (const action of actions) {
    if (action.type !== "xstate.stopChild") continue;
    const childId = refId(action.params);
    if (childId === undefined) continue;
    if (activeChildren.delete(childId)) {
      effects.push({ kind: "stopChild", childId });
    } else if (activePromises.delete(childId)) {
      effects.push({ kind: "stopPromise", actorId: childId });
    }
  }
  return effects;
}

/** Collect newly spawned actors, including assign-spawn (which emits no action). */
function startActorEffects(
  snapshot: AnyMachineSnapshot,
  actions: Action[],
  activeChildren: Set<string>,
  activePromises: Set<string>,
): Effect[] {
  const spawnParams = new Map<string, SpawnParams>();
  for (const action of actions) {
    if (action.type === "xstate.spawnChild") {
      const params = action.params as SpawnParams;
      spawnParams.set(params.id, params);
    }
  }

  const effects: Effect[] = [];
  for (const [childId, value] of Object.entries(snapshot.children)) {
    const ref = value as ChildRef | undefined;
    const logic = ref?.logic;
    const params = spawnParams.get(childId);
    const input = params ? params.input : ref?.options?.input;

    if (isMachine(logic)) {
      if (!activeChildren.has(childId)) {
        effects.push({
          kind: "startChild",
          childId,
          machineId: logic.id,
          input,
        });
      }
      activeChildren.add(childId);
      continue;
    }

    // XState does not emit xstate.spawnChild when spawn() is used inside
    // assign(). Reconstruct the request from the live ref before it is removed
    // by snapshot serialization.
    if (!params && ref && (ref.src !== undefined || logic !== undefined)) {
      effects.push({
        kind: "runPromise",
        params: {
          id: childId,
          src: ref.src ?? logic,
          input,
        },
      });
      activePromises.add(childId);
    }
  }
  return effects;
}

/** Translate one executable action into an Effect (or none). */
function toEffect(
  machine: AnyStateMachine,
  action: Action,
  activeChildren: Set<string>,
  activePromises: Set<string>,
): Effect | undefined {
  switch (action.type) {
    case "xstate.spawnChild": {
      const params = action.params as SpawnParams;
      // machine children are started separately; only promise/plain actors here
      if (activeChildren.has(params.id) || activePromises.has(params.id)) {
        return undefined;
      }
      activePromises.add(params.id);
      return { kind: "runPromise", params };
    }
    case "xstate.raise": {
      const { event, id, delay } = action.params as RaiseParams;
      // A raise without a delay is drained inside the macrostep. An explicit
      // delay of zero is still scheduled by XState and must not be dropped.
      return delay !== undefined
        ? scheduleSend(id, { type: "self" }, event, delay)
        : undefined;
    }
    case "xstate.sendTo": {
      const params = action.params as SendToParams;
      const target = targetOf(machine, params, activeChildren);
      if (!target) return undefined;
      return params.delay !== undefined
        ? scheduleSend(params.id, target, params.event, params.delay)
        : { kind: "send", target, event: params.event };
    }
    case "xstate.cancel": {
      const { sendId } = action.params as CancelParams;
      return { kind: "cancel", sendId };
    }
    case "xstate.stopChild":
      return undefined;
    default:
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

function targetOf(
  machine: AnyStateMachine,
  params: SendToParams,
  activeChildren: ReadonlySet<string>,
): Target | undefined {
  const to = params.to;
  if (params.targetId !== undefined) {
    return params.targetId === PARENT_ID
      ? { type: "parent" }
      : { type: "child", childId: params.targetId };
  }
  if (typeof to === "string") {
    return to === PARENT_ID
      ? { type: "parent" }
      : { type: "child", childId: to };
  }

  const ref = to as RefLike | undefined;
  if (ref?.id !== undefined && activeChildren.has(ref.id)) {
    return { type: "child", childId: ref.id };
  }
  return ref?.logic === machine ? { type: "self" } : undefined;
}

function refId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const ref = value as RefLike & { actorRef?: RefLike };
  return typeof ref.id === "string" ? ref.id : ref.actorRef?.id;
}
