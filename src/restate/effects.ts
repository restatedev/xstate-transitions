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
  HandlerCtx,
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
  h: HandlerCtx,
  target: Target,
  children: Record<string, ChildRecord>,
): string | undefined {
  switch (target.type) {
    case "self":
      return h.ctx.key;
    case "parent":
      return h.parentKey;
    case "child":
      return children[target.childId]?.key;
  }
}

/** Execute the abstract effects produced by a pure step against Restate. */
export async function executeEffects(
  h: HandlerCtx,
  effects: Effect[],
): Promise<void> {
  const scheduled = await getScheduled(h.ctx);
  const children = await getChildren(h.ctx);
  let scheduledChanged = false;
  let childrenChanged = false;

  for (const effect of effects) {
    switch (effect.kind) {
      case "runPromise": {
        sendClient(h.ctx, h.self, h.ctx.key).executeActor({
          params: effect.params,
        });
        break;
      }
      case "startChild": {
        const key = `${h.ctx.key}::${effect.childId}`;
        children[effect.childId] = { key, machineId: effect.machineId };
        childrenChanged = true;
        sendClient(h.ctx, h.self, key).initChild({
          machineId: effect.machineId,
          parentKey: h.ctx.key,
          invokeId: effect.childId,
          input: effect.input,
        });
        break;
      }
      case "send": {
        const key = resolveTarget(h, effect.target, children);
        if (key) sendClient(h.ctx, h.self, key).send(effect.event);
        break;
      }
      case "scheduleSend": {
        const key = resolveTarget(h, effect.target, children);
        if (!key) break;
        const uuid = h.ctx.rand.uuidv4();
        scheduled[effect.sendId] = {
          uuid,
          targetKey: key,
          event: effect.event,
        };
        scheduledChanged = true;
        sendClient(h.ctx, h.self, h.ctx.key).deliverScheduled(
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

  if (scheduledChanged) setScheduled(h.ctx, scheduled);
  if (childrenChanged) setChildren(h.ctx, children);
}

/** Resolve/reject awakeables whose condition is now decided by the snapshot. */
export async function settleSubscriptions(
  h: HandlerCtx,
  returned: ReturnedSnapshot,
): Promise<void> {
  const subscriptions = await getSubscriptions(h.ctx);

  let changed = false;
  for (const [condition, subscription] of Object.entries(subscriptions)) {
    const outcome = evaluateCondition(returned, condition);
    if (outcome.status === "pending") continue;
    for (const awakeable of subscription.awakeables) {
      if (outcome.status === "resolve") {
        h.ctx.resolveAwakeable(awakeable, outcome.snapshot);
      } else {
        h.ctx.rejectAwakeable(awakeable, outcome.reason);
      }
    }
    delete subscriptions[condition];
    changed = true;
  }

  if (changed) setSubscriptions(h.ctx, subscriptions);
}

/** If this is a child instance, report its terminal state back to the parent. */
export async function reportTerminal(
  h: HandlerCtx,
  returned: ReturnedSnapshot,
): Promise<void> {
  if (h.parentKey == null || h.invokeId == null) return;
  if (returned.status !== "done" && returned.status !== "error") return;
  if (await wasReported(h.ctx)) return;
  markReported(h.ctx);

  const parent = sendClient(h.ctx, h.self, h.parentKey);
  if (returned.status === "done") {
    parent.send({
      type: `xstate.done.actor.${h.invokeId}`,
      output: returned.output,
    });
  } else {
    parent.send({
      type: `xstate.error.actor.${h.invokeId}`,
      error: normalizeError(returned.error),
    });
  }
}

/** Schedule disposal if the machine reached a final state and a TTL is set. */
export function maybeScheduleCleanup(
  h: HandlerCtx,
  returned: ReturnedSnapshot,
): void {
  if (h.finalStateTTL === undefined) return;
  if (returned.status !== "done") return;
  sendClient(h.ctx, h.self, h.ctx.key).cleanupState(
    restate.rpc.sendOpts({ delay: h.finalStateTTL }),
  );
}
