import type {
  AnyStateMachine,
  AnyMachineSnapshot,
  AnyEventObject,
} from "xstate";
import {
  toStored,
  fromStored,
  toReturnedSnapshot,
  type StoredState,
  type ReturnedSnapshot,
} from "./snapshot";
import { runInitial, runTransition, stubChildRef, PARENT_ID } from "./scope";
import { isMachine } from "./registry";

// ---------------------------------------------------------------------------
// The pure heart of the integration. Given a machine, its persisted state, and
// an event, `step` computes the next persisted state plus a list of abstract
// Effects — spawn a child, run a promise actor, route/schedule/cancel an event.
// It has NO Restate dependency and is fully unit-testable with plain objects.
// The Restate layer is responsible for EXECUTING these effects.
// ---------------------------------------------------------------------------

/** Where a routed event is delivered. */
export type Target =
  { type: "self" } | { type: "child"; childId: string } | { type: "parent" };

/** The spawn action params carried to the actor runner. */
export interface SpawnParams {
  id: string;
  src?: unknown;
  input?: unknown;
  [k: string]: unknown;
}

/** Something the machine wants done, described independently of Restate. */
export type Effect =
  | { kind: "runPromise"; params: SpawnParams }
  | { kind: "startChild"; childId: string; machineId: string; input: unknown }
  | { kind: "send"; target: Target; event: AnyEventObject }
  | {
      kind: "scheduleSend";
      sendId: string;
      target: Target;
      event: AnyEventObject;
      delay: number;
    }
  | { kind: "cancel"; sendId: string };

export interface StepInput {
  /** Persisted state to resume from; `null` for the initial transition. */
  stored: StoredState | null;
  /** The event to apply (omit for the initial transition). */
  event?: AnyEventObject;
  /** Input for the initial transition. */
  input?: unknown;
  /** Whether this instance is a child (drives parent-aware sendParent). */
  isChild: boolean;
  /** Ids of children already started (to avoid re-starting them). */
  knownChildIds: readonly string[];
}

export interface Step {
  nextState: StoredState;
  returned: ReturnedSnapshot;
  effects: Effect[];
}

// The executable actions xstate emits carry loosely-typed params; these describe
// the shapes we read, narrowed once per case rather than inline.
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

interface Action {
  type: string;
  params: Record<string, unknown>;
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
    (typeof to === "string" ? to : (to as { id?: string } | undefined)?.id);
  if (targetId === undefined) return undefined;
  return targetId === PARENT_ID
    ? { type: "parent" }
    : { type: "child", childId: targetId };
}

function interpretActions(
  snapshot: AnyMachineSnapshot,
  actions: Action[],
  knownChildIds: readonly string[],
): Effect[] {
  const effects: Effect[] = [];
  const started = new Set(knownChildIds);

  const spawnInputs = new Map<string, unknown>();
  for (const action of actions) {
    if (action.type === "xstate.spawnChild") {
      const params = action.params as SpawnParams;
      spawnInputs.set(params.id, params.input);
    }
  }

  // Reconcile child MACHINE actors (covers both invoke and assign-spawn).
  for (const [childId, ref] of Object.entries(snapshot.children)) {
    if (started.has(childId)) continue;
    const logic = (ref as { logic?: unknown } | undefined)?.logic;
    if (!isMachine(logic)) continue;
    started.add(childId);
    effects.push({
      kind: "startChild",
      childId,
      machineId: logic.id,
      input: spawnInputs.get(childId),
    });
  }

  for (const action of actions) {
    switch (action.type) {
      case "xstate.spawnChild": {
        const params = action.params as SpawnParams;
        // machine children are started above; only promise/plain actors run here
        if (!started.has(params.id)) {
          effects.push({ kind: "runPromise", params });
        }
        break;
      }
      case "xstate.raise": {
        const { event, id, delay } = action.params as unknown as RaiseParams;
        // zero-delay raises are already drained inside the macrostep
        if (delay)
          effects.push(scheduleSend(id, { type: "self" }, event, delay));
        break;
      }
      case "xstate.sendTo": {
        const params = action.params as unknown as SendToParams;
        const target = targetOf(params);
        if (!target) break;
        effects.push(
          params.delay
            ? scheduleSend(params.id, target, params.event, params.delay)
            : { kind: "send", target, event: params.event },
        );
        break;
      }
      case "xstate.cancel": {
        const { sendId } = action.params as unknown as CancelParams;
        effects.push({ kind: "cancel", sendId });
        break;
      }
      default:
        break;
    }
  }

  return effects;
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

/** Compute the next persisted state and the effects to execute. Pure. */
export function step(machine: AnyStateMachine, input: StepInput): Step {
  let snapshot: AnyMachineSnapshot;
  let actions: Action[];

  if (input.stored == null) {
    [snapshot, actions] = runInitial(machine, input.input, input.isChild);
  } else {
    snapshot = fromStored(machine, input.stored);
    injectStubChildren(snapshot, input.knownChildIds);
    [snapshot, actions] = runTransition(
      machine,
      snapshot,
      input.event,
      input.isChild,
    );
  }

  return {
    nextState: toStored(snapshot),
    returned: toReturnedSnapshot(snapshot),
    effects: interpretActions(snapshot, actions, input.knownChildIds),
  };
}
