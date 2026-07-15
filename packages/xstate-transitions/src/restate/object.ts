import * as restate from "@restatedev/restate-sdk";
import type {
  AnyEventObject,
  AnyStateMachine,
  EventFrom,
  InputFrom,
} from "xstate";
import {
  createDoneActorEvent,
  createNormalizedErrorActorEvent,
} from "../xstate/actors";
import { evaluateCondition, isValidCondition } from "../xstate/conditions";
import { initialStep, resumeStep } from "../xstate/interpret";
import { buildRegistry } from "../xstate/registry";
import { fromStored, toReturnedSnapshot } from "../xstate/snapshot";
import type {
  ResumeInput,
  ReturnedSnapshot,
  Step,
  StoredState,
} from "../xstate/types";
import { parseContract, publicEventProblem } from "./contracts";
import {
  executeEffects,
  maybeScheduleCleanup,
  reportTerminal,
  settleSubscriptions,
} from "./effects";
import { runActor } from "./run-actor";
import {
  clearIdentity,
  clearRuntimeState,
  getActorExecutions,
  getCleanupToken,
  getChildren,
  getExecutionId,
  getInvokeId,
  getMachineId,
  getParentKey,
  getScheduled,
  getState,
  getSubscriptions,
  isDisposed,
  markDisposedAndClear,
  setActorExecutions,
  setIdentity,
  setScheduled,
  setState,
  setSubscriptions,
} from "./state";
import type {
  ActorDoneRequest,
  ActorErrorRequest,
  ChildRecord,
  CleanupFinalStateRequest,
  ExecuteRequest,
  HandlerContext,
  InitRequest,
  MachineDefinition,
  MachineObjectOptions,
  MachineVirtualObject,
  ScheduledEvent,
  StandardSchema,
  SubscribeRequest,
  WaitForRequest,
} from "./types";

const INTERNAL_HANDLER_METADATA = {
  "restate.xstate.internal": "true",
} as const;
const INTERNAL_HANDLER_OPTIONS = {
  ingressPrivate: true,
  metadata: INTERNAL_HANDLER_METADATA,
} as const;
const INTERNAL_LAZY_HANDLER_OPTIONS = {
  ingressPrivate: true,
  enableLazyState: true,
  metadata: INTERNAL_HANDLER_METADATA,
} as const;

/**
 * Turn an XState machine into a Restate virtual object.
 *
 * Each object key is one durable machine instance whose state is the persisted
 * snapshot. Handlers drive the machine through pure initial/resume functions,
 * record their results for replay, and execute the resulting effects through
 * Restate.
 *
 * Public handlers:
 * - `create(input)` starts a new instance from its initial transition.
 * - `send(event)` applies an event and returns after the macrostep is persisted.
 * - `snapshot()` reads the current serializable snapshot.
 * - `subscribe(request)` resolves an awakeable when a condition is met.
 * - `waitFor(request)` provides awakeable-backed long polling.
 *
 * Internal ingress-private handlers carry child initialization, actor results,
 * machine messages, delayed events, promise execution, and state cleanup.
 *
 * @param name The virtual object service name.
 * @param machine The root machine and entry point to its reachable child graph.
 * @param options Restate options, runtime contracts, and optional final-state
 * cleanup TTL.
 * @returns A Restate virtual object definition ready to bind to an endpoint.
 */
export function createMachineObject<
  P extends string,
  M extends AnyStateMachine,
>(
  name: P,
  machine: M,
  options?: MachineObjectOptions<M>,
): restate.VirtualObjectDefinition<P, MachineVirtualObject<M>> {
  const { finalStateTTL, contract, ...objectOptions } = options ?? {};
  validateFinalStateTTL(finalStateTTL);

  const inputSerde = selectSerde(contract?.input);
  const eventSerde = selectSerde(contract?.event);
  const runtime = new MachineRuntime(name, machine, finalStateTTL);
  const handlers = new MachineHandlers(runtime, contract?.event);

  return restate.object({
    name,
    description: "Durable XState machine instances backed by Restate.",
    handlers: {
      // Public API

      /**
       * Creates a root machine instance at the current object key.
       *
       * Creation runs the machine's initial transition, persists the resulting
       * snapshot, and executes its initial effects. Calling `create` again for
       * the same key deliberately replaces the previous instance and clears
       * its runtime bookkeeping before starting from the initial state.
       */
      // The SDK conditionally removes a void input from the returned handler
      // type; the public machine surface intentionally preserves InputFrom<M>.
      create: restate.createObjectHandler(
        {
          input: inputSerde,
          description:
            "Creates or resets a durable machine instance from its initial state.",
        },
        (context: restate.ObjectContext, input: InputFrom<M>) =>
          handlers.create(context, input),
      ) as MachineVirtualObject<M>["create"],

      /**
       * Delivers an application event through the machine's public ingress.
       *
       * The event is rejected if it resembles a reserved XState lifecycle
       * event, and is validated by the optional event contract before this
       * handler runs. The handler requires an existing, non-disposed instance
       * and returns only after the transition and its effects are durable.
       */
      send: restate.createObjectHandler(
        {
          input: eventSerde,
          description:
            "Delivers an event and durably applies the resulting machine transition.",
        },
        (context: restate.ObjectContext, event: EventFrom<M>) =>
          handlers.send(context, event),
      ),

      /**
       * Reads the current machine state without performing a transition.
       *
       * Stored state is rehydrated with the machine registered for this object
       * key and projected to the stable, serializable `ReturnedSnapshot`
       * representation. Missing or disposed instances fail explicitly.
       */
      snapshot: restate.createObjectHandler(
        {
          description:
            "Returns the current serializable snapshot of a machine instance.",
        },
        (context: restate.ObjectContext) => handlers.snapshot(context),
      ),

      /**
       * Registers an existing Restate awakeable for a machine condition.
       *
       * This is the lower-level counterpart to `waitFor`. It resolves or
       * rejects the awakeable immediately when the condition is already
       * decided; otherwise it stores the awakeable ID for settlement after a
       * later transition. It is exclusive because registration mutates state.
       */
      subscribe: restate.createObjectHandler(
        {
          description:
            "Registers an awakeable for completion or a machine state-tag condition.",
        },
        (context: restate.ObjectContext, request: SubscribeRequest) =>
          handlers.subscribe(context, request),
      ),

      /**
       * Waits until the machine completes or enters a state with a given tag.
       *
       * The shared handler creates an awakeable, registers it through the
       * exclusive `subscribe` handler, and optionally delivers an event only
       * after registration to avoid missed transitions. A caller-supplied
       * timeout is reported as a precondition failure.
       */
      waitFor: restate.createObjectSharedHandler(
        {
          description:
            "Waits for completion or a state tag, optionally sending an event after subscribing.",
        },
        (context: restate.ObjectSharedContext, request: WaitForRequest<M>) =>
          handlers.waitFor(context, request),
      ),

      // Internal handlers

      /**
       * Initializes a child machine instance created by a parent machine.
       *
       * The request selects a machine from the root's registered child graph
       * and records the parent key, invoke ID, and execution generation needed
       * to route lifecycle events back to the parent safely.
       */
      initChild: restate.createObjectHandler(
        {
          ...INTERNAL_HANDLER_OPTIONS,
          description:
            "Initializes a child machine instance and records its parent identity.",
        },
        (context: restate.ObjectContext, request: InitRequest) =>
          handlers.initChild(context, request),
      ),

      /**
       * Applies a trusted integration-generated event to an instance.
       *
       * Unlike public `send`, this path intentionally accepts XState lifecycle
       * events produced by child machines, actors, delayed sends, and
       * `waitFor`. Delivery to an instance that no longer exists is a no-op so
       * late asynchronous messages remain harmless.
       */
      deliverEvent: restate.createObjectHandler(
        {
          ...INTERNAL_HANDLER_OPTIONS,
          description:
            "Applies a trusted internal or XState lifecycle event to an instance.",
        },
        (context: restate.ObjectContext, event: AnyEventObject) =>
          handlers.deliverEvent(context, event),
      ),

      /**
       * Accepts successful completion of a promise actor execution.
       *
       * The execution generation is consumed atomically; stale completions
       * from a stopped or re-entered actor are ignored. A current completion
       * is translated to XState's actor-done event and applied durably.
       */
      actorDone: restate.createObjectHandler(
        {
          ...INTERNAL_HANDLER_OPTIONS,
          description:
            "Delivers a successful result from the current promise actor execution.",
        },
        (context: restate.ObjectContext, request: ActorDoneRequest) =>
          handlers.actorDone(context, request),
      ),

      /**
       * Accepts failed completion of a promise actor execution.
       *
       * As with `actorDone`, the generation check prevents a late result from
       * mutating a newer invocation. The error is normalized into XState's
       * actor-error event before the machine resumes.
       */
      actorError: restate.createObjectHandler(
        {
          ...INTERNAL_HANDLER_OPTIONS,
          description:
            "Delivers a normalized error from the current promise actor execution.",
        },
        (context: restate.ObjectContext, request: ActorErrorRequest) =>
          handlers.actorError(context, request),
      ),

      /**
       * Delivers an event whose Restate delay has elapsed.
       *
       * The stored UUID must match the request, which makes cancellation and
       * replacement race-safe. A current event is removed from the schedule,
       * then applied locally or forwarded to its target object key.
       */
      deliverScheduled: restate.createObjectHandler(
        {
          ...INTERNAL_HANDLER_OPTIONS,
          description:
            "Delivers a current delayed event and ignores cancelled or stale schedules.",
        },
        (context: restate.ObjectContext, request: ScheduledEvent) =>
          handlers.deliverScheduled(context, request),
      ),

      /**
       * Executes a promise actor outside the exclusive transition handler.
       *
       * Shared, lazy-state execution lets long-running user work proceed
       * without holding the object's exclusive lock or loading unrelated
       * state. The outcome is sent back through `actorDone` or `actorError`
       * together with its execution generation.
       */
      executeActor: restate.createObjectSharedHandler(
        {
          ...INTERNAL_LAZY_HANDLER_OPTIONS,
          description:
            "Runs a promise actor and reports its generation-scoped outcome.",
        },
        (context: restate.ObjectSharedContext, request: ExecuteRequest) =>
          handlers.executeActor(context, request),
      ),

      /** Disposes a child instance that its parent stopped. */
      cleanupState: restate.createObjectHandler(
        {
          ...INTERNAL_HANDLER_OPTIONS,
          description: "Clears a child instance stopped by its parent.",
        },
        (context: restate.ObjectContext) => handlers.cleanupState(context),
      ),

      /**
       * Disposes the completed incarnation that scheduled a final-state TTL.
       *
       * The token prevents a delayed request from an older incarnation from
       * clearing a machine that was recreated at the same object key.
       */
      cleanupFinalState: restate.createObjectHandler(
        {
          ...INTERNAL_HANDLER_OPTIONS,
          description:
            "Clears a completed instance only when its cleanup generation is current.",
        },
        (context: restate.ObjectContext, request: CleanupFinalStateRequest) =>
          handlers.cleanupFinalState(context, request),
      ),
    } satisfies MachineVirtualObject<M>,
    options: objectOptions,
  });
}

/** Immutable dependencies shared by every handler in one object definition. */
export class MachineRuntime<M extends AnyStateMachine = AnyStateMachine> {
  readonly rootMachine: M;
  readonly self: MachineDefinition;
  readonly finalStateTTL: number | undefined;
  private readonly registry: ReadonlyMap<string, AnyStateMachine>;

  constructor(name: string, rootMachine: M, finalStateTTL: number | undefined) {
    this.rootMachine = rootMachine;
    this.registry = buildRegistry(rootMachine);
    this.self = { name };
    this.finalStateTTL = finalStateTTL;
  }

  /** Resolve the machine persisted for a root or child instance. */
  resolveMachine(machineId: string | null): AnyStateMachine {
    if (machineId === null) return this.rootMachine;

    const machine = this.registry.get(machineId);
    if (machine !== undefined) return machine;

    throw new restate.TerminalError(
      `No machine with id "${machineId}" is registered for this object.`,
      { errorCode: 500 },
    );
  }
}

/** Runtime-dependent handler behavior, independent of Restate definitions. */
class MachineHandlers<M extends AnyStateMachine> {
  constructor(
    private readonly runtime: MachineRuntime<M>,
    private readonly eventContract: StandardSchema<EventFrom<M>> | undefined,
  ) {}

  create(context: restate.ObjectContext, input: InputFrom<M>): Promise<void> {
    return initializeRoot(this.runtime, context, input);
  }

  async send(
    context: restate.ObjectContext,
    event: EventFrom<M>,
  ): Promise<void> {
    validatePublicEvent(event);
    await validateNotDisposed(context);
    await getRequiredState(context);
    await applyEvent(this.runtime, context, event);
  }

  async snapshot(context: restate.ObjectContext): Promise<ReturnedSnapshot> {
    await validateNotDisposed(context);
    const stored = await getRequiredState(context);
    const machine = this.runtime.resolveMachine(await getMachineId(context));
    const snapshot = fromStored(machine, stored);
    return toReturnedSnapshot(snapshot);
  }

  async subscribe(
    context: restate.ObjectContext,
    request: SubscribeRequest,
  ): Promise<void> {
    await validateNotDisposed(context);
    const stored = await getRequiredState(context);
    validateCondition(request.condition);

    const machine = this.runtime.resolveMachine(await getMachineId(context));
    const snapshot = fromStored(machine, stored);
    const returned = toReturnedSnapshot(snapshot);
    const outcome = evaluateCondition(returned, request.condition);

    if (outcome.status === "resolve") {
      context.resolveAwakeable(request.awakeableId, outcome.snapshot);
      return;
    }
    if (outcome.status === "reject") {
      context.rejectAwakeable(request.awakeableId, outcome.reason);
      return;
    }

    const subscriptions = await getSubscriptions(context);
    const existing = subscriptions[request.condition];
    if (existing !== undefined) {
      existing.awakeables.push(request.awakeableId);
    } else {
      subscriptions[request.condition] = {
        awakeables: [request.awakeableId],
      };
    }
    setSubscriptions(context, subscriptions);
  }

  async waitFor(
    context: restate.ObjectSharedContext,
    request: WaitForRequest<M>,
  ): Promise<ReturnedSnapshot> {
    await validateNotDisposed(context);
    await getRequiredState(context);
    validateCondition(request.condition);

    const event =
      request.event === undefined
        ? undefined
        : parsePublicEvent(this.eventContract, request.event);
    const { id, promise } = context.awakeable<ReturnedSnapshot>();

    const subscriber = context.objectClient<MachineVirtualObject>(
      this.runtime.self,
      context.key,
    );
    await subscriber.subscribe({
      condition: request.condition,
      awakeableId: id,
    });

    if (event !== undefined) {
      const sender = context.objectSendClient<MachineVirtualObject>(
        this.runtime.self,
        context.key,
      );
      sender.deliverEvent(event);
    }

    try {
      return request.timeout !== undefined
        ? await promise.orTimeout(request.timeout)
        : await promise;
    } catch (error) {
      if (!(error instanceof restate.TerminalError)) throw error;
      if (error.code !== 500) throw error;
      throw new restate.TerminalError(error.message, { errorCode: 412 });
    }
  }

  initChild(
    context: restate.ObjectContext,
    request: InitRequest,
  ): Promise<void> {
    return initializeChild(this.runtime, context, request);
  }

  deliverEvent(
    context: restate.ObjectContext,
    event: AnyEventObject,
  ): Promise<void> {
    return applyEvent(this.runtime, context, event);
  }

  async actorDone(
    context: restate.ObjectContext,
    request: ActorDoneRequest,
  ): Promise<void> {
    const isCurrent = await consumeActorExecution(
      context,
      request.actorId,
      request.executionId,
    );
    if (!isCurrent) return;

    const event = createDoneActorEvent(request.actorId, request.output);
    await applyEvent(this.runtime, context, event);
  }

  async actorError(
    context: restate.ObjectContext,
    request: ActorErrorRequest,
  ): Promise<void> {
    const isCurrent = await consumeActorExecution(
      context,
      request.actorId,
      request.executionId,
    );
    if (!isCurrent) return;

    const event = createNormalizedErrorActorEvent(
      request.actorId,
      request.error,
    );
    await applyEvent(this.runtime, context, event);
  }

  async deliverScheduled(
    context: restate.ObjectContext,
    request: ScheduledEvent,
  ): Promise<void> {
    const scheduled = await getScheduled(context);
    const entry = scheduled[request.sendId];
    if (entry === undefined || entry.uuid !== request.uuid) return;

    delete scheduled[request.sendId];
    setScheduled(context, scheduled);

    if (entry.targetKey === context.key) {
      await applyEvent(this.runtime, context, entry.event);
      return;
    }

    const sender = context.objectSendClient<MachineVirtualObject>(
      this.runtime.self,
      entry.targetKey,
    );
    sender.deliverEvent(entry.event);
  }

  async executeActor(
    context: restate.ObjectSharedContext,
    request: ExecuteRequest,
  ): Promise<void> {
    const machine = this.runtime.resolveMachine(await getMachineId(context));
    const outcome = await runActor(machine, request.params, context);
    const sender = context.objectSendClient<MachineVirtualObject>(
      this.runtime.self,
      context.key,
    );

    if (outcome.status === "done") {
      sender.actorDone({
        actorId: request.params.id,
        executionId: request.executionId,
        output: outcome.output,
      });
    } else {
      sender.actorError({
        actorId: request.params.id,
        executionId: request.executionId,
        error: outcome.error,
      });
    }
  }

  cleanupState(context: restate.ObjectContext): Promise<void> {
    markDisposedAndClear(context);
    return Promise.resolve();
  }

  async cleanupFinalState(
    context: restate.ObjectContext,
    request: CleanupFinalStateRequest,
  ): Promise<void> {
    if ((await getCleanupToken(context)) !== request.token) return;
    markDisposedAndClear(context);
  }
}

type KnownActors = Pick<ResumeInput, "knownChildIds" | "knownPromiseIds">;

interface LoadedInstance {
  readonly stored: StoredState;
  readonly machine: AnyStateMachine;
  readonly handler: HandlerContext;
  readonly knownActors: KnownActors;
}

/** Classify persisted actor records for XState snapshot restoration. */
export function classifyKnownActors(
  children: Readonly<Record<string, ChildRecord>>,
  actorExecutions: Readonly<Record<string, string>>,
): KnownActors {
  const knownChildIds = Object.keys(children);
  const knownPromiseIds = Object.keys(actorExecutions).filter(
    (actorId) => !Object.hasOwn(children, actorId),
  );

  return { knownChildIds, knownPromiseIds };
}

/** Start or replace a root instance from its initial transition. */
async function initializeRoot<M extends AnyStateMachine>(
  runtime: MachineRuntime<M>,
  context: restate.ObjectContext,
  input: InputFrom<M>,
): Promise<void> {
  clearRuntimeState(context);
  clearIdentity(context);

  const handler = await loadHandlerContext(runtime, context);
  const result = await computeStep(context, "create", () =>
    initialStep(runtime.rootMachine, { input, isChild: false }),
  );
  await commitStep(handler, result);
}

/** Start or replace a child instance and persist its parent identity. */
async function initializeChild(
  runtime: MachineRuntime,
  context: restate.ObjectContext,
  request: InitRequest,
): Promise<void> {
  clearRuntimeState(context);
  setIdentity(context, request);

  const machine = runtime.resolveMachine(request.machineId);
  const handler = await loadHandlerContext(runtime, context);
  const result = await computeStep(context, "initChild", () =>
    initialStep(machine, {
      input: request.input,
      isChild: true,
    }),
  );
  await commitStep(handler, result);
}

/** Apply one event to an existing instance; missing internal targets are no-ops. */
async function applyEvent(
  runtime: MachineRuntime,
  context: restate.ObjectContext,
  event: AnyEventObject,
): Promise<void> {
  const instance = await loadInstance(runtime, context);
  if (instance === null) return;

  const result = await computeEventStep(context, instance, event);
  await commitStep(instance.handler, result);
}

/** Accept an actor result only when it belongs to the current execution. */
async function consumeActorExecution(
  context: restate.ObjectContext,
  actorId: string,
  executionId: string,
): Promise<boolean> {
  const actorExecutions = await getActorExecutions(context);
  if (actorExecutions[actorId] !== executionId) return false;

  delete actorExecutions[actorId];
  setActorExecutions(context, actorExecutions);
  return true;
}

async function loadHandlerContext(
  runtime: MachineRuntime,
  context: restate.ObjectContext,
): Promise<HandlerContext> {
  const parentKey = await getParentKey(context);
  const invokeId = await getInvokeId(context);
  const executionId = await getExecutionId(context);

  return {
    ctx: context,
    self: runtime.self,
    ...(parentKey === null ? {} : { parentKey }),
    ...(invokeId === null ? {} : { invokeId }),
    ...(executionId === null ? {} : { executionId }),
    ...(runtime.finalStateTTL === undefined
      ? {}
      : { finalStateTTL: runtime.finalStateTTL }),
  };
}

async function loadInstance(
  runtime: MachineRuntime,
  context: restate.ObjectContext,
): Promise<LoadedInstance | null> {
  const stored = await getState(context);
  if (stored === null) return null;

  const handler = await loadHandlerContext(runtime, context);
  const machine = runtime.resolveMachine(await getMachineId(context));
  const children = await getChildren(context);
  const actorExecutions = await getActorExecutions(context);

  return {
    stored,
    machine,
    handler,
    knownActors: classifyKnownActors(children, actorExecutions),
  };
}

function computeEventStep(
  context: restate.ObjectContext,
  instance: LoadedInstance,
  event: AnyEventObject,
): Promise<Step> {
  return computeStep(context, "event", () =>
    resumeStep(instance.machine, {
      stored: instance.stored,
      event,
      isChild: instance.handler.parentKey !== undefined,
      ...instance.knownActors,
    }),
  );
}

// Machine transitions may run synchronous user code such as assign actions.
// Recording the Step keeps replay deterministic without constraining that code.
function computeStep(
  context: restate.ObjectContext,
  label: string,
  compute: () => Step,
): Promise<Step> {
  return context.run(label, compute);
}

async function commitStep(
  handler: HandlerContext,
  result: Step,
): Promise<void> {
  setState(handler.ctx, result.nextState);
  await executeEffects(handler, result.effects);
  await settleSubscriptions(handler, result.returned);
  await reportTerminal(handler, result.returned);
  maybeScheduleCleanup(handler, result.returned);
}

async function validateNotDisposed(
  context: restate.ObjectSharedContext,
): Promise<void> {
  if (await isDisposed(context)) {
    throw new restate.TerminalError(
      "The state machine was disposed after reaching its final state.",
      { errorCode: 410 },
    );
  }
}

async function getRequiredState(
  context: restate.ObjectSharedContext,
): Promise<StoredState> {
  const stored = await getState(context);
  if (stored !== null) return stored;

  throw new restate.TerminalError(
    "No state machine exists for this object key. Call 'create' first.",
    { errorCode: 404 },
  );
}

function parsePublicEvent<E extends AnyEventObject>(
  schema: StandardSchema<E> | undefined,
  event: E,
): E {
  const result = schema
    ? parseContract(schema, event)
    : { ok: true as const, value: event };
  if (!result.ok) {
    throw new restate.TerminalError(result.message, {
      errorCode: result.kind === "invalid" ? 400 : 500,
    });
  }

  validatePublicEvent(result.value);
  return result.value;
}

function validatePublicEvent(event: unknown): asserts event is AnyEventObject {
  const problem = publicEventProblem(event);
  if (problem !== undefined) {
    throw new restate.TerminalError(problem, { errorCode: 400 });
  }
}

function validateCondition(condition: string): void {
  if (!isValidCondition(condition)) {
    throw new restate.TerminalError("Invalid subscription condition", {
      errorCode: 400,
    });
  }
}

function selectSerde<T>(
  schema: StandardSchema<T> | undefined,
): restate.Serde<T> {
  if (schema !== undefined) return restate.serde.schema(schema);

  // JsonSerde's optional schema property is wider than Serde<T> under this
  // project's exactOptionalPropertyTypes setting; its runtime contract is the
  // default JSON Serde we want here.
  return restate.serde.json as restate.Serde<T>;
}

function validateFinalStateTTL(value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError("finalStateTTL must be a finite, non-negative number");
  }
}
