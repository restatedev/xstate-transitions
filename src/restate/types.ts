import type {
  ObjectContext,
  ObjectOptions,
  ObjectSharedContext,
  VirtualObjectDefinition,
} from "@restatedev/restate-sdk";
import type {
  AnyEventObject,
  AnyStateMachine,
  EventFrom,
  InputFrom,
} from "xstate";
import type { NormalizedError } from "../xstate/actors";
import type { Condition, ReturnedSnapshot, SpawnParams } from "../xstate/types";

/** One validation issue in the library-neutral Standard Schema format. */
export interface StandardSchemaIssue {
  readonly message: string;
  readonly path?:
    ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
}

/** The result shape defined by Standard Schema. */
export type StandardSchemaResult<T> =
  | { readonly value: T; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardSchemaIssue> };

/**
 * Structural Standard Schema contract. Compliant validation libraries satisfy
 * this without an adapter or a runtime dependency from this package.
 */
export interface StandardSchema<T> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly types?:
      { readonly input: unknown; readonly output: T } | undefined;
    readonly validate: (
      value: unknown,
      options?: {
        readonly libraryOptions?: Record<string, unknown> | undefined;
      },
    ) => StandardSchemaResult<T> | Promise<StandardSchemaResult<T>>;
  };
}

/** Runtime contracts for values accepted through the public object ingress. */
export interface MachineContract<M extends AnyStateMachine = AnyStateMachine> {
  input?: StandardSchema<InputFrom<M>>;
  event?: StandardSchema<EventFrom<M>>;
}

export type MachineObjectOptions<M extends AnyStateMachine = AnyStateMachine> =
  {
    /**
     * If set, an instance is disposed this many milliseconds after it reaches a
     * final state. After disposal, all handlers reject with a 410 TerminalError.
     */
    finalStateTTL?: number;
    /** Optional runtime validation for public create/send ingress. */
    contract?: MachineContract<M>;
  } & ObjectOptions;

/** Payload of the internal `executeActor` handler. */
export interface ExecuteRequest {
  params: SpawnParams;
  executionId: string;
}

/** A successful actor execution delivered through an ingress-private handler. */
export interface ActorDoneRequest {
  actorId: string;
  executionId: string;
  output?: unknown;
}

/** A failed actor execution delivered through an ingress-private handler. */
export interface ActorErrorRequest {
  actorId: string;
  executionId: string;
  error: NormalizedError;
}

/** Payload of the internal `deliverScheduled` handler. */
export interface ScheduledEvent {
  sendId: string;
  uuid: string;
}

/** Persisted record of a pending delayed delivery, keyed by sendId. */
export interface ScheduledDelivery {
  uuid: string;
  targetKey: string;
  event: AnyEventObject;
}

/** Payload of the internal `initChild` handler. */
export interface InitRequest {
  machineId: string;
  parentKey: string;
  invokeId: string;
  executionId: string;
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
  condition: Condition;
  awakeableId: string;
}

export interface WaitForRequest<M extends AnyStateMachine = AnyStateMachine> {
  condition: Condition;
  timeout?: number;
  event?: EventFrom<M>;
}

export type MachineVirtualObject<M extends AnyStateMachine> = {
  create: (context: ObjectContext, input: InputFrom<M>) => Promise<void>;
  send: (context: ObjectContext, event: EventFrom<M>) => Promise<void>;
  snapshot: (context: ObjectContext) => Promise<ReturnedSnapshot>;
  waitFor: (
    context: ObjectSharedContext,
    request: WaitForRequest<M>,
  ) => Promise<ReturnedSnapshot>;
  subscribe: (
    context: ObjectContext,
    request: SubscribeRequest,
  ) => Promise<void>;
  deliverEvent: (
    context: ObjectContext,
    event: AnyEventObject,
  ) => Promise<void>;
  actorDone: (
    context: ObjectContext,
    request: ActorDoneRequest,
  ) => Promise<void>;
  actorError: (
    context: ObjectContext,
    request: ActorErrorRequest,
  ) => Promise<void>;
  executeActor: (
    context: ObjectSharedContext,
    request: ExecuteRequest,
  ) => Promise<void>;
  deliverScheduled: (
    context: ObjectContext,
    request: ScheduledEvent,
  ) => Promise<void>;
  initChild: (context: ObjectContext, request: InitRequest) => Promise<void>;
  cleanupState: (context: ObjectContext) => Promise<void>;
};

/** A reference to this virtual object's definition, used to build clients. */
export type MachineDefinition = VirtualObjectDefinition<
  string,
  MachineVirtualObject<AnyStateMachine>
>;

/** The bundle of state an effect executor needs to act against Restate. */
export interface HandlerContext {
  ctx: ObjectContext;
  self: MachineDefinition;
  /** Set only for a child instance: the parent's object key. */
  parentKey?: string;
  /** Set only for a child instance: the invoke/spawn id it runs under. */
  invokeId?: string;
  /** Unique generation of this child invocation. */
  executionId?: string;
  finalStateTTL?: number;
}
