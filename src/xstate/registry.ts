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
    if (registry.has(m.id)) return;
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
