import type { ObjectContext } from "@restatedev/restate-sdk";

/**
 * The durable KV keys held per machine instance. Centralized so the layout is
 * defined in one place rather than as string literals scattered across handlers.
 */
export const KEYS = {
  /** The serialized machine snapshot (StoredState). */
  state: "state",
  /** `true` once the instance has been disposed after its final state. */
  disposed: "disposed",
  /** Pending waitFor/subscribe awakeables, keyed by condition. */
  subscriptions: "subscriptions",
  /** Pending delayed deliveries, keyed by sendId. */
  scheduled: "scheduled",
  /** Started child machines, keyed by child id. */
  children: "children",
  /** `true` once a child has reported its terminal state to its parent. */
  reported: "reported",
  /** For a child instance: which registered machine it runs. */
  machineId: "machineId",
  /** For a child instance: the parent's object key. */
  parentKey: "parentKey",
  /** For a child instance: the invoke/spawn id it was started under. */
  invokeId: "invokeId",
} as const;

/**
 * Clear the per-run state that both `create` and `_init` reset before starting
 * a fresh instance. Identity keys (machineId/parentKey/invokeId) are handled by
 * the caller since `create` clears them while `_init` sets them.
 */
export function clearRuntimeState(context: ObjectContext): void {
  context.clear(KEYS.disposed);
  context.clear(KEYS.subscriptions);
  context.clear(KEYS.scheduled);
  context.clear(KEYS.children);
  context.clear(KEYS.reported);
}
