import type {
  AnyStateMachine,
  EventFrom,
  ExecutableSpawnAction,
  InputFrom,
  Snapshot,
} from "xstate";
import type { ObjectOptions } from "@restatedev/restate-sdk";

export type MachineObjectOptions = {} & ObjectOptions;

export type ExecuteActionRequest = {
  params: ExecutableSpawnAction["params"];
};

export type MachineVirtualObject<M extends AnyStateMachine> = {
  create: (context: any, input: InputFrom<M>) => Promise<void>;
  send: (context: any, event: EventFrom<M>) => Promise<void>;
  snapshot: (context: any) => Promise<Snapshot<M>>;
  _execute: (context: any, action: ExecuteActionRequest) => Promise<void>;
};

export interface ActionDispatcher<M extends AnyStateMachine> {
  dispatchExecuteAction: (action: ExecuteActionRequest) => void;
  dispatchEvent: (event: EventFrom<M>, delay?: number) => void;
}
