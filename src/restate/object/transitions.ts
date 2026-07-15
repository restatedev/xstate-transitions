import type * as restate from "@restatedev/restate-sdk";
import type { AnyEventObject, AnyStateMachine, InputFrom } from "xstate";
import { initialStep, resumeStep } from "../../xstate/interpret";
import type { ResumeInput, Step, StoredState } from "../../xstate/types";
import {
  executeEffects,
  maybeScheduleCleanup,
  reportTerminal,
  settleSubscriptions,
} from "../effects";
import {
  clearIdentity,
  clearRuntimeState,
  getActorExecutions,
  getChildren,
  getExecutionId,
  getInvokeId,
  getMachineId,
  getParentKey,
  getState,
  setActorExecutions,
  setIdentity,
  setState,
} from "../state";
import type { ChildRecord, HandlerContext, InitRequest } from "../types";
import type { MachineRuntime } from "./runtime";

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

/** Start or replace a root instance from its initial transition. */
export async function initializeRoot<M extends AnyStateMachine>(
  runtime: MachineRuntime<M>,
  context: restate.ObjectContext,
  input: InputFrom<M>,
): Promise<void> {
  clearRuntimeState(context);
  clearIdentity(context);

  const handler = await buildHandlerContext(runtime, context);
  const result = await computeStep(context, "create", () =>
    initialStep(runtime.rootMachine, { input, isChild: false }),
  );
  await commitStep(handler, result);
}

/** Start or replace a child instance and persist its parent identity. */
export async function initializeChild(
  runtime: MachineRuntime,
  context: restate.ObjectContext,
  request: InitRequest,
): Promise<void> {
  clearRuntimeState(context);
  setIdentity(context, request);

  const handler = await buildHandlerContext(runtime, context);
  const result = await computeStep(context, "initChild", () =>
    initialStep(runtime.resolveMachine(request.machineId), {
      input: request.input,
      isChild: true,
    }),
  );
  await commitStep(handler, result);
}

/** Apply one event to an existing instance; missing internal targets are no-ops. */
export async function applyEvent(
  runtime: MachineRuntime,
  context: restate.ObjectContext,
  event: AnyEventObject,
): Promise<void> {
  const instance = await loadInstance(runtime, context);
  if (instance === null) return;

  const result = await computeEventStep(context, instance, event);
  await commitStep(instance.handler, result);
}

/** Accept an actor result only when it belongs to the current execution. */
export async function consumeActorExecution(
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

async function buildHandlerContext(
  runtime: MachineRuntime,
  context: restate.ObjectContext,
): Promise<HandlerContext> {
  const parentKey = await getParentKey(context);
  const invokeId = await getInvokeId(context);
  const executionId = await getExecutionId(context);

  return {
    ctx: context,
    self: runtime.self,
    ...(parentKey === null ? {} : { parentKey }),
    ...(invokeId === null ? {} : { invokeId }),
    ...(executionId === null ? {} : { executionId }),
    ...(runtime.finalStateTTL === undefined
      ? {}
      : { finalStateTTL: runtime.finalStateTTL }),
  };
}

async function loadInstance(
  runtime: MachineRuntime,
  context: restate.ObjectContext,
): Promise<LoadedInstance | null> {
  const stored = await getState(context);
  if (stored === null) return null;

  const handler = await buildHandlerContext(runtime, context);
  const machine = runtime.resolveMachine(await getMachineId(context));
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

// Machine transitions may run synchronous user code such as assign actions.
// Recording the Step keeps replay deterministic without constraining that code.
function computeStep(
  context: restate.ObjectContext,
  label: string,
  compute: () => Step,
): Promise<Step> {
  return context.run(label, compute);
}

async function commitStep(
  handler: HandlerContext,
  result: Step,
): Promise<void> {
  setState(handler.ctx, result.nextState);
  await executeEffects(handler, result.effects);
  await settleSubscriptions(handler, result.returned);
  await reportTerminal(handler, result.returned);
  maybeScheduleCleanup(handler, result.returned);
}
