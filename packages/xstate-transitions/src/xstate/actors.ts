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

import type {
  AnyStateMachine,
  DoneActorEvent,
  ErrorActorEvent,
  InvokeConfig,
} from "xstate";

/** Plain error data safe to persist and send between Restate handlers. */
export interface NormalizedError {
  name: string;
  message: string;
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
  const indexStr = match[1];
  const nodeId = match[2];
  if (indexStr === undefined || nodeId === undefined) return undefined;
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
export function normalizeError(error: unknown): NormalizedError {
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

/** Build an actor error event from error data that is already normalized. */
export function createNormalizedErrorActorEvent(
  invokeId: string,
  error: NormalizedError,
): ErrorActorEvent {
  return {
    type: `xstate.error.actor.${invokeId}`,
    error,
    actorId: invokeId,
  };
}
