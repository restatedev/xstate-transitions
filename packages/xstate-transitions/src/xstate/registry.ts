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

import type { AnyStateMachine, AnyStateNode } from "xstate";

/** Duck-typed check: a state machine (unlike a promise/plain actor) exposes getStateNodeById. */
export function isMachine(logic: unknown): logic is AnyStateMachine {
  return (
    typeof logic === "object" &&
    logic !== null &&
    typeof (logic as { getStateNodeById?: unknown }).getStateNodeById ===
      "function"
  );
}

function walkNodes(node: AnyStateNode, fn: (n: AnyStateNode) => void): void {
  fn(node);
  for (const child of Object.values(node.states ?? {})) {
    walkNodes(child, fn);
  }
}

/**
 * Build a registry of every machine reachable from the root — the root itself,
 * child machines registered via `setup({ actors })`, and child machines
 * referenced directly as `invoke: { src: childMachine }`. Keyed by machine id so
 * a child instance can resolve which machine to run.
 */
export function buildRegistry(
  root: AnyStateMachine,
): Map<string, AnyStateMachine> {
  const registry = new Map<string, AnyStateMachine>();

  const visit = (m: AnyStateMachine) => {
    const existing = registry.get(m.id);
    if (existing === m) return;
    if (existing !== undefined) {
      throw new Error(
        `Machine id "${m.id}" is used by more than one machine. ` +
          "Every machine in a durable actor tree must have a unique id.",
      );
    }
    registry.set(m.id, m);

    const actors = (m.implementations?.actors ?? {}) as Record<string, unknown>;
    for (const actor of Object.values(actors)) {
      if (isMachine(actor)) visit(actor);
    }

    walkNodes(m.root, (node) => {
      const inv = (node.config as { invoke?: unknown }).invoke;
      const invokes = Array.isArray(inv) ? inv : inv ? [inv] : [];
      for (const entry of invokes) {
        const src = (entry as { src?: unknown }).src;
        if (isMachine(src)) visit(src);
      }
    });
  };

  visit(root);
  return registry;
}
