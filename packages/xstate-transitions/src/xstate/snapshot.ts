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
  AnyMachineSnapshot,
  AnyStateMachine,
  SnapshotFrom,
  SnapshotStatus,
} from "xstate";
import { PARENT_ID, parentRef, stubChildRef } from "./scope";
import type {
  ReturnedSnapshot,
  StoredState,
  StoredTimer,
  Target,
} from "./types";

// A raw xstate snapshot exposes more than we persist, and its `historyValue`
// holds live StateNode instances. These local views describe just the fields we
// read off it, so the reads below need no inline casts.
interface RawSnapshot {
  value: unknown;
  context: unknown;
  status: SnapshotStatus;
  output?: unknown;
  error?: unknown;
  historyValue?: Record<string, { id: string }[]>;
  tags?: Set<string>;
  timers?: readonly LiveTimer[];
  _nextTimerId?: number;
}

/** A pending timer as XState holds it on a live snapshot. */
interface LiveTimer extends Omit<StoredTimer, "target"> {
  target: "self" | { id?: string };
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

function serializeTimerTarget(target: LiveTimer["target"]): Target {
  if (target === "self") return { type: "self" };
  if (target.id === PARENT_ID) return { type: "parent" };
  // Any other target is a child ref. One that is no longer a live child when
  // the timer fires is dropped by the interpreter's routing.
  return { type: "child", childId: String(target.id) };
}

function deserializeTimerTarget(target: Target): LiveTimer["target"] {
  switch (target.type) {
    case "self":
      return "self";
    case "parent":
      return parentRef as LiveTimer["target"];
    case "child":
      // Swapped for the canonical child stub when children are re-injected.
      return stubChildRef(target.childId) as LiveTimer["target"];
  }
}

function serializeTimers(timers: readonly LiveTimer[] | undefined) {
  return (timers ?? []).map((timer): StoredTimer => ({
    ...(timer.id === undefined ? {} : { id: timer.id }),
    ...(timer.seq === undefined ? {} : { seq: timer.seq }),
    delay: timer.delay,
    type: timer.type,
    event: timer.event,
    target: serializeTimerTarget(timer.target),
  }));
}

/** Serialize a live snapshot into the persisted form. */
export function toStored(snapshot: AnyMachineSnapshot): StoredState {
  const raw = asRaw(snapshot);
  return {
    value: raw.value,
    context: raw.context,
    status: raw.status,
    output: raw.output,
    error: raw.error,
    historyValue: serializeHistory(raw.historyValue),
    timers: serializeTimers(raw.timers),
    nextTimerId: raw._nextTimerId ?? 0,
  };
}

/** Rehydrate a persisted state back into a live snapshot for transitioning. */
export function fromStored<M extends AnyStateMachine>(
  machine: M,
  stored: StoredState,
): SnapshotFrom<M> {
  const snapshot = machine.resolveState({
    value: stored.value,
    context: stored.context,
    status: stored.status,
    output: stored.output,
    error: stored.error,
    historyValue: deserializeHistory(machine, stored.historyValue),
  } as never) as SnapshotFrom<M>;
  // `resolveState` starts with no pending timers. XState fires and cancels
  // timers against this list, so restore it along with the timer sequence.
  const raw = snapshot as unknown as RawSnapshot;
  raw.timers = (stored.timers ?? []).map((timer) => ({
    ...timer,
    target: deserializeTimerTarget(timer.target),
  }));
  raw._nextTimerId = stored.nextTimerId ?? 0;
  return snapshot;
}

/** Project a live snapshot into the plain shape returned to callers. */
export function toReturnedSnapshot(
  snapshot: AnyMachineSnapshot,
): ReturnedSnapshot {
  const raw = asRaw(snapshot);
  const tags = raw.tags ? [...raw.tags] : [];
  tags.sort();
  return {
    value: raw.value,
    context: raw.context,
    status: raw.status,
    output: raw.output,
    error: raw.error,
    tags,
  };
}
