import type {
  AnyStateMachine,
  EventFrom,
  ExecutableActionsFrom,
  ExecutableSpawnAction,
  InputFrom,
  Snapshot,
} from "xstate";
import type { ObjectOptions } from "@restatedev/restate-sdk";
import { ExecutableSendToAction } from "xstate/dist/declarations/src/actions/send";

export type MachineObjectOptions = {
  machines?: AnyStateMachine[];
} & ObjectOptions;

export type ExecuteActionRequest = ExecutableActionsFrom<AnyStateMachine>;

export type MachineVirtualObject<M extends AnyStateMachine> = {
  create: (
    context: any,
    param: { input: InputFrom<M>; machineId?: string }
  ) => Promise<void>;
  send: (
    context: any,
    param: { event: EventFrom<M>; machineId?: string }
  ) => Promise<void>;
  snapshot: (context: any) => Promise<Snapshot<M>>;
  _execute: (
    context: any,
    param: { action: ExecuteActionRequest; machineId: string }
  ) => Promise<void>;
  _register: (
    context: any,
    param: { actorId: string; machineId: string }
  ) => Promise<void>;
};

export interface ActionDispatcher<M extends AnyStateMachine> {
  id: string;
  init: (targetMachineId: string, input: InputFrom<M>) => void;
  dispatchExecuteAction: (
    targetMachineId: string,
    action: ExecuteActionRequest
  ) => void;
  dispatchEvent: (
    targetMachineId: string,
    event: EventFrom<M>,
    delay?: number
  ) => void;
  resolveSendTarget: (
    action: ExecutableSendToAction
  ) => Promise<AnyStateMachine>;
  resolveSpawnAMachine: (
    action: ExecutableSpawnAction
  ) => Promise<string | undefined>;
}
