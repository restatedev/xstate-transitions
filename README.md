# xstate-transitions

Run XState v5 **pure-transition** machines as durable
[Restate](https://restate.dev) virtual objects — stateless between requests, with
the machine snapshot _as_ the durable state.

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
