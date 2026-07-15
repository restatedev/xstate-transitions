import { createActor, initialTransition, transition } from "xstate";
import type { AnyStateMachine, AnyMachineSnapshot } from "xstate";
import type { Action } from "./types";

// ---------------------------------------------------------------------------
// This module groups all the "fake" actor plumbing needed to drive a machine
// through XState's PURE transition API in a stateless setting:
//   - FAKE_PARENT: a stand-in parent ref so `sendParent` resolves to an action
//     instead of throwing.
//   - stubChildRef: stand-in child refs (re-injected after resolveState drops
//     live children) so `sendTo`/`forwardTo` targeting a child resolve.
//   - runInitial / runTransition: pure transition entry points, using a
//     parent-aware actor scope for child machines.
// None of this imports Restate; it is all pure XState.
//
// The casts here reach into xstate internals that its public types do not
// expose. The shapes we touch are named below so the reaches are explicit.
// ---------------------------------------------------------------------------

/** xstate's SpecialTargets.Parent id — the `to`/`targetId` of a sendParent action. */
export const PARENT_ID = "#_parent";

/** The subset of a live actor we mutate/read when building a parent-aware scope. */
interface MutableActor {
  _parent: unknown;
  system: { _sendInspectionEvent: () => void };
}

/** The inert actor scope xstate's transition functions expect. */
interface ActorScope {
  self: MutableActor;
  system: unknown;
  actionExecutor: (action: Action) => void;
  defer: () => void;
  id: string;
  logger: () => void;
  sessionId: string;
  stopChild: () => void;
  emit: () => void;
}

/** The internals of a machine we drive directly with a custom scope. */
interface MachineInternals {
  getInitialSnapshot: (scope: ActorScope, input: unknown) => AnyMachineSnapshot;
  transition: (
    snapshot: AnyMachineSnapshot,
    event: unknown,
    scope: ActorScope,
  ) => AnyMachineSnapshot;
}

const internalsOf = (machine: AnyStateMachine): MachineInternals =>
  machine as unknown as MachineInternals;

// The pure transition() API builds an inert scope with no parent, so
// `sendParent`/`sendTo(parent)` would throw ("Unable to send event to actor
// '#_parent'"). Giving the throwaway actor a fake `_parent` makes XState resolve
// those into ordinary `xstate.sendTo` actions (targetId #_parent) that the
// integration routes to the parent object. Its identity is otherwise unused.
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

/**
 * A minimal stand-in for a child actor ref. `resolveState` drops live children,
 * so before transitioning we re-inject one of these per persisted child so that
 * `sendTo`/`forwardTo` targeting the child resolves to a routable action instead
 * of throwing. Only its `id` is used (for routing); it is never run.
 */
export function stubChildRef(id: string): unknown {
  return {
    id,
    sessionId: id,
    send: () => {},
    _send: () => {},
    getSnapshot: () => undefined,
    on: () => ({ unsubscribe: () => {} }),
    _parent: undefined,
    _processingStatus: 1,
  };
}

/** Build an inert scope whose actor has a fake parent, collecting emitted actions. */
function parentScope(
  machine: AnyStateMachine,
  sink: (action: Action) => void,
): ActorScope {
  const self = createActor(machine) as unknown as MutableActor;
  self._parent = FAKE_PARENT;
  self.system._sendInspectionEvent = () => {};
  return {
    self,
    system: self.system,
    actionExecutor: sink,
    defer: () => {},
    id: "",
    logger: () => {},
    sessionId: "",
    stopChild: () => {},
    emit: () => {},
  };
}

/**
 * Compute the initial transition. For a child machine, uses a parent-aware scope
 * so entry `sendParent` actions resolve; for a root, uses xstate's built-in.
 */
export function runInitial(
  machine: AnyStateMachine,
  input: unknown,
  asChild: boolean,
): [AnyMachineSnapshot, Action[]] {
  if (!asChild) {
    return initialTransition(machine, input) as [AnyMachineSnapshot, Action[]];
  }
  const actions: Action[] = [];
  const scope = parentScope(machine, (action) => actions.push(action));
  const snapshot = internalsOf(machine).getInitialSnapshot(scope, input);
  return [snapshot, actions];
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
  if (!asChild) {
    return transition(machine, snapshot, event as never) as [
      AnyMachineSnapshot,
      Action[],
    ];
  }
  const actions: Action[] = [];
  const scope = parentScope(machine, (action) => actions.push(action));
  const next = internalsOf(machine).transition(snapshot, event, scope);
  return [next, actions];
}
