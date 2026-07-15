import type { ObjectContext } from "@restatedev/restate-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  executeEffects,
  maybeScheduleCleanup,
  reportTerminal,
  selfDef,
  settleSubscriptions,
} from "../../src/restate/effects";
import type { HandlerContext } from "../../src/restate/types";
import type {
  Effect,
  ReturnedSnapshot,
  SpawnParams,
} from "../../src/xstate/types";

interface ClientCall {
  key: string;
  method: string;
  args: unknown[];
}

function createHarness(options?: {
  parentKey?: string;
  invokeId?: string;
  executionId?: string;
  finalStateTTL?: number;
}) {
  const state = new Map<string, unknown>();
  const clientCalls: ClientCall[] = [];
  const resolved: Array<{ id: string; value: unknown }> = [];
  const rejected: Array<{ id: string; reason: string }> = [];
  let uuid = 0;

  const recordClient = (key: string) =>
    new Proxy(
      {},
      {
        get:
          (_target, method: string) =>
          (...args: unknown[]) => {
            clientCalls.push({ key, method, args });
          },
      },
    );

  const context = {
    key: "parent-key",
    rand: { uuidv4: vi.fn(() => `uuid-${++uuid}`) },
    get: vi.fn(async <T>(key: string): Promise<T | null> => {
      return (state.get(key) as T | undefined) ?? null;
    }),
    set: vi.fn((key: string, value: unknown) => state.set(key, value)),
    objectSendClient: vi.fn((_definition: unknown, key: string) =>
      recordClient(key),
    ),
    resolveAwakeable: vi.fn((id: string, value: unknown) => {
      resolved.push({ id, value });
    }),
    rejectAwakeable: vi.fn((id: string, reason: string) => {
      rejected.push({ id, reason });
    }),
  };

  const handler: HandlerContext = {
    ctx: context as unknown as ObjectContext,
    self: selfDef("machine"),
    ...options,
  };

  return { state, clientCalls, resolved, rejected, context, handler };
}

const activeSnapshot = (overrides?: Partial<ReturnedSnapshot>) => ({
  value: "active",
  context: {},
  status: "active" as const,
  tags: [],
  ...overrides,
});

describe("executeEffects", () => {
  it("dispatches promise actors to the internal actor handler", async () => {
    const harness = createHarness();
    const params: SpawnParams = { id: "work", src: "work", input: { n: 1 } };

    await executeEffects(harness.handler, [{ kind: "runPromise", params }]);

    expect(harness.clientCalls).toEqual([
      {
        key: "parent-key",
        method: "executeActor",
        args: [{ params, executionId: "uuid-1" }],
      },
    ]);
    expect(harness.state.get("actorExecutions")).toEqual({
      work: "uuid-1",
    });
  });

  it("persists a child before routing later effects to it", async () => {
    const harness = createHarness();
    const effects: Effect[] = [
      {
        kind: "startChild",
        childId: "kid",
        machineId: "child-machine",
        input: { n: 1 },
      },
      {
        kind: "send",
        target: { type: "child", childId: "kid" },
        event: { type: "PING" },
      },
    ];

    await executeEffects(harness.handler, effects);

    expect(harness.state.get("children")).toEqual({
      kid: { key: "parent-key::kid", machineId: "child-machine" },
    });
    expect(harness.state.get("actorExecutions")).toEqual({ kid: "uuid-1" });
    expect(harness.clientCalls).toEqual([
      {
        key: "parent-key::kid",
        method: "initChild",
        args: [
          {
            machineId: "child-machine",
            parentKey: "parent-key",
            invokeId: "kid",
            executionId: "uuid-1",
            input: { n: 1 },
          },
        ],
      },
      {
        key: "parent-key::kid",
        method: "deliverEvent",
        args: [{ type: "PING" }],
      },
    ]);
  });

  it("disposes and removes a stopped child", async () => {
    const harness = createHarness();
    harness.state.set("children", {
      kid: { key: "parent-key::kid", machineId: "child-machine" },
    });
    harness.state.set("actorExecutions", { kid: "execution-1" });

    await executeEffects(harness.handler, [
      { kind: "stopChild", childId: "kid" },
    ]);

    expect(harness.state.get("children")).toEqual({});
    expect(harness.state.get("actorExecutions")).toEqual({});
    expect(harness.clientCalls).toEqual([
      { key: "parent-key::kid", method: "cleanupState", args: [] },
    ]);
  });

  it("replaces a stopped promise execution with a new generation", async () => {
    const harness = createHarness();
    harness.state.set("actorExecutions", { work: "old-execution" });
    const params: SpawnParams = { id: "work", src: "work" };

    await executeEffects(harness.handler, [
      { kind: "stopPromise", actorId: "work" },
      { kind: "runPromise", params },
    ]);

    expect(harness.state.get("actorExecutions")).toEqual({ work: "uuid-1" });
    expect(harness.clientCalls).toEqual([
      {
        key: "parent-key",
        method: "executeActor",
        args: [{ params, executionId: "uuid-1" }],
      },
    ]);
  });

  it("generates collision-free ids for unnamed delayed sends", async () => {
    const harness = createHarness();
    const effects: Effect[] = ["FIRST", "SECOND"].map((type) => ({
      kind: "scheduleSend",
      target: { type: "self" },
      event: { type },
      delay: 0,
    }));

    await executeEffects(harness.handler, effects);

    expect(harness.state.get("scheduled")).toEqual({
      "uuid-1": {
        uuid: "uuid-1",
        targetKey: "parent-key",
        event: { type: "FIRST" },
      },
      "uuid-2": {
        uuid: "uuid-2",
        targetKey: "parent-key",
        event: { type: "SECOND" },
      },
    });
    expect(
      harness.clientCalls.map(({ key, method, args }) => ({
        key,
        method,
        request: args[0],
      })),
    ).toEqual([
      {
        key: "parent-key",
        method: "deliverScheduled",
        request: { sendId: "uuid-1", uuid: "uuid-1" },
      },
      {
        key: "parent-key",
        method: "deliverScheduled",
        request: { sendId: "uuid-2", uuid: "uuid-2" },
      },
    ]);
  });

  it("cancels an explicitly identified delayed send", async () => {
    const harness = createHarness();

    await executeEffects(harness.handler, [
      {
        kind: "scheduleSend",
        sendId: "reminder",
        target: { type: "self" },
        event: { type: "REMIND" },
        delay: 100,
      },
      { kind: "cancel", sendId: "reminder" },
    ]);

    expect(harness.state.get("scheduled")).toEqual({});
  });

  it("drops sends whose parent or child no longer exists", async () => {
    const harness = createHarness();

    await executeEffects(harness.handler, [
      {
        kind: "send",
        target: { type: "parent" },
        event: { type: "PARENT" },
      },
      {
        kind: "send",
        target: { type: "child", childId: "missing" },
        event: { type: "CHILD" },
      },
    ]);

    expect(harness.clientCalls).toEqual([]);
  });
});

describe("settleSubscriptions", () => {
  it("settles decided conditions and keeps pending conditions", async () => {
    const harness = createHarness();
    harness.state.set("subscriptions", {
      "hasTag:ready": { awakeables: ["ready-1", "ready-2"] },
      done: { awakeables: ["done-1"] },
    });
    const snapshot = activeSnapshot({ tags: ["ready"] });

    await settleSubscriptions(harness.handler, snapshot);

    expect(harness.resolved).toEqual([
      { id: "ready-1", value: snapshot },
      { id: "ready-2", value: snapshot },
    ]);
    expect(harness.state.get("subscriptions")).toEqual({
      done: { awakeables: ["done-1"] },
    });
  });

  it("rejects every pending condition when the machine errors", async () => {
    const harness = createHarness();
    harness.state.set("subscriptions", {
      done: { awakeables: ["done-1"] },
      "hasTag:ready": { awakeables: ["ready-1"] },
    });

    await settleSubscriptions(
      harness.handler,
      activeSnapshot({ status: "error", error: new Error("boom") }),
    );

    expect(harness.rejected).toEqual([
      { id: "done-1", reason: "State machine returned an error" },
      { id: "ready-1", reason: "State machine returned an error" },
    ]);
    expect(harness.state.get("subscriptions")).toEqual({});
  });
});

describe("terminal effects", () => {
  it("reports child completion exactly once", async () => {
    const harness = createHarness({
      parentKey: "root",
      invokeId: "kid",
      executionId: "execution-1",
    });
    const snapshot = activeSnapshot({ status: "done", output: { ok: true } });

    await reportTerminal(harness.handler, snapshot);
    await reportTerminal(harness.handler, snapshot);

    expect(harness.state.get("reported")).toBe(true);
    expect(harness.clientCalls).toEqual([
      {
        key: "root",
        method: "actorDone",
        args: [
          {
            actorId: "kid",
            executionId: "execution-1",
            output: { ok: true },
          },
        ],
      },
    ]);
  });

  it("normalizes a child error before reporting it", async () => {
    const harness = createHarness({
      parentKey: "root",
      invokeId: "kid",
      executionId: "execution-1",
    });

    await reportTerminal(
      harness.handler,
      activeSnapshot({ status: "error", error: new TypeError("boom") }),
    );

    expect(harness.clientCalls[0]).toMatchObject({
      key: "root",
      method: "actorError",
      args: [
        {
          actorId: "kid",
          executionId: "execution-1",
          error: { name: "TypeError", message: "boom" },
        },
      ],
    });
  });

  it("schedules cleanup only for completed machines with a configured TTL", () => {
    const done = activeSnapshot({ status: "done" });
    const withTtl = createHarness({ finalStateTTL: 50 });
    const withoutTtl = createHarness();

    maybeScheduleCleanup(withTtl.handler, activeSnapshot());
    maybeScheduleCleanup(withoutTtl.handler, done);
    maybeScheduleCleanup(withTtl.handler, done);

    expect(withoutTtl.clientCalls).toEqual([]);
    expect(withTtl.clientCalls).toHaveLength(1);
    expect(withTtl.clientCalls[0]).toMatchObject({
      key: "parent-key",
      method: "cleanupState",
    });
  });
});
