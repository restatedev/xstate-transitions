import * as restate from "@restatedev/restate-sdk";
import type { ObjectSharedContext } from "@restatedev/restate-sdk";
import { evaluateCondition } from "../xstate/conditions";
import { normalizeError } from "../xstate/actors";
import {
  getScheduled,
  setScheduled,
  getChildren,
  setChildren,
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
  initChild(request: InitRequest): void;
  deliverScheduled(request: ScheduledEvent, opts?: SendOpts): void;
  send(event: unknown, opts?: SendOpts): void;
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
  let scheduledChanged = false;
  let childrenChanged = false;

  for (const effect of effects) {
    switch (effect.kind) {
      case "runPromise": {
        sendClient(ctx, self, ctx.key).executeActor({ params: effect.params });
        break;
      }
      case "startChild": {
        const key = `${ctx.key}::${effect.childId}`;
        children[effect.childId] = { key, machineId: effect.machineId };
        childrenChanged = true;
        sendClient(ctx, self, key).initChild({
          machineId: effect.machineId,
          parentKey: ctx.key,
          invokeId: effect.childId,
          input: effect.input,
        });
        break;
      }
      case "send": {
        const key = resolveTarget(handler, effect.target, children);
        if (key) sendClient(ctx, self, key).send(effect.event);
        break;
      }
      case "scheduleSend": {
        const key = resolveTarget(handler, effect.target, children);
        if (!key) break;
        const uuid = ctx.rand.uuidv4();
        scheduled[effect.sendId] = {
          uuid,
          targetKey: key,
          event: effect.event,
        };
        scheduledChanged = true;
        sendClient(ctx, self, ctx.key).deliverScheduled(
          { sendId: effect.sendId, uuid },
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
    }
  }

  if (scheduledChanged) setScheduled(ctx, scheduled);
  if (childrenChanged) setChildren(ctx, children);
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
  const { ctx, self, parentKey, invokeId } = handler;
  if (parentKey == null || invokeId == null) return;
  if (returned.status !== "done" && returned.status !== "error") return;
  if (await wasReported(ctx)) return;
  markReported(ctx);

  const parent = sendClient(ctx, self, parentKey);
  if (returned.status === "done") {
    parent.send({
      type: `xstate.done.actor.${invokeId}`,
      output: returned.output,
    });
  } else {
    parent.send({
      type: `xstate.error.actor.${invokeId}`,
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
