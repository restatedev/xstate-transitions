/*
 * GAP TEST (scaffold, todo) — BLOCKED BY: Phase 1 "non-existent-workflow 404 guard".
 *
 * Target behaviour: calling snapshot()/send() on a key that was never created
 * must reject with a 404 TerminalError, and succeed after create(). Today
 * core.ts's snapshot/send do `(await ctx.get("state")) ?? {}` + resolveState({}),
 * silently returning the resolved INITIAL state instead of a 404.
 *
 * Un-skip when core.ts gains: `validateExists(ctx)` throwing
 * new TerminalError("No state machine found for this workflow ID. Call 'create' first.", {errorCode:404})
 * at the top of send/snapshot (create is exempt).
 *
 * Adapted to the lean model: drives the raw RestateTestEnvironment + object
 * client (not the auto-creating runner) so it can call before create().
 */

import { createMachine } from "xstate";
import { describe, it, expect, afterAll } from "vitest";
import {
  RestateContainer,
  RestateTestEnvironment,
} from "@restatedev/restate-sdk-testcontainers";
import * as clients from "@restatedev/restate-sdk-clients";
import { createMachineObject } from "../src";
import type { MachineVirtualObject } from "../src";

const simpleMachine = createMachine({
  id: "simplev1",
  initial: "idle",
  states: {
    idle: { on: { START: "running" } },
    running: {},
  },
});

describe("Non-existent workflow ID", () => {
  const obj = createMachineObject("default", simpleMachine);
  let env: RestateTestEnvironment | undefined;
  let client: clients.IngressClient<MachineVirtualObject<typeof simpleMachine>>;

  afterAll(async () => {
    if (env) await env.stop();
  });

  it(
    "Should return 404 when calling snapshot on a non-existent workflow ID",
    { timeout: 30_000 },
    async () => {
      env = await RestateTestEnvironment.start(
        (restateServer) => restateServer.bind(obj),
        () =>
          new RestateContainer().withEnvironment({
            RESTATE_DEFAULT_NUM_PARTITIONS: "2",
            RESTATE_ROCKSDB_TOTAL_MEMORY_SIZE: "64 MB",
            RESTATE_DISABLE_TELEMETRY: "true",
          }),
      );
      const rs = clients.connect({ url: env.baseUrl() });
      client = rs.objectClient<MachineVirtualObject<typeof simpleMachine>>(
        { name: "default" },
        "non-existent-id",
      );

      await expect(() => client.snapshot()).rejects.toThrow(
        "No state machine found for this workflow ID. Call 'create' first.",
      );
    },
  );

  it(
    "Should return 404 when calling send on a non-existent workflow ID",
    { timeout: 30_000 },
    async () => {
      await expect(() => client.send({ type: "START" })).rejects.toThrow(
        "No state machine found for this workflow ID. Call 'create' first.",
      );
    },
  );

  it(
    "Should succeed after calling create first",
    { timeout: 30_000 },
    async () => {
      await client.create({});
      expect(await client.snapshot()).toMatchObject({
        status: "active",
        value: "idle",
      });
      await client.send({ type: "START" });
      expect(await client.snapshot()).toMatchObject({
        status: "active",
        value: "running",
      });
    },
  );
});
