import * as restate from "@restatedev/restate-sdk";
import type { AnyEventObject, AnyStateMachine, EventFrom } from "xstate";
import {
  createDoneActorEvent,
  createNormalizedErrorActorEvent,
} from "../../xstate/actors";
import { evaluateCondition } from "../../xstate/conditions";
import { fromStored, toReturnedSnapshot } from "../../xstate/snapshot";
import type { ReturnedSnapshot } from "../../xstate/types";
import { client, sendClient } from "../effects";
import { runActor } from "../run-actor";
import {
  getMachineId,
  getScheduled,
  getSubscriptions,
  markDisposedAndClear,
  setScheduled,
  setSubscriptions,
} from "../state";
import type {
  ActorDoneRequest,
  ActorErrorRequest,
  ExecuteRequest,
  ScheduledEvent,
  StandardSchema,
  SubscribeRequest,
  WaitForRequest,
} from "../types";
import { getRequiredState, validateNotDisposed } from "./guards";
import type { MachineObjectRuntime } from "./runtime";
import { resolveMachine } from "./runtime";
import { applyEvent, consumeActorExecution } from "./transitions";
import {
  parsePublicEvent,
  validateCondition,
  validatePublicEvent,
} from "./validation";

export async function sendPublicEvent<M extends AnyStateMachine>(
  runtime: MachineObjectRuntime<M>,
  context: restate.ObjectContext,
  event: EventFrom<M>,
): Promise<void> {
  validatePublicEvent(event);
  await validateNotDisposed(context);
  await getRequiredState(context);
  await applyEvent(runtime, context, event);
}

export async function handleActorDone(
  runtime: MachineObjectRuntime,
  context: restate.ObjectContext,
  request: ActorDoneRequest,
): Promise<void> {
  const isCurrent = await consumeActorExecution(
    context,
    request.actorId,
    request.executionId,
  );
  if (!isCurrent) return;

  await applyEvent(
    runtime,
    context,
    createDoneActorEvent(request.actorId, request.output),
  );
}

export async function handleActorError(
  runtime: MachineObjectRuntime,
  context: restate.ObjectContext,
  request: ActorErrorRequest,
): Promise<void> {
  const isCurrent = await consumeActorExecution(
    context,
    request.actorId,
    request.executionId,
  );
  if (!isCurrent) return;

  await applyEvent(
    runtime,
    context,
    createNormalizedErrorActorEvent(request.actorId, request.error),
  );
}

export async function handleScheduledEvent(
  runtime: MachineObjectRuntime,
  context: restate.ObjectContext,
  request: ScheduledEvent,
): Promise<void> {
  const scheduled = await getScheduled(context);
  const entry = scheduled[request.sendId];
  if (!entry || entry.uuid !== request.uuid) return;

  delete scheduled[request.sendId];
  setScheduled(context, scheduled);

  if (entry.targetKey === context.key) {
    await applyEvent(runtime, context, entry.event);
  } else {
    sendClient(context, runtime.self, entry.targetKey).deliverEvent(
      entry.event,
    );
  }
}

export async function executeActor(
  runtime: MachineObjectRuntime,
  context: restate.ObjectSharedContext,
  request: ExecuteRequest,
): Promise<void> {
  const machine = resolveMachine(runtime, await getMachineId(context));
  const outcome = await runActor(machine, request.params, context);
  const target = sendClient(context, runtime.self, context.key);

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
}

export async function getSnapshot(
  runtime: MachineObjectRuntime,
  context: restate.ObjectContext,
): Promise<ReturnedSnapshot> {
  await validateNotDisposed(context);
  const stored = await getRequiredState(context);
  const machine = resolveMachine(runtime, await getMachineId(context));
  return toReturnedSnapshot(fromStored(machine, stored));
}

export async function subscribe(
  runtime: MachineObjectRuntime,
  context: restate.ObjectContext,
  request: SubscribeRequest,
): Promise<void> {
  await validateNotDisposed(context);
  const stored = await getRequiredState(context);
  validateCondition(request.condition);

  const machine = resolveMachine(runtime, await getMachineId(context));
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
}

export async function waitFor<M extends AnyStateMachine>(
  runtime: MachineObjectRuntime<M>,
  eventSchema: StandardSchema<EventFrom<M>> | undefined,
  context: restate.ObjectSharedContext,
  request: WaitForRequest<M>,
): Promise<ReturnedSnapshot> {
  await validateNotDisposed(context);
  await getRequiredState(context);
  validateCondition(request.condition);

  const event = parseOptionalEvent(eventSchema, request.event);
  const { id, promise } = context.awakeable<ReturnedSnapshot>();

  await client(context, runtime.self, context.key).subscribe({
    condition: request.condition,
    awakeableId: id,
  });

  if (event !== undefined) {
    sendClient(context, runtime.self, context.key).deliverEvent(event);
  }

  try {
    return request.timeout !== undefined
      ? await promise.orTimeout(request.timeout)
      : await promise;
  } catch (error) {
    if (!(error instanceof restate.TerminalError)) throw error;
    if (error.code !== 500) throw error;
    // Awakeable rejection -> 412 so clients know it is non-transient.
    throw new restate.TerminalError(error.message, { errorCode: 412 });
  }
}

export async function cleanupState(
  context: restate.ObjectContext,
): Promise<void> {
  markDisposedAndClear(context);
}

function parseOptionalEvent<M extends AnyStateMachine>(
  schema: StandardSchema<EventFrom<M>> | undefined,
  event: EventFrom<M> | undefined,
): AnyEventObject | undefined {
  return event === undefined ? undefined : parsePublicEvent(schema, event);
}
