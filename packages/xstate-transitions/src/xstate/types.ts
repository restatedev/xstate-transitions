import type { AnyEventObject, SnapshotStatus } from "xstate";

// ---------------------------------------------------------------------------
// Shared types for the pure (Restate-free) layer. Kept in one self-contained
// file so the vocabulary the integration speaks — persisted state, snapshots,
// effects — is defined in a single place.
// ---------------------------------------------------------------------------

/**
 * The serializable form of a machine snapshot, persisted between requests.
 * `historyValue` is stored as node ids (not the live StateNode instances the
 * raw snapshot carries) so history survives JSON serialization.
 */
export interface StoredState {
  value: unknown;
  context: unknown;
  status: SnapshotStatus;
  output?: unknown;
  error?: unknown;
  historyValue: Record<string, string[]>;
}

/** The plain, serializable snapshot shape returned to callers. */
export interface ReturnedSnapshot {
  value: unknown;
  context: unknown;
  status: SnapshotStatus;
  output?: unknown;
  error?: unknown;
  tags: string[];
}

/** A condition that `waitFor`/`subscribe` can wait on. */
export type Condition = "done" | `hasTag:${string}`;

/** The pure outcome of evaluating a wait condition against a settled snapshot. */
export type ConditionOutcome =
  | { status: "pending" }
  | { status: "resolve"; snapshot: ReturnedSnapshot }
  | { status: "reject"; reason: string };

/**
 * One executable action emitted by xstate's pure transition. Params are
 * loosely typed here (xstate does not export precise shapes); the interpreter
 * narrows them per action `type`.
 */
export interface Action {
  type: string;
  params: unknown;
}

/** Where a routed event is delivered. */
export type Target =
  { type: "self" } | { type: "child"; childId: string } | { type: "parent" };

/** The spawn-action params carried to the actor runner. */
export interface SpawnParams {
  id: string;
  src?: unknown;
  input?: unknown;
  [k: string]: unknown;
}

/**
 * Something the machine wants done, described independently of Restate. `step`
 * returns these; the Restate layer executes them with a simple switch.
 */
export type Effect =
  | { kind: "runPromise"; params: SpawnParams }
  | { kind: "startChild"; childId: string; machineId: string; input: unknown }
  | { kind: "stopChild"; childId: string }
  | { kind: "stopPromise"; actorId: string }
  | { kind: "send"; target: Target; event: AnyEventObject }
  | {
      kind: "scheduleSend";
      /** Explicit XState id, if supplied. The effect runner generates one otherwise. */
      sendId?: string;
      target: Target;
      event: AnyEventObject;
      delay: number;
    }
  | { kind: "cancel"; sendId: string };

/** The result of a pure step: the next persisted state, plus what to do next. */
export interface Step {
  nextState: StoredState;
  returned: ReturnedSnapshot;
  effects: Effect[];
}

/** Input to start a brand-new instance from its initial transition. */
export interface InitInput {
  input?: unknown;
  /** Whether this instance is a child (drives parent-aware sendParent). */
  isChild: boolean;
}

/** Input to apply an event to an existing, persisted instance. */
export interface ResumeInput {
  stored: StoredState;
  event: AnyEventObject;
  /** Whether this instance is a child (drives parent-aware sendParent). */
  isChild: boolean;
  /** Ids of children already started (to avoid re-starting them). */
  knownChildIds: readonly string[];
  /** Ids of promise actors still running out-of-band. */
  knownPromiseIds: readonly string[];
}
