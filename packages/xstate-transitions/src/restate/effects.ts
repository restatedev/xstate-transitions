/*
 * Copyright (c) 2025-2026 - Restate Software, Inc., Restate GmbH
 *
 * This file is part of the Restate SDK for Node.js/TypeScript,
 * which is released under the MIT license.
 *
 * You can find a copy of the license in file LICENSE in the root
 * directory of this repository or package, or at
 * https://github.com/restatedev/sdk-typescript/blob/main/LICENSE
 */

import * as restate from "@restatedev/restate-sdk";
import { normalizeError } from "../xstate/actors";
import { evaluateCondition } from "../xstate/conditions";
import type { Effect, ReturnedSnapshot, Target } from "../xstate/types";
import {
  getActorExecutions,
  getChildren,
  getScheduled,
  getSubscriptions,
  markReported,
  setActorExecutions,
  setCleanupToken,
  setChildren,
  setScheduled,
  setSubscriptions,
  wasReported,
} from "./state";
import type {
  ChildRecord,
  HandlerContext,
  MachineVirtualObject,
  ScheduledEvent,
} from "./types";

function resolveTarget(
  handler: HandlerContext,
  target: Target,
  children: Readonly<Record<string, ChildRecord>>,
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
  effects: ReadonlyArray<Effect>,
): Promise<void> {
  if (effects.length === 0) return;

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
        const sender = ctx.objectSendClient<MachineVirtualObject>(
          self,
          ctx.key,
        );
        sender.executeActor({
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
        const sender = ctx.objectSendClient<MachineVirtualObject>(self, key);
        sender.initChild({
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
        if (Object.hasOwn(actorExecutions, effect.childId)) {
          delete actorExecutions[effect.childId];
          actorExecutionsChanged = true;
        }
        const sender = ctx.objectSendClient<MachineVirtualObject>(
          self,
          child.key,
        );
        sender.cleanupState();
        break;
      }
      case "stopPromise": {
        if (Object.hasOwn(actorExecutions, effect.actorId)) {
          delete actorExecutions[effect.actorId];
          actorExecutionsChanged = true;
        }
        break;
      }
      case "send": {
        const key = resolveTarget(handler, effect.target, children);
        if (key === undefined) break;
        const sender = ctx.objectSendClient<MachineVirtualObject>(self, key);
        sender.deliverEvent(effect.event);
        break;
      }
      case "scheduleSend": {
        const key = resolveTarget(handler, effect.target, children);
        if (key === undefined) break;
        const uuid = ctx.rand.uuidv4();
        const sendId = effect.sendId ?? uuid;
        scheduled[sendId] = {
          uuid,
          targetKey: key,
          event: effect.event,
        };
        scheduledChanged = true;
        const sender = ctx.objectSendClient<MachineVirtualObject>(
          self,
          ctx.key,
        );
        const options = restate.rpc.sendOpts<ScheduledEvent>({
          delay: effect.delay,
        });
        sender.deliverScheduled({ sendId, uuid }, options);
        break;
      }
      case "cancel": {
        if (Object.hasOwn(scheduled, effect.sendId)) {
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
  if (
    parentKey === undefined ||
    invokeId === undefined ||
    executionId === undefined
  ) {
    return;
  }
  if (returned.status !== "done" && returned.status !== "error") return;
  if (await wasReported(ctx)) return;
  markReported(ctx);

  const parent = ctx.objectSendClient<MachineVirtualObject>(self, parentKey);
  if (returned.status === "done") {
    parent.actorDone({
      actorId: invokeId,
      executionId,
      output: returned.output,
    });
  } else {
    const error = normalizeError(returned.error);
    parent.actorError({
      actorId: invokeId,
      executionId,
      error,
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
  const token = ctx.rand.uuidv4();
  setCleanupToken(ctx, token);
  const sender = ctx.objectSendClient<MachineVirtualObject>(self, ctx.key);
  const options = restate.rpc.sendOpts<{ token: string }>({
    delay: finalStateTTL,
  });
  sender.cleanupFinalState({ token }, options);
}
