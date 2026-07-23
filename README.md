# xstate-transitions

Run XState v6 **pure-transition** machines as durable
[Restate](https://restate.dev) virtual objects — stateless between requests, with
the machine snapshot _as_ the durable state.

> [!NOTE]
> This integration targets **XState v6** (`^6.0.0-alpha.21`). It depends on
> XState's pure-transition internals, so new prereleases are validated by the
> full normal and forced-replay test suites.

## Getting started

```sh
pnpm add @restatedev/xstate@alpha @restatedev/restate-sdk xstate@6.0.0-alpha.22 zod
pnpm add --save-dev tsx
```

Create an `index.ts`:

```ts
import * as restate from "@restatedev/restate-sdk";
import { createMachineObject } from "@restatedev/xstate";
import { setup, types } from "xstate";
import { z } from "zod";

const IncrementEvent = z.object({
  type: z.literal("INCREMENT"),
  by: z.number().int().positive().default(1),
});

const counterMachine = setup({
  schemas: {
    input: z.object({ initialCount: z.number().int().default(0) }),
    events: { INCREMENT: IncrementEvent },
    context: types<{ count: number }>(),
  },
}).createMachine({
  id: "counter",
  context: ({ input }) => ({ count: input.initialCount }),
  initial: "active",
  states: {
    active: {
      on: {
        INCREMENT: ({ context, event }) => ({
          context: { count: context.count + event.by },
        }),
      },
    },
  },
});

const counter = createMachineObject("counter", counterMachine);

restate.serve({ services: [counter] });
```

Run `pnpm tsx index.ts`, then register `http://localhost:9080` with Restate. See the
[library README](packages/xstate-transitions/README.md) and
[examples](packages/examples) for schemas, durable actors, and complete setup.

This is a pnpm workspace:

- **[`packages/xstate-transitions`](packages/xstate-transitions)** — the library.
  See its [README](packages/xstate-transitions/README.md) and the in-depth
  [MANUAL](packages/xstate-transitions/MANUAL.md).
- **[`packages/examples`](packages/examples)** — runnable Restate example
  services that consume the library.

## Develop

```sh
pnpm install
pnpm build        # build the library (tsdown → ESM + CJS + d.ts)
pnpm test:unit    # fast pure/unit suite, no Docker
pnpm test         # full suite; e2e uses Restate testcontainers (needs Docker)
pnpm dev          # run the example service (needs a local Restate server)
pnpm verify       # format + typecheck + lint + build + test (the CI gate)
```
