import type {
  AnyEventObject,
  AnyStateMachine,
  InputFrom,
  EventFrom,
} from "xstate";
import * as restate from "@restatedev/restate-sdk";
import { buildRegistry } from "../xstate/registry";
import { fromStored, toReturnedSnapshot } from "../xstate/snapshot";
import { evaluateCondition, isValidCondition } from "../xstate/conditions";
import { initialStep, resumeStep } from "../xstate/interpret";
import {
  createDoneActorEvent,
  createNormalizedErrorActorEvent,
} from "../xstate/actors";
import type {
  ResumeInput,
  ReturnedSnapshot,
  Step,
  StoredState,
} from "../xstate/types";
import {
  selfDef,
  sendClient,
  client,
  executeEffects,
  settleSubscriptions,
  reportTerminal,
  maybeScheduleCleanup,
} from "./effects";
import { runActor } from "./run-actor";
import { parseContract, publicEventProblem } from "./contracts";
import {
  getState,
  isDisposed,
  getMachineId,
  getParentKey,
  getInvokeId,
  getExecutionId,
  getChildren,
  getActorExecutions,
  setActorExecutions,
  getScheduled,
  setScheduled,
  setState,
  setIdentity,
  markDisposedAndClear,
  clearRuntimeState,
  clearIdentity,
  getSubscriptions,
  setSubscriptions,
} from "./state";
import type {
  ChildRecord,
  HandlerContext,
  MachineObjectOptions,
  MachineVirtualObject,
  ExecuteRequest,
  ActorDoneRequest,
  ActorErrorRequest,
  ScheduledEvent,
  InitRequest,
  SubscribeRequest,
  WaitForRequest,
} from "./types";

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

// ===========================================================================
// Entrypoint
// ===========================================================================

/**
 * Turn an XState machine into a Restate virtual object.
 *
 * Each object key is one durable machine instance whose state is the persisted
 * snapshot. Handlers drive the machine through the pure {@link initialStep} /
 * {@link resumeStep} functions (journaled via `ctx.run` for replay determinism)
 * and execute the resulting effects against Restate.
 *
 * Public handlers:
 * - `create(input)` — start a new instance from its initial transition.
 * - `send(event)` — apply an event; returns once the macrostep is persisted.
 * - `snapshot()` — read the current snapshot (with tags).
 * - `subscribe({ condition, awakeableId })` — resolve an awakeable when a
 *   `done` | `hasTag:*` condition is met.
 * - `waitFor({ condition, timeout?, event? })` — awakeable-backed long-poll,
 *   optionally sending an event first.
 *
 * Internal handlers (ingress-private): `deliverEvent`, `actorDone`,
 * `actorError`, `initChild`, `deliverScheduled`, `executeActor`,
 * `cleanupState`.
 *
 * @param name - The virtual object (service) name to register under.
 * @param machine - The root state machine; child machines it invokes/spawns run
 *   as their own instances of this same object.
 * @param options - Restate object options, runtime input/event contracts, plus
 *   `finalStateTTL` to dispose an instance after it reaches a final state.
 * @returns A Restate `VirtualObjectDefinition` to bind to an endpoint.
 */
export function createMachineObject<
  P extends string,
  M extends AnyStateMachine,
>(
  name: P,
  machine: M,
  options?: MachineObjectOptions<M>,
): restate.VirtualObjectDefinition<P, MachineVirtualObject<M>> {
  const registry = buildRegistry(machine);
  const self = selfDef(name);
  const { finalStateTTL, contract, ...objectOptions } = options ?? {};
  validateFinalStateTTL(finalStateTTL);

  function getMachine(id: string | null): AnyStateMachine {
    if (id == null) return machine;
    const registered = registry.get(id);
    if (registered !== undefined) return registered;
    throw new restate.TerminalError(
      `No machine with id "${id}" is registered for this object.`,
      { errorCode: 500 },
    );
  }

  async function buildHandlerContext(
    context: restate.ObjectContext,
  ): Promise<HandlerContext> {
    const parentKey = await getParentKey(context);
    const invokeId = await getInvokeId(context);
    const executionId = await getExecutionId(context);
    return {
      ctx: context,
      self,
      ...(parentKey === null ? {} : { parentKey }),
      ...(invokeId === null ? {} : { invokeId }),
      ...(executionId === null ? {} : { executionId }),
      ...(finalStateTTL === undefined ? {} : { finalStateTTL }),
    };
  }

  // A machine transition runs synchronous user code (e.g. an `assign` reading
  // Date.now() or a random id). Journaling the result via ctx.run makes a
  // handler replay return the recorded Step instead of re-running that code,
  // keeping the durable execution deterministic.
  function computeStep(
    context: restate.ObjectContext,
    label: string,
    compute: () => Step,
  ): Promise<Step> {
    return context.run(label, compute);
  }

  async function commit(handler: HandlerContext, result: Step): Promise<void> {
    setState(handler.ctx, result.nextState);
    await executeEffects(handler, result.effects);
    await settleSubscriptions(handler, result.returned);
    await reportTerminal(handler, result.returned);
    maybeScheduleCleanup(handler, result.returned);
  }

  async function loadInstance(
    context: restate.ObjectContext,
  ): Promise<LoadedInstance | null> {
    const stored = await getState(context);
    if (stored === null) return null;

    const handler = await buildHandlerContext(context);
    const machine = getMachine(await getMachineId(context));
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

  async function applyEvent(
    context: restate.ObjectContext,
    event: AnyEventObject,
  ): Promise<void> {
    const instance = await loadInstance(context);
    if (instance === null) return;

    const result = await computeEventStep(context, instance, event);
    await commit(instance.handler, result);
  }

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

  const createHandler = async (
    context: restate.ObjectContext,
    input: InputFrom<M>,
  ): Promise<void> => {
    clearRuntimeState(context);
    clearIdentity(context);
    const handler = await buildHandlerContext(context);
    const result = await computeStep(context, "create", () =>
      initialStep(machine, { input, isChild: false }),
    );
    await commit(handler, result);
  };

  const sendHandler = async (
    context: restate.ObjectContext,
    event: EventFrom<M>,
  ): Promise<void> => {
    validatePublicEvent(event);
    await validateNotDisposed(context);
    await getRequiredState(context);
    await applyEvent(context, event);
  };

  const create = contract?.input
    ? restate.createObjectHandler(
        { input: restate.serde.schema(contract.input) },
        createHandler,
      )
    : createHandler;

  const send = contract?.event
    ? restate.createObjectHandler(
        { input: restate.serde.schema(contract.event) },
        sendHandler,
      )
    : sendHandler;

  function parsePublicEvent(event: EventFrom<M>): EventFrom<M> {
    const result = contract?.event
      ? parseContract(contract.event, event)
      : { ok: true as const, value: event };
    if (!result.ok) {
      throw new restate.TerminalError(result.message, {
        errorCode: result.kind === "invalid" ? 400 : 500,
      });
    }
    const parsed = result.value;
    validatePublicEvent(parsed);
    return parsed;
  }

  return restate.object({
    name,
    handlers: {
      create,

      initChild: restate.createObjectHandler(
        { ingressPrivate: true },
        async (context: restate.ObjectContext, request: InitRequest) => {
          clearRuntimeState(context);
          setIdentity(context, request);
          const handler = await buildHandlerContext(context);
          const result = await computeStep(context, "initChild", () =>
            initialStep(getMachine(request.machineId), {
              input: request.input,
              isChild: true,
            }),
          );
          await commit(handler, result);
        },
      ),

      send,

      deliverEvent: restate.createObjectHandler(
        { ingressPrivate: true },
        async (context: restate.ObjectContext, event: AnyEventObject) => {
          await applyEvent(context, event);
        },
      ),

      actorDone: restate.createObjectHandler(
        { ingressPrivate: true },
        async (context: restate.ObjectContext, request: ActorDoneRequest) => {
          if (
            !(await consumeActorExecution(
              context,
              request.actorId,
              request.executionId,
            ))
          ) {
            return;
          }
          await applyEvent(
            context,
            createDoneActorEvent(request.actorId, request.output),
          );
        },
      ),

      actorError: restate.createObjectHandler(
        { ingressPrivate: true },
        async (context: restate.ObjectContext, request: ActorErrorRequest) => {
          if (
            !(await consumeActorExecution(
              context,
              request.actorId,
              request.executionId,
            ))
          ) {
            return;
          }
          await applyEvent(
            context,
            createNormalizedErrorActorEvent(request.actorId, request.error),
          );
        },
      ),

      deliverScheduled: restate.createObjectHandler(
        { ingressPrivate: true },
        async (context: restate.ObjectContext, request: ScheduledEvent) => {
          const scheduled = await getScheduled(context);
          const entry = scheduled[request.sendId];
          if (!entry || entry.uuid !== request.uuid) return;

          delete scheduled[request.sendId];
          setScheduled(context, scheduled);

          if (entry.targetKey === context.key) {
            await applyEvent(context, entry.event);
          } else {
            sendClient(context, self, entry.targetKey).deliverEvent(
              entry.event,
            );
          }
        },
      ),

      executeActor: restate.handlers.object.shared(
        { ingressPrivate: true, enableLazyState: true },
        async (
          context: restate.ObjectSharedContext,
          request: ExecuteRequest,
        ) => {
          const instanceMachine = getMachine(await getMachineId(context));
          const outcome = await runActor(
            instanceMachine,
            request.params,
            context,
          );
          const target = sendClient(context, self, context.key);
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
        },
      ),

      snapshot: async (
        context: restate.ObjectContext,
      ): Promise<ReturnedSnapshot> => {
        await validateNotDisposed(context);
        const stored = await getRequiredState(context);
        const instanceMachine = getMachine(await getMachineId(context));
        return toReturnedSnapshot(fromStored(instanceMachine, stored));
      },

      subscribe: async (
        context: restate.ObjectContext,
        request: SubscribeRequest,
      ) => {
        await validateNotDisposed(context);
        const stored = await getRequiredState(context);
        validateCondition(request.condition);

        const instanceMachine = getMachine(await getMachineId(context));
        const returned = toReturnedSnapshot(
          fromStored(instanceMachine, stored),
        );
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
      },

      waitFor: restate.handlers.object.shared(
        async (
          context: restate.ObjectSharedContext,
          request: WaitForRequest<M>,
        ): Promise<ReturnedSnapshot> => {
          await validateNotDisposed(context);
          await getRequiredState(context);
          validateCondition(request.condition);

          const event =
            request.event === undefined
              ? undefined
              : parsePublicEvent(request.event);

          const { id, promise } = context.awakeable<ReturnedSnapshot>();

          await client(context, self, context.key).subscribe({
            condition: request.condition,
            awakeableId: id,
          });

          if (event !== undefined) {
            sendClient(context, self, context.key).deliverEvent(event);
          }

          try {
            return request.timeout !== undefined
              ? await promise.orTimeout(request.timeout)
              : await promise;
          } catch (error) {
            if (!(error instanceof restate.TerminalError)) throw error;
            if (error.code != 500) throw error;
            // awakeable rejection -> 412 so clients know it is non-transient
            throw new restate.TerminalError(error.message, { errorCode: 412 });
          }
        },
      ),

      cleanupState: restate.createObjectHandler(
        { ingressPrivate: true },
        async (context: restate.ObjectContext) => {
          markDisposedAndClear(context);
        },
      ),
    } satisfies MachineVirtualObject<M>,
    options: objectOptions,
  });
}

// ===========================================================================
// Internals
// ===========================================================================

/** Reject (410) once an instance has been disposed after its final state. */
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

/** Reject (404) when a handler is called before `create`. */
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

/** Reject malformed or reserved events arriving through the public handler. */
function validatePublicEvent(event: unknown): asserts event is AnyEventObject {
  const problem = publicEventProblem(event);
  if (problem !== undefined) {
    throw new restate.TerminalError(problem, { errorCode: 400 });
  }
}

/** Reject (400) an unsupported wait condition. */
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
