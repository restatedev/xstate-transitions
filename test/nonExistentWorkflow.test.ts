/*
 * Calling snapshot()/send() on a workflow id that was never created rejects with
 * a 404 TerminalError, and succeeds after create(). Drives the raw object client
 * (not the auto-creating runner) so it can call before create(). Runs under both
 * replay modes.
 */

import * as clients from "@restatedev/restate-sdk-clients";
import {
  RestateContainer,
  RestateTestEnvironment,
} from "@restatedev/restate-sdk-testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMachine } from "xstate";
import type { MachineVirtualObject } from "../src";
import { createMachineObject } from "../src";

const simpleMachine = createMachine({
  id: "simplev1",
  initial: "idle",
  states: {
    idle: { on: { START: "running" } },
    running: {},
  },
});

const REPLAY_MODES = [
  { label: "normal", alwaysReplay: false },
  { label: "alwaysReplay", alwaysReplay: true },
] as const;

describe.each(REPLAY_MODES)(
  "Non-existent workflow ID [$label]",
  ({ alwaysReplay }) => {
    const obj = createMachineObject("default", simpleMachine);
    let env: RestateTestEnvironment;
    let client: clients.IngressClient<
      MachineVirtualObject<typeof simpleMachine>
    >;

    beforeAll(async () => {
      env = await RestateTestEnvironment.start(
        { services: [obj], alwaysReplay },
        () =>
          new RestateContainer().withEnvironment({
            RESTATE_DEFAULT_NUM_PARTITIONS: "2",
            RESTATE_ROCKSDB_TOTAL_MEMORY_SIZE: "64 MB",
            RESTATE_DISABLE_TELEMETRY: "true",
          }),
      );
      client = clients
        .connect({ url: env.baseUrl() })
        .objectClient<MachineVirtualObject<typeof simpleMachine>>(
          { name: "default" },
          "non-existent-id",
        );
    }, 60_000);

    afterAll(async () => {
      await env.stop();
    });

    it(
      "Should return 404 when calling snapshot on a non-existent workflow ID",
      { timeout: 30_000 },
      async () => {
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
  },
);
