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
} from "../../xstate/actors";
import { evaluateCondition, isValidCondition } from "../../xstate/conditions";
import { fromStored, toReturnedSnapshot } from "../../xstate/snapshot";
import type { ReturnedSnapshot, StoredState } from "../../xstate/types";
import { parseContract, publicEventProblem } from "../contracts";
import { client, sendClient } from "../effects";
import { runActor } from "../run-actor";
import {
  getMachineId,
  getScheduled,
  getState,
  getSubscriptions,
  isDisposed,
  markDisposedAndClear,
  setScheduled,
  setSubscriptions,
} from "../state";
import type {
  ActorDoneRequest,
  ActorErrorRequest,
  ExecuteRequest,
  InitRequest,
  MachineContract,
  MachineObjectOptions,
  MachineVirtualObject,
  ScheduledEvent,
  StandardSchema,
  SubscribeRequest,
  WaitForRequest,
} from "../types";
import { MachineRuntime } from "./runtime";
import {
  applyEvent,
  consumeActorExecution,
  initializeChild,
  initializeRoot,
} from "./transitions";

const PRIVATE_HANDLER = { ingressPrivate: true } as const;
const PRIVATE_LAZY_HANDLER = {
  ingressPrivate: true,
  enableLazyState: true,
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
  const runtime = new MachineRuntime(name, machine, finalStateTTL);
  const handlers = new MachineHandlers(runtime, contract);
  validateFinalStateTTL(finalStateTTL);

  return restate.object({
    name,
    handlers: handlers.createDefinitions(),
    options: objectOptions,
  });
}

/** Restate handler surface bound once to a single immutable runtime. */
class MachineHandlers<M extends AnyStateMachine> {
  constructor(
    private readonly runtime: MachineRuntime<M>,
    private readonly contract: MachineContract<M> | undefined,
  ) {}

  createDefinitions(): MachineVirtualObject<M> {
    return {
      create: this.createRootDefinition(),
      initChild: restate.createObjectHandler(
        PRIVATE_HANDLER,
        this.handleInitChild,
      ),
      send: this.createSendDefinition(),
      deliverEvent: restate.createObjectHandler(
        PRIVATE_HANDLER,
        this.handleDeliverEvent,
      ),
      actorDone: restate.createObjectHandler(
        PRIVATE_HANDLER,
        this.handleActorDone,
      ),
      actorError: restate.createObjectHandler(
        PRIVATE_HANDLER,
        this.handleActorError,
      ),
      deliverScheduled: restate.createObjectHandler(
        PRIVATE_HANDLER,
        this.handleScheduledEvent,
      ),
      executeActor: restate.createObjectSharedHandler(
        PRIVATE_LAZY_HANDLER,
        this.handleExecuteActor,
      ),
      snapshot: this.handleSnapshot,
      subscribe: this.handleSubscribe,
      waitFor: restate.createObjectSharedHandler(this.handleWaitFor),
      cleanupState: restate.createObjectHandler(
        PRIVATE_HANDLER,
        this.handleCleanupState,
      ),
    };
  }

  private createRootDefinition(): MachineVirtualObject<M>["create"] {
    return this.contract?.input
      ? restate.createObjectHandler(
          { input: restate.serde.schema(this.contract.input) },
          this.handleCreate,
        )
      : this.handleCreate;
  }

  private createSendDefinition(): MachineVirtualObject<M>["send"] {
    return this.contract?.event
      ? restate.createObjectHandler(
          { input: restate.serde.schema(this.contract.event) },
          this.handleSend,
        )
      : this.handleSend;
  }

  private readonly handleCreate = (
    context: restate.ObjectContext,
    input: InputFrom<M>,
  ): Promise<void> => initializeRoot(this.runtime, context, input);

  private readonly handleInitChild = (
    context: restate.ObjectContext,
    request: InitRequest,
  ): Promise<void> => initializeChild(this.runtime, context, request);

  private readonly handleSend = async (
    context: restate.ObjectContext,
    event: EventFrom<M>,
  ): Promise<void> => {
    validatePublicEvent(event);
    await validateNotDisposed(context);
    await getRequiredState(context);
    await applyEvent(this.runtime, context, event);
  };

  private readonly handleDeliverEvent = (
    context: restate.ObjectContext,
    event: AnyEventObject,
  ): Promise<void> => applyEvent(this.runtime, context, event);

  private readonly handleActorDone = async (
    context: restate.ObjectContext,
    request: ActorDoneRequest,
  ): Promise<void> => {
    const isCurrent = await consumeActorExecution(
      context,
      request.actorId,
      request.executionId,
    );
    if (!isCurrent) return;

    await applyEvent(
      this.runtime,
      context,
      createDoneActorEvent(request.actorId, request.output),
    );
  };

  private readonly handleActorError = async (
    context: restate.ObjectContext,
    request: ActorErrorRequest,
  ): Promise<void> => {
    const isCurrent = await consumeActorExecution(
      context,
      request.actorId,
      request.executionId,
    );
    if (!isCurrent) return;

    await applyEvent(
      this.runtime,
      context,
      createNormalizedErrorActorEvent(request.actorId, request.error),
    );
  };

  private readonly handleScheduledEvent = async (
    context: restate.ObjectContext,
    request: ScheduledEvent,
  ): Promise<void> => {
    const scheduled = await getScheduled(context);
    const entry = scheduled[request.sendId];
    if (!entry || entry.uuid !== request.uuid) return;

    delete scheduled[request.sendId];
    setScheduled(context, scheduled);

    if (entry.targetKey === context.key) {
      await applyEvent(this.runtime, context, entry.event);
    } else {
      sendClient(context, this.runtime.self, entry.targetKey).deliverEvent(
        entry.event,
      );
    }
  };

  private readonly handleExecuteActor = async (
    context: restate.ObjectSharedContext,
    request: ExecuteRequest,
  ): Promise<void> => {
    const machine = this.runtime.resolveMachine(await getMachineId(context));
    const outcome = await runActor(machine, request.params, context);
    const target = sendClient(context, this.runtime.self, context.key);

    if (outcome.status === "done") {
      target.actorDone({
        actorId: request.params.id,
        executionId: request.executionId,
        output: outcome.output,
      });
    } else {
      target.actorError({
        actorId: request.params.id,
        executionId: request.executionId,
        error: outcome.error,
      });
    }
  };

  private readonly handleSnapshot = async (
    context: restate.ObjectContext,
  ): Promise<ReturnedSnapshot> => {
    await validateNotDisposed(context);
    const stored = await getRequiredState(context);
    const machine = this.runtime.resolveMachine(await getMachineId(context));
    return toReturnedSnapshot(fromStored(machine, stored));
  };

  private readonly handleSubscribe = async (
    context: restate.ObjectContext,
    request: SubscribeRequest,
  ): Promise<void> => {
    await validateNotDisposed(context);
    const stored = await getRequiredState(context);
    validateCondition(request.condition);

    const machine = this.runtime.resolveMachine(await getMachineId(context));
    const returned = toReturnedSnapshot(fromStored(machine, stored));
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
    if (existing) {
      existing.awakeables.push(request.awakeableId);
    } else {
      subscriptions[request.condition] = {
        awakeables: [request.awakeableId],
      };
    }
    setSubscriptions(context, subscriptions);
  };

  private readonly handleWaitFor = async (
    context: restate.ObjectSharedContext,
    request: WaitForRequest<M>,
  ): Promise<ReturnedSnapshot> => {
    await validateNotDisposed(context);
    await getRequiredState(context);
    validateCondition(request.condition);

    const event =
      request.event === undefined
        ? undefined
        : parsePublicEvent(this.contract?.event, request.event);
    const { id, promise } = context.awakeable<ReturnedSnapshot>();

    await client(context, this.runtime.self, context.key).subscribe({
      condition: request.condition,
      awakeableId: id,
    });

    if (event !== undefined) {
      sendClient(context, this.runtime.self, context.key).deliverEvent(event);
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
  };

  private readonly handleCleanupState = async (
    context: restate.ObjectContext,
  ): Promise<void> => {
    markDisposedAndClear(context);
  };
}

async function validateNotDisposed(
  context: restate.ObjectSharedContext,
): Promise<void> {
  if (await isDisposed(context)) {
    throw new restate.TerminalError(
      "The state machine has been disposed after reaching it's final state",
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
    "No state machine found for this workflow ID. Call 'create' first.",
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

function validateFinalStateTTL(value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError("finalStateTTL must be a finite, non-negative number");
  }
}
