# xstate-transitions

Run XState v6 **pure-transition** machines as durable
[Restate](https://restate.dev) virtual objects — stateless between requests, with
the machine snapshot _as_ the durable state.

> [!NOTE]
> This integration targets **XState v6** (currently `6.0.0-alpha.21`). Because it
> depends on XState's pure-transition internals the version is pinned exactly, and
> XState v6 is still in alpha — treat an upgrade as an integration change.

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
