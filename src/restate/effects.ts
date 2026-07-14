import type { AnyStateMachine } from "xstate";
import * as restate from "@restatedev/restate-sdk";
import type { ReturnedSnapshot } from "../xstate/snapshot";
import { evaluateCondition } from "../xstate/conditions";
import { normalizeError } from "../xstate/actors";
import type { Effect, Target } from "../xstate/interpret";
import type {
  MachineVirtualObject,
  ScheduledDelivery,
  ChildRecord,
  Subscription,
  ExecuteRequest,
  ScheduledEvent,
  InitRequest,
  SubscribeRequest,
} from "./types";

type Self = restate.VirtualObjectDefinition<
  string,
  MachineVirtualObject<AnyStateMachine>
>;
type SendOpts = ReturnType<typeof restate.rpc.sendOpts>;

/** Typed one-way client for the machine object (the SDK's conditional inference erases it). */
export interface MachineSendClient {
  _execute(request: ExecuteRequest): void;
  _init(request: InitRequest): void;
  _scheduled(request: ScheduledEvent, opts?: SendOpts): void;
  send(event: unknown, opts?: SendOpts): void;
  cleanupState(opts?: SendOpts): void;
}

/** Typed request-response client for the machine object. */
export interface MachineClient {
  subscribe(request: SubscribeRequest): Promise<void>;
}

/** A fake service definition — objectClient only needs the service name to route. */
export function selfDef(name: string): Self {
  return { name } as Self;
}

export function sendClient(
  context: restate.ObjectSharedContext,
  self: Self,
  key: string,
): MachineSendClient {
  return context.objectSendClient(self, key) as unknown as MachineSendClient;
}

export function client(
  context: restate.ObjectSharedContext,
  self: Self,
  key: string,
): MachineClient {
  return context.objectClient(self, key) as unknown as MachineClient;
}

/** Everything a handler needs to execute effects / react against Restate. */
export interface HandlerCtx {
  ctx: restate.ObjectContext;
  self: Self;
  parentKey?: string;
  invokeId?: string;
  finalStateTTL?: number;
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
  const scheduled =
    (await h.ctx.get<Record<string, ScheduledDelivery>>("scheduled")) ?? {};
  const children =
    (await h.ctx.get<Record<string, ChildRecord>>("children")) ?? {};
  let scheduledChanged = false;
  let childrenChanged = false;

  for (const effect of effects) {
    switch (effect.kind) {
      case "runPromise": {
        sendClient(h.ctx, h.self, h.ctx.key)._execute({
          params: effect.params,
        });
        break;
      }
      case "startChild": {
        const key = `${h.ctx.key}::${effect.childId}`;
        children[effect.childId] = { key, machineId: effect.machineId };
        childrenChanged = true;
        sendClient(h.ctx, h.self, key)._init({
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
        sendClient(h.ctx, h.self, h.ctx.key)._scheduled(
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

  if (scheduledChanged) h.ctx.set("scheduled", scheduled);
  if (childrenChanged) h.ctx.set("children", children);
}

/** Resolve/reject awakeables whose condition is now decided by the snapshot. */
export async function settleSubscriptions(
  h: HandlerCtx,
  returned: ReturnedSnapshot,
): Promise<void> {
  const subscriptions =
    (await h.ctx.get<Record<string, Subscription>>("subscriptions")) ?? {};

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

  if (changed) h.ctx.set("subscriptions", subscriptions);
}

/** If this is a child instance, report its terminal state back to the parent. */
export async function reportTerminal(
  h: HandlerCtx,
  returned: ReturnedSnapshot,
): Promise<void> {
  if (h.parentKey == null || h.invokeId == null) return;
  if (returned.status !== "done" && returned.status !== "error") return;
  if (await h.ctx.get<boolean>("reported")) return;
  h.ctx.set("reported", true);

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
