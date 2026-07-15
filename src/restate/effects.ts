import * as restate from "@restatedev/restate-sdk";
import type { ObjectSharedContext } from "@restatedev/restate-sdk";
import type { AnyEventObject } from "xstate";
import { evaluateCondition } from "../xstate/conditions";
import { normalizeError } from "../xstate/actors";
import {
  getScheduled,
  setScheduled,
  getChildren,
  setChildren,
  getActorExecutions,
  setActorExecutions,
  getSubscriptions,
  setSubscriptions,
  wasReported,
  markReported,
} from "./state";
import type { Effect, Target, ReturnedSnapshot } from "../xstate/types";
import type {
  MachineDefinition,
  HandlerContext,
  ChildRecord,
  ExecuteRequest,
  ActorDoneRequest,
  ActorErrorRequest,
  ScheduledEvent,
  InitRequest,
  SubscribeRequest,
} from "./types";

// The SDK's objectSendClient/objectClient use conditional inference that erases
// to `unknown` here, so we describe the handler surface we call and cast once.
type SendOpts = ReturnType<typeof restate.rpc.sendOpts>;

/** One-way (fire-and-forget) client for a machine object. */
interface MachineSendClient {
  executeActor(request: ExecuteRequest): void;
  actorDone(request: ActorDoneRequest): void;
  actorError(request: ActorErrorRequest): void;
  initChild(request: InitRequest): void;
  deliverScheduled(request: ScheduledEvent, opts?: SendOpts): void;
  deliverEvent(event: AnyEventObject, opts?: SendOpts): void;
  cleanupState(opts?: SendOpts): void;
}

/** Request-response client for a machine object. */
interface MachineClient {
  subscribe(request: SubscribeRequest): Promise<void>;
}

/** A fake definition — objectClient only needs the service name to route. */
export function selfDef(name: string): MachineDefinition {
  return { name } as MachineDefinition;
}

export function sendClient(
  context: ObjectSharedContext,
  self: MachineDefinition,
  key: string,
): MachineSendClient {
  return context.objectSendClient(self, key) as unknown as MachineSendClient;
}

export function client(
  context: ObjectSharedContext,
  self: MachineDefinition,
  key: string,
): MachineClient {
  return context.objectClient(self, key) as unknown as MachineClient;
}

function resolveTarget(
  handler: HandlerContext,
  target: Target,
  children: Record<string, ChildRecord>,
): string | undefined {
  switch (target.type) {
    case "self":
      return handler.ctx.key;
    case "parent":
      return handler.parentKey;
    case "child":
      return children[target.childId]?.key;
  }
}

/** Execute the abstract effects produced by a pure step against Restate. */
export async function executeEffects(
  handler: HandlerContext,
  effects: Effect[],
): Promise<void> {
  const { ctx, self } = handler;
  const scheduled = await getScheduled(ctx);
  const children = await getChildren(ctx);
  const actorExecutions = await getActorExecutions(ctx);
  let scheduledChanged = false;
  let childrenChanged = false;
  let actorExecutionsChanged = false;

  for (const effect of effects) {
    switch (effect.kind) {
      case "runPromise": {
        const executionId = ctx.rand.uuidv4();
        actorExecutions[effect.params.id] = executionId;
        actorExecutionsChanged = true;
        sendClient(ctx, self, ctx.key).executeActor({
          params: effect.params,
          executionId,
        });
        break;
      }
      case "startChild": {
        const key = `${ctx.key}::${effect.childId}`;
        const executionId = ctx.rand.uuidv4();
        children[effect.childId] = { key, machineId: effect.machineId };
        childrenChanged = true;
        actorExecutions[effect.childId] = executionId;
        actorExecutionsChanged = true;
        sendClient(ctx, self, key).initChild({
          machineId: effect.machineId,
          parentKey: ctx.key,
          invokeId: effect.childId,
          executionId,
          input: effect.input,
        });
        break;
      }
      case "stopChild": {
        const child = children[effect.childId];
        if (!child) break;
        delete children[effect.childId];
        childrenChanged = true;
        if (actorExecutions[effect.childId]) {
          delete actorExecutions[effect.childId];
          actorExecutionsChanged = true;
        }
        sendClient(ctx, self, child.key).cleanupState();
        break;
      }
      case "stopPromise": {
        if (actorExecutions[effect.actorId]) {
          delete actorExecutions[effect.actorId];
          actorExecutionsChanged = true;
        }
        break;
      }
      case "send": {
        const key = resolveTarget(handler, effect.target, children);
        if (key) sendClient(ctx, self, key).deliverEvent(effect.event);
        break;
      }
      case "scheduleSend": {
        const key = resolveTarget(handler, effect.target, children);
        if (!key) break;
        const uuid = ctx.rand.uuidv4();
        const sendId = effect.sendId ?? uuid;
        scheduled[sendId] = {
          uuid,
          targetKey: key,
          event: effect.event,
        };
        scheduledChanged = true;
        sendClient(ctx, self, ctx.key).deliverScheduled(
          { sendId, uuid },
          restate.rpc.sendOpts({ delay: effect.delay }),
        );
        break;
      }
      case "cancel": {
        if (scheduled[effect.sendId]) {
          delete scheduled[effect.sendId];
          scheduledChanged = true;
        }
        break;
      }
      default:
        assertNever(effect);
    }
  }

  if (scheduledChanged) setScheduled(ctx, scheduled);
  if (childrenChanged) setChildren(ctx, children);
  if (actorExecutionsChanged) setActorExecutions(ctx, actorExecutions);
}

function assertNever(value: never): never {
  throw new Error(`Unsupported effect: ${JSON.stringify(value)}`);
}

/** Resolve/reject awakeables whose condition is now decided by the snapshot. */
export async function settleSubscriptions(
  handler: HandlerContext,
  returned: ReturnedSnapshot,
): Promise<void> {
  const { ctx } = handler;
  const subscriptions = await getSubscriptions(ctx);

  let changed = false;
  for (const [condition, subscription] of Object.entries(subscriptions)) {
    const outcome = evaluateCondition(returned, condition);
    if (outcome.status === "pending") continue;
    for (const awakeable of subscription.awakeables) {
      if (outcome.status === "resolve") {
        ctx.resolveAwakeable(awakeable, outcome.snapshot);
      } else {
        ctx.rejectAwakeable(awakeable, outcome.reason);
      }
    }
    delete subscriptions[condition];
    changed = true;
  }

  if (changed) setSubscriptions(ctx, subscriptions);
}

/** If this is a child instance, report its terminal state back to the parent. */
export async function reportTerminal(
  handler: HandlerContext,
  returned: ReturnedSnapshot,
): Promise<void> {
  const { ctx, self, parentKey, invokeId, executionId } = handler;
  if (parentKey == null || invokeId == null || executionId == null) return;
  if (returned.status !== "done" && returned.status !== "error") return;
  if (await wasReported(ctx)) return;
  markReported(ctx);

  const parent = sendClient(ctx, self, parentKey);
  if (returned.status === "done") {
    parent.actorDone({
      actorId: invokeId,
      executionId,
      output: returned.output,
    });
  } else {
    parent.actorError({
      actorId: invokeId,
      executionId,
      error: normalizeError(returned.error),
    });
  }
}

/** Schedule disposal if the machine reached a final state and a TTL is set. */
export function maybeScheduleCleanup(
  handler: HandlerContext,
  returned: ReturnedSnapshot,
): void {
  const { ctx, self, finalStateTTL } = handler;
  if (finalStateTTL === undefined) return;
  if (returned.status !== "done") return;
  sendClient(ctx, self, ctx.key).cleanupState(
    restate.rpc.sendOpts({ delay: finalStateTTL }),
  );
}
