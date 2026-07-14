import type { AnyStateMachine, AnyEventObject } from "xstate";
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

type Action = { type: string; params: Record<string, unknown> };

function targetOf(params: Record<string, unknown>): Target | undefined {
  const to = params.to;
  const targetId =
    (params.targetId as string | undefined) ??
    (typeof to === "string" ? to : (to as { id?: string } | undefined)?.id);
  if (targetId === undefined) return undefined;
  if (targetId === PARENT_ID) return { type: "parent" };
  return { type: "child", childId: targetId };
}

function interpretActions(
  snapshot: { children?: Record<string, { logic?: unknown } | undefined> },
  actions: Action[],
  knownChildIds: readonly string[],
): Effect[] {
  const effects: Effect[] = [];
  const started = new Set(knownChildIds);

  const spawnInputs: Record<string, unknown> = {};
  for (const action of actions) {
    if (action.type === "xstate.spawnChild") {
      spawnInputs[action.params.id as string] = action.params.input;
    }
  }

  // Reconcile child MACHINE actors (covers both invoke and assign-spawn).
  for (const [childId, ref] of Object.entries(snapshot.children ?? {})) {
    if (started.has(childId)) continue;
    const logic = ref?.logic;
    if (!isMachine(logic)) continue;
    started.add(childId);
    effects.push({
      kind: "startChild",
      childId,
      machineId: logic.id,
      input: spawnInputs[childId],
    });
  }

  for (const action of actions) {
    switch (action.type) {
      case "xstate.spawnChild": {
        // machine children are started above; only promise/plain actors run here
        if (!started.has(action.params.id as string)) {
          effects.push({
            kind: "runPromise",
            params: action.params as SpawnParams,
          });
        }
        break;
      }
      case "xstate.raise": {
        if (action.params.delay) {
          effects.push({
            kind: "scheduleSend",
            sendId: action.params.id as string,
            target: { type: "self" },
            event: action.params.event as AnyEventObject,
            delay: action.params.delay as number,
          });
        }
        // zero-delay raises are already drained inside the macrostep
        break;
      }
      case "xstate.sendTo": {
        const target = targetOf(action.params);
        if (!target) break;
        const event = action.params.event as AnyEventObject;
        if (action.params.delay) {
          effects.push({
            kind: "scheduleSend",
            sendId: action.params.id as string,
            target,
            event,
            delay: action.params.delay as number,
          });
        } else {
          effects.push({ kind: "send", target, event });
        }
        break;
      }
      case "xstate.cancel": {
        effects.push({
          kind: "cancel",
          sendId: action.params.sendId as string,
        });
        break;
      }
      default:
        break;
    }
  }

  return effects;
}

/** Compute the next persisted state and the effects to execute. Pure. */
export function step(machine: AnyStateMachine, input: StepInput): Step {
  let snapshot;
  let actions: Action[];

  if (input.stored == null) {
    [snapshot, actions] = runInitial(machine, input.input, input.isChild);
  } else {
    const rehydrated = fromStored(machine, input.stored) as {
      children: Record<string, unknown>;
    };
    // Re-inject stub child refs (dropped by resolveState) so sendTo/forwardTo resolve.
    for (const childId of input.knownChildIds) {
      if (!rehydrated.children[childId]) {
        rehydrated.children[childId] = stubChildRef(childId);
      }
    }
    [snapshot, actions] = runTransition(
      machine,
      rehydrated as never,
      input.event,
      input.isChild,
    );
  }

  const effects = interpretActions(
    snapshot as { children?: Record<string, { logic?: unknown }> },
    actions,
    input.knownChildIds,
  );

  return {
    nextState: toStored(snapshot),
    returned: toReturnedSnapshot(snapshot),
    effects,
  };
}
