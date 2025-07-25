import {
  type AnyStateMachine,
  type SnapshotFrom,
  type InputFrom,
  type EventFrom,
  initialTransition,
  transition,
  Snapshot,
  ExecutableSpawnAction,
} from "xstate";

import * as restate from "@restatedev/restate-sdk";
import type {
  ExecuteActionRequest,
  MachineVirtualObject,
  ActionDispatcher,
  MachineObjectOptions,
} from "./types";
import { dispatchAction, doExecuteAction } from "./xstate_integration";
import { actorKey, machineStateKey, resolveMachine } from "./utils";
import { ExecutableSendToAction } from "xstate/dist/declarations/src/actions/send";
import { resolveReferencedActor } from "./resolveReferencedActor";

// --------------------------------------------------------
// utils
// --------------------------------------------------------

function actionDispatcher<P extends string, M extends AnyStateMachine>(
  sourceMachineId: string,
  name: P,
  context: restate.ObjectSharedContext,
  machines?: AnyStateMachine[]
): ActionDispatcher<M> {
  const self = { name } as restate.VirtualObjectDefinition<
    string,
    MachineVirtualObject<M>
  >;

  return {
    id: sourceMachineId,
    dispatchExecuteAction: (
      targetMachineId: string,
      action: ExecuteActionRequest
    ) => {
      context.objectSendClient(self, context.key)._register({
        actorId: action.info.self.id,
        machineId: sourceMachineId,
      });
      context
        .objectSendClient(self, context.key)
        ._execute({ action, machineId: targetMachineId });
    },
    dispatchEvent: (
      targetMachineId: string,
      event: EventFrom<M>,
      delay?: number
    ) => {
      context
        .objectSendClient(self, context.key)
        .send(
          { event, machineId: targetMachineId },
          restate.rpc.sendOpts({ delay })
        );
    },
    init: (targetMachineId: string, input: InputFrom<M>) => {
      console.log("targetMachineId", targetMachineId);

      context
        .objectSendClient(self, context.key)
        .create({ input, machineId: targetMachineId });
    },
    resolveSendTarget: async (sendToAction: ExecutableSendToAction) => {
      const logic =
        typeof sendToAction.params.to === "string"
          ? sendToAction.info.self.getSnapshot().children[
              sendToAction.params.to
            ]?.src
          : typeof sendToAction.params.to === "object"
            ? String(await context.get(actorKey(sendToAction.params.to.id)))
            : sendToAction.params.to;

      if (!logic) {
        throw new restate.TerminalError(
          "Cannot resolve send action target" + sendToAction.params.to
        );
      }
      if (typeof logic === "string") {
        return resolveMachine(logic, machines);
      }
      // TODO: Fix type casting
      return logic as AnyStateMachine;
    },
    resolveSpawnAMachine: async (spawnAction: ExecutableSpawnAction) => {
      console.log(machines, spawnAction.params.src);
      if (
        spawnAction.info.event.type === "xstate.init" &&
        typeof spawnAction.params.src === "string"
      ) {
        const machine = machines?.find(({ id }) => id === sourceMachineId);
        const targetMachine = resolveReferencedActor(
          machine!,
          spawnAction.params.src
        );
        if (!targetMachine?.id) {
          return false;
        }

        if (
          !(await context.get(targetMachine.id)) &&
          machines?.some(({ id }) => id === targetMachine.id)
        ) {
          return targetMachine.id;
        }
      }
      return undefined;
    },
  };
}

export function createMachineObject<
  P extends string,
  M extends AnyStateMachine,
>(
  name: P,
  machine: M,
  options?: MachineObjectOptions
): restate.VirtualObjectDefinition<P, MachineVirtualObject<M>> {
  console.log("options", options);
  return restate.object({
    name,
    handlers: {
      /**
       * Create a new instance of the machine
       *
       * @param context restate context
       * @param input input for the machine
       */
      create: async (
        context: restate.ObjectContext,
        { input, machineId }: { input: InputFrom<M>; machineId?: string }
      ) => {
        const source = machineId
          ? resolveMachine(machineId, options?.machines)
          : machine;
        const [state, actions] = initialTransition(source, input);

        context.set(machineStateKey(source.id), state);
        context.set(source.id, true);

        const self = actionDispatcher(
          source.id,
          name,
          context,
          options?.machines
        );
        console.log("create", input, machineId, actions, state);
        for (const action of actions) {
          await dispatchAction(self, action);
        }
      },

      /**
       * Send an event to the machine
       *
       * @param context restate context
       * @param param.event - input event for the machine
       * @param param.machineId - the machine id.
       */
      send: async (
        context: restate.ObjectContext,
        { event, machineId }: { event: EventFrom<M>; machineId?: string }
      ) => {
        const source = machineId
          ? resolveMachine(machineId, options?.machines)
          : machine;
        const state: any =
          (await context.get(machineStateKey(source.id))) ?? {};

        const snapshot = source.resolveState(state) as SnapshotFrom<M>;
        try {
          const [nextState, actions] = transition(source, snapshot, event);

          context.set(machineStateKey(source.id), nextState);
          const self = actionDispatcher(
            source.id,
            name,
            context,
            options?.machines
          );
          for (const action of actions) {
            await dispatchAction(self, action);
          }
        } catch (error) {
          console.log("-----", error);
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
       * @param param.action the action to execute
       * @param param.machineId - the machine id.
       */
      _execute: restate.handlers.object.shared(
        { ingressPrivate: true, enableLazyState: true },
        async (
          context: restate.ObjectSharedContext,
          {
            action,
            machineId,
          }: { action: ExecuteActionRequest; machineId?: string }
        ) => {
          const source = machineId
            ? resolveMachine(machineId, options?.machines)
            : machine;
          console.log("execute", source, action);
          const result = await doExecuteAction(source, action);
          const self = actionDispatcher(
            source.id,
            name,
            context,
            options?.machines
          );
          self.dispatchEvent(source.id, result);
        }
      ),

      /**
       * registers and actorId against its associated machine id
       * @param context restate context
       * @param param.actorId the actor id
       * @param param.machineId - the machine id.
       */
      _register: restate.handlers.object.exclusive(
        { ingressPrivate: true, enableLazyState: true },
        async (
          context: restate.ObjectContext,
          { actorId, machineId }: { actorId: string; machineId?: string }
        ) => {
          context.set(actorKey(actorId), machineId);
        }
      ),

      snapshot: async (
        context: restate.ObjectContext
      ): Promise<Snapshot<M>> => {
        const state: any =
          (await context.get(machineStateKey(machine.id))) ?? {};
        const snapshot = machine.resolveState(state) as SnapshotFrom<M>;
        return snapshot;
      },
    } satisfies MachineVirtualObject<M>,
    options,
  });
}
