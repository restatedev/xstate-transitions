import {
  createActor,
  initialTransition,
  transition,
  type AnyStateMachine,
  type AnyMachineSnapshot,
} from "xstate";

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
// ---------------------------------------------------------------------------

/** xstate's SpecialTargets.Parent id — the `to`/`targetId` of a sendParent action. */
export const PARENT_ID = "#_parent";

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

type Action = { type: string; params: Record<string, unknown> };

function parentScope(
  logic: AnyStateMachine,
  sink: (a: Action) => void,
): unknown {
  const self = createActor(logic) as unknown as {
    _parent: unknown;
    system: unknown;
  };
  self._parent = FAKE_PARENT;
  const scope = {
    self,
    defer: () => {},
    id: "",
    logger: () => {},
    sessionId: "",
    stopChild: () => {},
    system: self.system,
    emit: () => {},
    actionExecutor: (action: Action) => sink(action),
  };
  (scope.system as { _sendInspectionEvent: () => void })._sendInspectionEvent =
    () => {};
  return scope;
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
  const scope = parentScope(machine, (a) => actions.push(a));
  const snapshot = (
    machine as unknown as {
      getInitialSnapshot: (s: unknown, i: unknown) => AnyMachineSnapshot;
    }
  ).getInitialSnapshot(scope, input);
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
  const scope = parentScope(machine, (a) => actions.push(a));
  const next = (
    machine as unknown as {
      transition: (s: unknown, e: unknown, sc: unknown) => AnyMachineSnapshot;
    }
  ).transition(snapshot, event, scope);
  return [next, actions];
}
