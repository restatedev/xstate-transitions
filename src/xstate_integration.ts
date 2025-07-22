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

function createDoneActorEvent(
  invokeId: string,
  output?: unknown,
): DoneActorEvent {
  return {
    type: `xstate.done.actor.${invokeId}`,
    output,
    actorId: invokeId,
  };
}

function createErrorActorEvent(
  invokeId: string,
  error: unknown,
): ErrorActorEvent {
  return {
    type: `xstate.error.actor.${invokeId}`,
    error,
    actorId: invokeId,
  };
}

function resolveReferencedActor(machine: AnyStateMachine, src: string) {
  const match = src.match(/^xstate\.invoke\.(\d+)\.(.*)/)!;
  if (!match) {
    return machine.implementations.actors[src];
  }
  const [, indexStr, nodeId] = match;
  const node = machine.getStateNodeById(nodeId);
  const invokeConfig = node.config.invoke!;
  return (
    Array.isArray(invokeConfig)
      ? invokeConfig[indexStr as any]
      : (invokeConfig as InvokeConfig<
          any,
          any,
          any,
          any,
          any,
          any,
          any, // TEmitted
          any // TMeta
        >)
  ).src;
}

// --------------------------------------------------------
// interpret an action
// --------------------------------------------------------

export function dispatchAction<M extends AnyStateMachine>(
  self: ActionDispatcher<M>,
  action: ExecutableActionsFrom<M>,
) {
  console.log("Executing action", action);
  switch (action.type) {
    case "xstate.spawnChild": {
      const spawnAction = action as ExecutableSpawnAction;
      self.dispatchExecuteAction({
        params: spawnAction.params,
      });
      break;
    }
    case "xstate.raise": {
      if (action.params.delay) {
        self.dispatchEvent(
          action.params.event as EventFrom<M>,
          action.params.delay,
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
  action: ExecuteActionRequest,
): Promise<DoneActorEvent | ErrorActorEvent> => {
  const params = action.params;
  const logic =
    typeof params.src === "string"
      ? resolveReferencedActor(machine, params.src)
      : params.src;

  //assert("transition" in logic);
  try {
    const output = await toPromise(createActor(logic, params).start());
    return createDoneActorEvent(params.id, output);
  } catch (err) {
    return createErrorActorEvent(params.id, err);
  }
};
