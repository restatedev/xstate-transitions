import type {
  AnyStateMachine,
  AnyMachineSnapshot,
  AnyEventObject,
} from "xstate";
import type {
  Action,
  Target,
  SpawnParams,
  Effect,
  Step,
  InitInput,
  ResumeInput,
} from "./types";
import { toStored, toReturnedSnapshot, fromStored } from "./snapshot";
import { runInitial, runTransition, stubChildRef, PARENT_ID } from "./scope";
import { isMachine } from "./registry";

// ---------------------------------------------------------------------------
// The pure heart of the integration. Given a machine, its persisted state, and
// an event, `resumeStep`/`initialStep` compute the next persisted state plus a
// list of abstract Effects. There is NO Restate dependency here; it is fully
// unit-testable with plain objects. The Restate layer executes the effects.
// ---------------------------------------------------------------------------

// The executable actions xstate emits carry loosely-typed params. These local
// views describe the fields we read, narrowed once per case rather than inline.
interface RaiseParams {
  event: AnyEventObject;
  id: string;
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
  logic?: unknown;
}
/** A `sendTo` target given as an actor ref rather than a string id. */
interface RefLike {
  id?: string;
}

function scheduleSend(
  sendId: string,
  target: Target,
  event: AnyEventObject,
  delay: number,
): Effect {
  return { kind: "scheduleSend", sendId, target, event, delay };
}

function targetOf(params: SendToParams): Target | undefined {
  const to = params.to;
  const targetId =
    params.targetId ??
    (typeof to === "string" ? to : (to as RefLike | undefined)?.id);
  if (targetId === undefined) return undefined;
  return targetId === PARENT_ID
    ? { type: "parent" }
    : { type: "child", childId: targetId };
}

/** Translate one executable action into an Effect (or none). */
function toEffect(
  action: Action,
  started: ReadonlySet<string>,
): Effect | undefined {
  switch (action.type) {
    case "xstate.spawnChild": {
      const params = action.params as SpawnParams;
      // machine children are started separately; only promise/plain actors here
      return started.has(params.id)
        ? undefined
        : { kind: "runPromise", params };
    }
    case "xstate.raise": {
      const { event, id, delay } = action.params as unknown as RaiseParams;
      // zero-delay raises are already drained inside the macrostep
      return delay
        ? scheduleSend(id, { type: "self" }, event, delay)
        : undefined;
    }
    case "xstate.sendTo": {
      const params = action.params as unknown as SendToParams;
      const target = targetOf(params);
      if (!target) return undefined;
      return params.delay
        ? scheduleSend(params.id, target, params.event, params.delay)
        : { kind: "send", target, event: params.event };
    }
    case "xstate.cancel": {
      const { sendId } = action.params as unknown as CancelParams;
      return { kind: "cancel", sendId };
    }
    default:
      return undefined;
  }
}

/** Collect the child MACHINE actors to start (both invoke and assign-spawn). */
function startChildEffects(
  snapshot: AnyMachineSnapshot,
  actions: Action[],
  started: Set<string>,
): Effect[] {
  const spawnInputs = new Map<string, unknown>();
  for (const action of actions) {
    if (action.type === "xstate.spawnChild") {
      const params = action.params as SpawnParams;
      spawnInputs.set(params.id, params.input);
    }
  }

  const effects: Effect[] = [];
  for (const [childId, ref] of Object.entries(snapshot.children)) {
    if (started.has(childId)) continue;
    const logic = (ref as ChildRef | undefined)?.logic;
    if (!isMachine(logic)) continue;
    started.add(childId);
    effects.push({
      kind: "startChild",
      childId,
      machineId: logic.id,
      input: spawnInputs.get(childId),
    });
  }
  return effects;
}

function interpretActions(
  snapshot: AnyMachineSnapshot,
  actions: Action[],
  knownChildIds: readonly string[],
): Effect[] {
  const started = new Set(knownChildIds);
  const effects = startChildEffects(snapshot, actions, started);
  for (const action of actions) {
    const effect = toEffect(action, started);
    if (effect) effects.push(effect);
  }
  return effects;
}

function finish(
  snapshot: AnyMachineSnapshot,
  actions: Action[],
  knownChildIds: readonly string[],
): Step {
  return {
    nextState: toStored(snapshot),
    returned: toReturnedSnapshot(snapshot),
    effects: interpretActions(snapshot, actions, knownChildIds),
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

/** Start a brand-new instance from its initial transition. Pure. */
export function initialStep(machine: AnyStateMachine, input: InitInput): Step {
  const [snapshot, actions] = runInitial(machine, input.input, input.isChild);
  return finish(snapshot, actions, []);
}

/** Apply an event to an existing, persisted instance. Pure. */
export function resumeStep(machine: AnyStateMachine, input: ResumeInput): Step {
  const snapshot = fromStored(machine, input.stored);
  injectStubChildren(snapshot, input.knownChildIds);
  const [next, actions] = runTransition(
    machine,
    snapshot,
    input.event,
    input.isChild,
  );
  return finish(next, actions, input.knownChildIds);
}
