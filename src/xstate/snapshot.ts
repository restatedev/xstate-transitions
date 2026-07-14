import type { AnyStateMachine, AnyMachineSnapshot, SnapshotFrom } from "xstate";

/**
 * The serializable form of a machine snapshot. Only the fields
 * `machine.resolveState` needs are kept.
 *
 * `historyValue` is stored as node *ids* rather than the live StateNode
 * instances the raw snapshot carries — those instances do not survive JSON
 * serialization, which would otherwise silently break history states.
 */
export interface StoredState {
  value: unknown;
  context: unknown;
  status: string;
  output?: unknown;
  error?: unknown;
  historyValue: Record<string, string[]>;
}

/** The plain, serializable snapshot shape returned to callers. */
export interface ReturnedSnapshot {
  value: unknown;
  context: unknown;
  status: string;
  output?: unknown;
  error?: unknown;
  tags: string[];
}

function serializeHistory(
  historyValue: Record<string, { id: string }[]> | undefined,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, nodes] of Object.entries(historyValue ?? {})) {
    out[key] = nodes.map((node) => node.id);
  }
  return out;
}

function deserializeHistory(
  machine: AnyStateMachine,
  historyValue: Record<string, string[]> | undefined,
): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const [key, ids] of Object.entries(historyValue ?? {})) {
    out[key] = ids.map((id) => machine.getStateNodeById(id));
  }
  return out;
}

export function toStored(snapshot: AnyMachineSnapshot): StoredState {
  const s = snapshot as unknown as {
    value: unknown;
    context: unknown;
    status: string;
    output?: unknown;
    error?: unknown;
    historyValue?: Record<string, { id: string }[]>;
  };
  return {
    value: s.value,
    context: s.context,
    status: s.status,
    output: s.output,
    error: s.error,
    historyValue: serializeHistory(s.historyValue),
  };
}

export function fromStored<M extends AnyStateMachine>(
  machine: M,
  stored: StoredState,
): SnapshotFrom<M> {
  return machine.resolveState({
    value: stored.value,
    context: stored.context,
    status: stored.status,
    output: stored.output,
    error: stored.error,
    historyValue: deserializeHistory(machine, stored.historyValue),
  } as never) as SnapshotFrom<M>;
}

export function toReturnedSnapshot(
  snapshot: AnyMachineSnapshot,
): ReturnedSnapshot {
  const s = snapshot as unknown as {
    value: unknown;
    context: unknown;
    status: string;
    output?: unknown;
    error?: unknown;
    tags?: Set<string>;
  };
  const tags = s.tags ? [...s.tags] : [];
  tags.sort();
  return {
    value: s.value,
    context: s.context,
    status: s.status,
    output: s.output,
    error: s.error,
    tags,
  };
}
