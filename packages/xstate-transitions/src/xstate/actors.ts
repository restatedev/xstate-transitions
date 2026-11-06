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

import type { AnyStateMachine, DoneActorEvent, ErrorActorEvent } from "xstate";

/** Plain error data safe to persist and send between Restate handlers. */
export interface NormalizedError {
  name: string;
  message: string;
}

/**
 * Resolve the actor logic referenced by an invoke/spawn `src`. Named actors
 * resolve via the machine's actor sources; synthesized inline invoke names
 * (`xstate.invoke.<index>.<nodeId>`) resolve via the state node's invoke config.
 */
export function resolveReferencedActor(
  machine: AnyStateMachine,
  src: string,
): unknown {
  const match = src.match(/^xstate\.invoke\.(\d+)\.(.*)/);
  if (!match) {
    return machine.sources.actors[src];
  }
  const indexStr = match[1];
  const nodeId = match[2];
  if (indexStr === undefined || nodeId === undefined) return undefined;
  const node = machine.getStateNodeById(nodeId);
  const invokeConfig = node.config.invoke;
  if (invokeConfig === undefined) return undefined;
  // We only need the `src` off the invoke config; a minimal shape avoids
  // coupling to xstate's generic InvokeConfig arity.
  const entry = Array.isArray(invokeConfig)
    ? invokeConfig[Number(indexStr)]
    : invokeConfig;
  return (entry as { src?: unknown } | undefined)?.src;
}

/** The parts of a state node we walk to find an inline invoke's logic. */
interface InvokingNode {
  id: string;
  config: { invoke?: unknown };
  states: Record<string, InvokingNode>;
}

/**
 * The inverse of {@link resolveReferencedActor} for inline invoke logic. XState
 * reports an inline invoke's `src` as the logic object itself, which cannot
 * cross a Restate call; this names it by its invoke definition
 * (`xstate.invoke.<index>.<nodeId>`) so the actor runner can resolve it again.
 * Returns `undefined` when the logic is not an inline invoke of `machine`.
 */
export function referenceInlineActor(
  machine: AnyStateMachine,
  logic: unknown,
): string | undefined {
  const visit = (node: InvokingNode): string | undefined => {
    const invoke = node.config.invoke;
    const entries = invoke === undefined ? [] : [invoke].flat();
    const index = entries.findIndex(
      (entry) => (entry as { src?: unknown } | undefined)?.src === logic,
    );
    if (index !== -1) return `xstate.invoke.${index}.${node.id}`;
    for (const child of Object.values(node.states)) {
      const found = visit(child);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return visit(machine.root as unknown as InvokingNode);
}

export function createDoneActorEvent(
  invokeId: string,
  output?: unknown,
): DoneActorEvent {
  return {
    type: "xstate.done.actor",
    output,
    actorId: invokeId,
    sessionId: invokeId,
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
    type: "xstate.error.actor",
    error: normalizeError(error),
    actorId: invokeId,
    sessionId: invokeId,
  };
}

/** Build an actor error event from error data that is already normalized. */
export function createNormalizedErrorActorEvent(
  invokeId: string,
  error: NormalizedError,
): ErrorActorEvent {
  return {
    type: "xstate.error.actor",
    error,
    actorId: invokeId,
    sessionId: invokeId,
  };
}
