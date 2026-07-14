import type {
  AnyStateMachine,
  DoneActorEvent,
  ErrorActorEvent,
  InvokeConfig,
} from "xstate";

/** Sentinel marking a Restate-aware promise actor (see restate/promise.ts). */
export const RESTATE_PROMISE_ACTOR = "restate.promise.actor";

export function isRestatePromiseActor(logic: unknown): logic is {
  sentinel: typeof RESTATE_PROMISE_ACTOR;
  config: (args: { input: unknown; ctx: unknown }) => unknown;
} {
  return (
    typeof logic === "object" &&
    logic !== null &&
    (logic as { sentinel?: unknown }).sentinel === RESTATE_PROMISE_ACTOR
  );
}

/**
 * Resolve the actor logic referenced by an invoke/spawn `src`. Named actors
 * resolve via the machine's implementations; synthesized inline invoke names
 * (`xstate.invoke.<index>.<nodeId>`) resolve via the state node's invoke config.
 */
export function resolveReferencedActor(
  machine: AnyStateMachine,
  src: string,
): unknown {
  const match = src.match(/^xstate\.invoke\.(\d+)\.(.*)/);
  if (!match) {
    return machine.implementations.actors[src];
  }
  const [, indexStr, nodeId] = match;
  const node = machine.getStateNodeById(nodeId);
  const invokeConfig = node.config.invoke;
  if (invokeConfig === undefined) return undefined;
  return (
    Array.isArray(invokeConfig)
      ? invokeConfig[Number(indexStr)]
      : (invokeConfig as InvokeConfig<
          never,
          never,
          never,
          never,
          never,
          never,
          never,
          never
        >)
  ).src;
}

export function createDoneActorEvent(
  invokeId: string,
  output?: unknown,
): DoneActorEvent {
  return {
    type: `xstate.done.actor.${invokeId}`,
    output,
    actorId: invokeId,
  };
}

/** Normalize any thrown value into a serializable, guard-friendly shape. */
export function normalizeError(error: unknown): {
  name: string;
  message: string;
} {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Error", message: String(error) };
}

export function createErrorActorEvent(
  invokeId: string,
  error: unknown,
): ErrorActorEvent {
  return {
    type: `xstate.error.actor.${invokeId}`,
    error: normalizeError(error),
    actorId: invokeId,
  };
}
