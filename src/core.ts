import {
  type AnyStateMachine,
  type SnapshotFrom,
  type InputFrom,
  type EventFrom,
  initialTransition,
  transition,
  Snapshot,
} from "xstate";

import * as restate from "@restatedev/restate-sdk";
import type { ExecuteActionRequest, MachineVirtualObject, ActionDispatcher, MachineObjectOptions } from "./types";
import { dispatchAction, doExecuteAction } from "./xstate_integration";

// --------------------------------------------------------
// utils 
// --------------------------------------------------------

function actionDispatcher<P extends string, M extends AnyStateMachine>(
  name: P,
  context: restate.ObjectSharedContext
): ActionDispatcher<M> {
  const self = { name } as restate.VirtualObjectDefinition<
    string,
    MachineVirtualObject<M>
  >;

  return {
    dispatchExecuteAction: (action: ExecuteActionRequest) => {
      context.objectSendClient(self, context.key)._execute(action);
    },
    dispatchEvent: (event: EventFrom<M>, delay?: number) => {
      context
        .objectSendClient(self, context.key)
        .send(event, restate.rpc.sendOpts({ delay }));
    },
  };
}

export function createMachineObject<P extends string, M extends AnyStateMachine>(
  name: P,
  machine: M,
  options?: MachineObjectOptions
): restate.VirtualObjectDefinition<P, MachineVirtualObject<M>> {
  return restate.object({
    name,
    handlers: {
      /**
       * Create a new instance of the machine
       *
       * @param context restate context
       * @param input input for the machine
       */
      create: async (context: restate.ObjectContext, input: InputFrom<M>) => {
        const [state, actions] = initialTransition(machine, input);

        context.set("state", state);

        const self = actionDispatcher(name, context);
        for (const action of actions) {
          dispatchAction(self, action);
        }
      },

      /**
       * Send an event to the machine
       *
       * @param context restate context
       * @param event input event for the machine
       */
      send: async (context: restate.ObjectContext, event: EventFrom<M>) => {
        const state: any = (await context.get("state")) ?? {};
        const snapshot = machine.resolveState(state) as SnapshotFrom<M>;
        const [nextState, actions] = transition(machine, snapshot, event);

        context.set("state", nextState);

        const self = actionDispatcher(name, context);
        for (const action of actions) {
          dispatchAction(self, action);
        }
      },

      /**
       * Execute an action that was emitted by the machine as part of
       * a transition. This is a shared handler so that actions can be executed
       * in parallel for a given machine instance.
       * Once the action completes (either successfully or with an error),
       * the result is sent back to the machine instance.
       *
       * @param context restate context
       * @param action the action to execute
       */
      _execute: restate.handlers.object.shared(
        { ingressPrivate: true, enableLazyState: true },
        async (
          context: restate.ObjectSharedContext,
          action: ExecuteActionRequest
        ) => {
          const result = await doExecuteAction(machine, action);
          const self = actionDispatcher(name, context);
          self.dispatchEvent(result);
        }
      ),

      snapshot: async (context: restate.ObjectContext): Promise<Snapshot<M>> => {
        const state: any = (await context.get("state")) ?? {};
        const snapshot = machine.resolveState(state) as SnapshotFrom<M>;
        return snapshot;
      },
    } satisfies MachineVirtualObject<M>,
    options,
  });
}



