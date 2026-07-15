import type {
  ObjectContext,
  ObjectSharedContext,
} from "@restatedev/restate-sdk";
import type { StoredState } from "../xstate/types";
import type { ScheduledDelivery, ChildRecord, Subscription } from "./types";

// ---------------------------------------------------------------------------
// All durable KV access for a machine instance goes through this module, so the
// key layout and the "empty map default" live in one place and the handlers
// read as plain named operations rather than generic get/set with string keys.
// ---------------------------------------------------------------------------

const KEYS = {
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
  /** Active promise/child generation, keyed by actor id. */
  actorExecutions: "actorExecutions",
  /** `true` once a child has reported its terminal state to its parent. */
  reported: "reported",
  /** For a child instance: which registered machine it runs. */
  machineId: "machineId",
  /** For a child instance: the parent's object key. */
  parentKey: "parentKey",
  /** For a child instance: the invoke/spawn id it was started under. */
  invokeId: "invokeId",
  /** For a child instance: the unique generation of this invocation. */
  executionId: "executionId",
} as const;

// --- reads -----------------------------------------------------------------

export function getState(
  ctx: ObjectSharedContext,
): Promise<StoredState | null> {
  return ctx.get<StoredState>(KEYS.state);
}

export async function isDisposed(ctx: ObjectSharedContext): Promise<boolean> {
  return (await ctx.get<boolean>(KEYS.disposed)) ?? false;
}

export async function wasReported(ctx: ObjectSharedContext): Promise<boolean> {
  return (await ctx.get<boolean>(KEYS.reported)) ?? false;
}

export function getMachineId(ctx: ObjectSharedContext): Promise<string | null> {
  return ctx.get<string>(KEYS.machineId);
}

export function getParentKey(ctx: ObjectSharedContext): Promise<string | null> {
  return ctx.get<string>(KEYS.parentKey);
}

export function getInvokeId(ctx: ObjectSharedContext): Promise<string | null> {
  return ctx.get<string>(KEYS.invokeId);
}

export function getExecutionId(
  ctx: ObjectSharedContext,
): Promise<string | null> {
  return ctx.get<string>(KEYS.executionId);
}

export async function getScheduled(
  ctx: ObjectSharedContext,
): Promise<Record<string, ScheduledDelivery>> {
  return (
    (await ctx.get<Record<string, ScheduledDelivery>>(KEYS.scheduled)) ?? {}
  );
}

export async function getChildren(
  ctx: ObjectSharedContext,
): Promise<Record<string, ChildRecord>> {
  return (await ctx.get<Record<string, ChildRecord>>(KEYS.children)) ?? {};
}

export async function getActorExecutions(
  ctx: ObjectSharedContext,
): Promise<Record<string, string>> {
  return (await ctx.get<Record<string, string>>(KEYS.actorExecutions)) ?? {};
}

export async function getSubscriptions(
  ctx: ObjectSharedContext,
): Promise<Record<string, Subscription>> {
  return (
    (await ctx.get<Record<string, Subscription>>(KEYS.subscriptions)) ?? {}
  );
}

// --- writes ----------------------------------------------------------------

export function setState(ctx: ObjectContext, state: StoredState): void {
  ctx.set(KEYS.state, state);
}

export function setScheduled(
  ctx: ObjectContext,
  scheduled: Record<string, ScheduledDelivery>,
): void {
  ctx.set(KEYS.scheduled, scheduled);
}

export function setChildren(
  ctx: ObjectContext,
  children: Record<string, ChildRecord>,
): void {
  ctx.set(KEYS.children, children);
}

export function setActorExecutions(
  ctx: ObjectContext,
  executions: Record<string, string>,
): void {
  ctx.set(KEYS.actorExecutions, executions);
}

export function setSubscriptions(
  ctx: ObjectContext,
  subscriptions: Record<string, Subscription>,
): void {
  ctx.set(KEYS.subscriptions, subscriptions);
}

export function markReported(ctx: ObjectContext): void {
  ctx.set(KEYS.reported, true);
}

export function markDisposedAndClear(ctx: ObjectContext): void {
  ctx.clearAll();
  ctx.set(KEYS.disposed, true);
}

export function setIdentity(
  ctx: ObjectContext,
  identity: {
    machineId: string;
    parentKey: string;
    invokeId: string;
    executionId: string;
  },
): void {
  ctx.set(KEYS.machineId, identity.machineId);
  ctx.set(KEYS.parentKey, identity.parentKey);
  ctx.set(KEYS.invokeId, identity.invokeId);
  ctx.set(KEYS.executionId, identity.executionId);
}

/**
 * Clear the per-run state that both `create` and `initChild` reset before
 * starting a fresh instance. `create` additionally clears identity (below);
 * `initChild` sets it via {@link setIdentity}.
 */
export function clearRuntimeState(ctx: ObjectContext): void {
  ctx.clear(KEYS.disposed);
  ctx.clear(KEYS.subscriptions);
  ctx.clear(KEYS.scheduled);
  ctx.clear(KEYS.children);
  ctx.clear(KEYS.actorExecutions);
  ctx.clear(KEYS.reported);
}

export function clearIdentity(ctx: ObjectContext): void {
  ctx.clear(KEYS.machineId);
  ctx.clear(KEYS.parentKey);
  ctx.clear(KEYS.invokeId);
  ctx.clear(KEYS.executionId);
}
