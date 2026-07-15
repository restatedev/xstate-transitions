import type { AnyStateMachine, AnyMachineSnapshot, SnapshotFrom } from "xstate";
import type { StoredState, ReturnedSnapshot } from "./types";

// A raw xstate snapshot exposes more than we persist, and its `historyValue`
// holds live StateNode instances. These local views describe just the fields we
// read off it, so the reads below need no inline casts.
interface RawSnapshot {
  value: unknown;
  context: unknown;
  status: string;
  output?: unknown;
  error?: unknown;
  historyValue?: Record<string, { id: string }[]>;
  tags?: Set<string>;
}

function asRaw(snapshot: AnyMachineSnapshot): RawSnapshot {
  return snapshot as unknown as RawSnapshot;
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
  historyValue: Record<string, string[]>,
): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const [key, ids] of Object.entries(historyValue)) {
    out[key] = ids.map((id) => machine.getStateNodeById(id));
  }
  return out;
}

/** Serialize a live snapshot into the persisted form. */
export function toStored(snapshot: AnyMachineSnapshot): StoredState {
  const s = asRaw(snapshot);
  return {
    value: s.value,
    context: s.context,
    status: s.status,
    output: s.output,
    error: s.error,
    historyValue: serializeHistory(s.historyValue),
  };
}

/** Rehydrate a persisted state back into a live snapshot for transitioning. */
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

/** Project a live snapshot into the plain shape returned to callers. */
export function toReturnedSnapshot(
  snapshot: AnyMachineSnapshot,
): ReturnedSnapshot {
  const s = asRaw(snapshot);
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
