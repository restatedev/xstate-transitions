import type { AnyStateMachine, InputFrom, EventFrom } from "xstate";
import * as restate from "@restatedev/restate-sdk";
import { buildRegistry } from "../xstate/registry";
import { fromStored, toReturnedSnapshot } from "../xstate/snapshot";
import type { StoredState, ReturnedSnapshot } from "../xstate/snapshot";
import { evaluateCondition, isValidCondition } from "../xstate/conditions";
import { step } from "../xstate/interpret";
import {
  selfDef,
  sendClient,
  client,
  executeEffects,
  settleSubscriptions,
  reportTerminal,
  maybeScheduleCleanup,
  type HandlerCtx,
} from "./effects";
import { runActor } from "./run-actor";
import type {
  MachineObjectOptions,
  MachineVirtualObject,
  ExecuteRequest,
  ScheduledEvent,
  ScheduledDelivery,
  InitRequest,
  SubscribeRequest,
  WaitForRequest,
  Subscription,
  ChildRecord,
} from "./types";

async function validateNotDisposed(
  context: restate.ObjectSharedContext,
): Promise<void> {
  if (await context.get<boolean>("disposed")) {
    throw new restate.TerminalError(
      "The state machine has been disposed after reaching it's final state",
      { errorCode: 410 },
    );
  }
}

async function validateExists(
  context: restate.ObjectSharedContext,
): Promise<void> {
  if ((await context.get<StoredState>("state")) == null) {
    throw new restate.TerminalError(
      "No state machine found for this workflow ID. Call 'create' first.",
      { errorCode: 404 },
    );
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

  async function getMachine(
    context: restate.ObjectSharedContext,
  ): Promise<AnyStateMachine> {
    const id = await context.get<string>("machineId");
    return (id != null ? registry.get(id) : undefined) ?? machine;
  }

  async function handlerCtx(
    context: restate.ObjectContext,
  ): Promise<HandlerCtx> {
    return {
      ctx: context,
      self,
      parentKey: (await context.get<string>("parentKey")) ?? undefined,
      invokeId: (await context.get<string>("invokeId")) ?? undefined,
      finalStateTTL,
    };
  }

  async function commit(
    h: HandlerCtx,
    result: ReturnType<typeof step>,
  ): Promise<void> {
    h.ctx.set("state", result.nextState);
    await executeEffects(h, result.effects);
    await settleSubscriptions(h, result.returned);
    await reportTerminal(h, result.returned);
    maybeScheduleCleanup(h, result.returned);
  }

  async function applyEvent(
    context: restate.ObjectContext,
    event: EventFrom<M>,
  ): Promise<void> {
    const stored = await context.get<StoredState>("state");
    if (stored == null) return;
    const instanceMachine = await getMachine(context);
    const h = await handlerCtx(context);
    const knownChildIds = Object.keys(
      (await context.get<Record<string, ChildRecord>>("children")) ?? {},
    );
    const result = step(instanceMachine, {
      stored,
      event,
      isChild: h.parentKey != null,
      knownChildIds,
    });
    await commit(h, result);
  }

  return restate.object({
    name,
    handlers: {
      create: async (context: restate.ObjectContext, input: InputFrom<M>) => {
        context.clear("disposed");
        context.clear("subscriptions");
        context.clear("scheduled");
        context.clear("children");
        context.clear("reported");
        context.clear("machineId");
        context.clear("parentKey");
        context.clear("invokeId");

        const h = await handlerCtx(context);
        const result = step(machine, {
          stored: null,
          input,
          isChild: false,
          knownChildIds: [],
        });
        await commit(h, result);
      },

      _init: restate.handlers.object.exclusive(
        { ingressPrivate: true },
        async (context: restate.ObjectContext, request: InitRequest) => {
          context.clear("disposed");
          context.clear("subscriptions");
          context.clear("scheduled");
          context.clear("children");
          context.clear("reported");
          context.set("machineId", request.machineId);
          context.set("parentKey", request.parentKey);
          context.set("invokeId", request.invokeId);

          const childMachine = registry.get(request.machineId) ?? machine;
          const h = await handlerCtx(context);
          const result = step(childMachine, {
            stored: null,
            input: request.input,
            isChild: true,
            knownChildIds: [],
          });
          await commit(h, result);
        },
      ),

      send: async (context: restate.ObjectContext, event: EventFrom<M>) => {
        await validateNotDisposed(context);
        await validateExists(context);
        await applyEvent(context, event);
      },

      _scheduled: restate.handlers.object.exclusive(
        { ingressPrivate: true },
        async (context: restate.ObjectContext, request: ScheduledEvent) => {
          const scheduled =
            (await context.get<Record<string, ScheduledDelivery>>(
              "scheduled",
            )) ?? {};
          const entry = scheduled[request.sendId];
          if (!entry || entry.uuid !== request.uuid) return;

          delete scheduled[request.sendId];
          context.set("scheduled", scheduled);

          if (entry.targetKey === context.key) {
            await applyEvent(context, entry.event as EventFrom<M>);
          } else {
            sendClient(context, self, entry.targetKey).send(entry.event);
          }
        },
      ),

      _execute: restate.handlers.object.shared(
        { ingressPrivate: true, enableLazyState: true },
        async (
          context: restate.ObjectSharedContext,
          request: ExecuteRequest,
        ) => {
          const instanceMachine = await getMachine(context);
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
        const instanceMachine = await getMachine(context);
        const stored = (await context.get<StoredState>("state"))!;
        return toReturnedSnapshot(fromStored(instanceMachine, stored));
      },

      subscribe: async (
        context: restate.ObjectContext,
        request: SubscribeRequest,
      ) => {
        await validateNotDisposed(context);
        await validateExists(context);
        if (!isValidCondition(request.condition)) {
          throw new restate.TerminalError("Invalid subscription condition", {
            errorCode: 400,
          });
        }

        const instanceMachine = await getMachine(context);
        const stored = (await context.get<StoredState>("state"))!;
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

        const subscriptions =
          (await context.get<Record<string, Subscription>>("subscriptions")) ??
          {};
        const existing = subscriptions[request.condition];
        if (existing) {
          existing.awakeables.push(request.awakeableId);
        } else {
          subscriptions[request.condition] = {
            awakeables: [request.awakeableId],
          };
        }
        context.set("subscriptions", subscriptions);
      },

      waitFor: restate.handlers.object.shared(
        async (
          context: restate.ObjectSharedContext,
          request: WaitForRequest<M>,
        ): Promise<ReturnedSnapshot> => {
          await validateNotDisposed(context);
          await validateExists(context);
          if (!isValidCondition(request.condition)) {
            throw new restate.TerminalError("Invalid subscription condition", {
              errorCode: 400,
            });
          }

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
            throw new restate.TerminalError(e.message, { errorCode: 412 });
          }
        },
      ),

      cleanupState: restate.handlers.object.exclusive(
        { ingressPrivate: true },

        async (context: restate.ObjectContext) => {
          context.clearAll();
          context.set("disposed", true);
        },
      ),
    } satisfies MachineVirtualObject<M>,
    options,
  });
}
