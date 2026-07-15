import type { AnyStateMachine, InputFrom, EventFrom } from "xstate";
import * as restate from "@restatedev/restate-sdk";
import { buildRegistry } from "../xstate/registry";
import { fromStored, toReturnedSnapshot } from "../xstate/snapshot";
import { evaluateCondition, isValidCondition } from "../xstate/conditions";
import { initialStep, resumeStep } from "../xstate/interpret";
import type { ReturnedSnapshot, Step } from "../xstate/types";
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
import {
  getState,
  isDisposed,
  getMachineId,
  getParentKey,
  getInvokeId,
  getChildren,
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
  HandlerCtx,
  MachineObjectOptions,
  MachineVirtualObject,
  ExecuteRequest,
  ScheduledEvent,
  InitRequest,
  SubscribeRequest,
  WaitForRequest,
} from "./types";

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

async function validateExists(
  context: restate.ObjectSharedContext,
): Promise<void> {
  if ((await getState(context)) == null) {
    throw new restate.TerminalError(
      "No state machine found for this workflow ID. Call 'create' first.",
      { errorCode: 404 },
    );
  }
}

function validateCondition(condition: string): void {
  if (!isValidCondition(condition)) {
    throw new restate.TerminalError("Invalid subscription condition", {
      errorCode: 400,
    });
  }
}

export function createMachineObject<
  P extends string,
  M extends AnyStateMachine,
>(
  name: P,
  machine: M,
  options?: MachineObjectOptions,
): restate.VirtualObjectDefinition<P, MachineVirtualObject<M>> {
  const registry = buildRegistry(machine);
  const self = selfDef(name);
  const finalStateTTL = options?.finalStateTTL;

  function getMachine(id: string | null): AnyStateMachine {
    return (id != null ? registry.get(id) : undefined) ?? machine;
  }

  async function handlerCtx(
    context: restate.ObjectContext,
  ): Promise<HandlerCtx> {
    return {
      ctx: context,
      self,
      parentKey: (await getParentKey(context)) ?? undefined,
      invokeId: (await getInvokeId(context)) ?? undefined,
      finalStateTTL,
    };
  }

  async function commit(h: HandlerCtx, result: Step): Promise<void> {
    setState(h.ctx, result.nextState);
    await executeEffects(h, result.effects);
    await settleSubscriptions(h, result.returned);
    await reportTerminal(h, result.returned);
    maybeScheduleCleanup(h, result.returned);
  }

  async function applyEvent(
    context: restate.ObjectContext,
    event: EventFrom<M>,
  ): Promise<void> {
    const stored = await getState(context);
    if (stored == null) return;
    const h = await handlerCtx(context);
    const instanceMachine = getMachine(await getMachineId(context));
    const knownChildIds = Object.keys(await getChildren(context));
    await commit(
      h,
      resumeStep(instanceMachine, {
        stored,
        event,
        isChild: h.parentKey != null,
        knownChildIds,
      }),
    );
  }

  return restate.object({
    name,
    handlers: {
      create: async (context: restate.ObjectContext, input: InputFrom<M>) => {
        clearRuntimeState(context);
        clearIdentity(context);
        const h = await handlerCtx(context);
        await commit(h, initialStep(machine, { input, isChild: false }));
      },

      initChild: restate.handlers.object.exclusive(
        { ingressPrivate: true },
        async (context: restate.ObjectContext, request: InitRequest) => {
          clearRuntimeState(context);
          setIdentity(context, request);
          const h = await handlerCtx(context);
          await commit(
            h,
            initialStep(getMachine(request.machineId), {
              input: request.input,
              isChild: true,
            }),
          );
        },
      ),

      send: async (context: restate.ObjectContext, event: EventFrom<M>) => {
        await validateNotDisposed(context);
        await validateExists(context);
        await applyEvent(context, event);
      },

      deliverScheduled: restate.handlers.object.exclusive(
        { ingressPrivate: true },
        async (context: restate.ObjectContext, request: ScheduledEvent) => {
          const scheduled = await getScheduled(context);
          const entry = scheduled[request.sendId];
          if (!entry || entry.uuid !== request.uuid) return;

          delete scheduled[request.sendId];
          setScheduled(context, scheduled);

          if (entry.targetKey === context.key) {
            await applyEvent(context, entry.event as EventFrom<M>);
          } else {
            sendClient(context, self, entry.targetKey).send(entry.event);
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
          const event = await runActor(
            instanceMachine,
            request.params,
            context,
          );
          sendClient(context, self, context.key).send(event);
        },
      ),

      snapshot: async (
        context: restate.ObjectContext,
      ): Promise<ReturnedSnapshot> => {
        await validateNotDisposed(context);
        await validateExists(context);
        const instanceMachine = getMachine(await getMachineId(context));
        const stored = (await getState(context))!;
        return toReturnedSnapshot(fromStored(instanceMachine, stored));
      },

      subscribe: async (
        context: restate.ObjectContext,
        request: SubscribeRequest,
      ) => {
        await validateNotDisposed(context);
        await validateExists(context);
        validateCondition(request.condition);

        const instanceMachine = getMachine(await getMachineId(context));
        const stored = (await getState(context))!;
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
          await validateExists(context);
          validateCondition(request.condition);

          const { id, promise } = context.awakeable<ReturnedSnapshot>();

          await client(context, self, context.key).subscribe({
            condition: request.condition,
            awakeableId: id,
          });

          if (request.event) {
            sendClient(context, self, context.key).send(request.event);
          }

          try {
            return request.timeout !== undefined
              ? await promise.orTimeout(request.timeout)
              : await promise;
          } catch (e) {
            if (!(e instanceof restate.TerminalError)) throw e;
            if (e.code != 500) throw e;
            // awakeable rejection -> 412 so clients know it is non-transient
            throw new restate.TerminalError(e.message, { errorCode: 412 });
          }
        },
      ),

      cleanupState: restate.handlers.object.exclusive(
        { ingressPrivate: true },
        async (context: restate.ObjectContext) => {
          markDisposedAndClear(context);
        },
      ),
    } satisfies MachineVirtualObject<M>,
    options,
  });
}
