import type { AnyStateMachine, EventFrom, InputFrom } from "xstate";
import type {
  ObjectContext,
  VirtualObjectDefinition,
  ObjectOptions,
} from "@restatedev/restate-sdk";
import type { ReturnedSnapshot, SpawnParams } from "../xstate/types";

export type MachineObjectOptions = {
  /**
   * If set, an instance is disposed this many milliseconds after it reaches a
   * final state. After disposal, all handlers reject with a 410 TerminalError.
   */
  finalStateTTL?: number;
} & ObjectOptions;

/** Payload of the internal `_execute` handler (runs an invoked/spawned actor). */
export interface ExecuteRequest {
  params: SpawnParams;
}

/** Payload of the internal `_scheduled` handler (delivers a delayed event). */
export interface ScheduledEvent {
  sendId: string;
  uuid: string;
}

/** Persisted record of a pending delayed delivery, keyed by sendId. */
export interface ScheduledDelivery {
  uuid: string;
  targetKey: string;
  event: unknown;
}

/** Payload of the internal `_init` handler (initializes a child instance). */
export interface InitRequest {
  machineId: string;
  parentKey: string;
  invokeId: string;
  input?: unknown;
}

/** Persisted record of a spawned/invoked child, keyed by child id. */
export interface ChildRecord {
  key: string;
  machineId: string;
}

/** Persisted set of awakeables waiting on a single condition. */
export interface Subscription {
  awakeables: string[];
}

export interface SubscribeRequest {
  condition: string;
  awakeableId: string;
}

export interface WaitForRequest<M extends AnyStateMachine = AnyStateMachine> {
  condition: string;
  timeout?: number;
  event?: EventFrom<M>;
}

export type MachineVirtualObject<M extends AnyStateMachine> = {
  create: (context: any, input: InputFrom<M>) => Promise<void>;
  send: (context: any, event: EventFrom<M>) => Promise<void>;
  snapshot: (context: any) => Promise<ReturnedSnapshot>;
  waitFor: (
    context: any,
    request: WaitForRequest<M>,
  ) => Promise<ReturnedSnapshot>;
  subscribe: (context: any, request: SubscribeRequest) => Promise<void>;
  executeActor: (context: any, request: ExecuteRequest) => Promise<void>;
  deliverScheduled: (context: any, request: ScheduledEvent) => Promise<void>;
  initChild: (context: any, request: InitRequest) => Promise<void>;
  cleanupState: (context: any) => Promise<void>;
};

/** A reference to this virtual object's definition, used to build clients. */
export type MachineDefinition = VirtualObjectDefinition<
  string,
  MachineVirtualObject<AnyStateMachine>
>;

/** The bundle of state an effect executor needs to act against Restate. */
export interface HandlerCtx {
  ctx: ObjectContext;
  self: MachineDefinition;
  /** Set only for a child instance: the parent's object key. */
  parentKey?: string;
  /** Set only for a child instance: the invoke/spawn id it runs under. */
  invokeId?: string;
  finalStateTTL?: number;
}
