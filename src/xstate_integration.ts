import {
  createActor,
  toPromise,
  type AnyStateMachine,
  type DoneActorEvent,
  type ErrorActorEvent,
  type EventFrom,
  type ExecutableActionsFrom,
  type ExecutableSpawnAction,
  type InvokeConfig,
} from "xstate";

import type { ExecuteActionRequest, ActionDispatcher } from "./types";
import { ExecutableSendToAction } from "xstate/dist/declarations/src/actions/send";
import { resolveReferencedActor } from "./resolveReferencedActor";

function createDoneActorEvent(
  invokeId: string,
  output?: unknown
): DoneActorEvent {
  return {
    type: `xstate.done.actor.${invokeId}`,
    output,
    actorId: invokeId,
  };
}

function createErrorActorEvent(
  invokeId: string,
  error: unknown
): ErrorActorEvent {
  return {
    type: `xstate.error.actor.${invokeId}`,
    error,
    actorId: invokeId,
  };
}

// --------------------------------------------------------
// interpret an action
// --------------------------------------------------------

export async function dispatchAction<M extends AnyStateMachine>(
  self: ActionDispatcher<M>,
  action: ExecutableActionsFrom<M>
) {
  console.log("Executing action", action);
  switch (action.type) {
    case "xstate.spawnChild": {
      const spawnAction = action as ExecutableSpawnAction;
      const targetId = await self.resolveSpawnAMachine(spawnAction);
      if (targetId) {
        self.init(targetId, (spawnAction.params as any).input);
      } else {
        self.dispatchExecuteAction(self.id, spawnAction);
      }
      break;
    }
    case "xstate.sendTo": {
      const sendToAction = action as ExecutableSendToAction;

      const logic = await self.resolveSendTarget(sendToAction);
      console.log(sendToAction, logic);
      self.dispatchEvent(
        logic.id,
        action.params.event as EventFrom<M>,
        action.params.delay
      );
      break;
    }
    case "xstate.raise": {
      if (action.params.delay) {
        self.dispatchEvent(
          self.id,
          action.params.event as EventFrom<M>,
          action.params.delay
        );
      } else {
        // TODO:
        console.log("Raising event without delay");
      }
      break;
    }
    default: {
      break;
    }
  }
}

export const doExecuteAction = async <M extends AnyStateMachine>(
  machine: M,
  action: ExecuteActionRequest
): Promise<DoneActorEvent | ErrorActorEvent | void> => {
  const params = action.params;
  let targetLogic: AnyStateMachine;
  if ("src" in params) {
    targetLogic =
      typeof params.src === "string"
        ? resolveReferencedActor(machine, params.src)
        : params.src;
  } else {
    targetLogic = machine;
  }

  //assert("transition" in logic);
  try {
    const output = await toPromise(createActor(targetLogic, params).start());
    if (action.type === "xstate.spawnChild") {
      return createDoneActorEvent(action.params.id, output);
    }
  } catch (err) {
    if (action.type === "xstate.spawnChild") {
      return createErrorActorEvent(action.params.id, err);
    }
  }
};
