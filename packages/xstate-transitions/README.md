# @restatedev/xstate

### What

This is an experiment to use the pure transition api with restate,
as described here https://stately.ai/docs/machines#transitioning-state

This largely follows this structure:

https://github.com/statelyai/xstate/blob/main/packages/core/test/transition.test.ts#L480,L570

> [!NOTE]
> This integration targets **XState v6** (currently `6.0.0-alpha.21`). Because it
> depends on XState's pure-transition internals, the version is pinned exactly;
> XState v6 is still in alpha, so treat an upgrade as an integration change.
> Machines use the v6 authoring model (inline `(args, enq) => …` transitions,
> `schemas`, `enq.sendTo`/`enq.raise`), not the v5 action creators.

For setup, modeling guidance, supported behavior, testing strategy, and a tour
of the implementation, see the **[XState + Restate Integration Manual](MANUAL.md)**.

### Run tests

From this package (or the workspace root):

```sh
pnpm test:unit   # fast, no Docker
pnpm test        # includes e2e (Restate testcontainers; needs Docker)
```

### Run the example

The example lives in the [`examples`](../examples) package. From the workspace
root:

- `pnpm dev`
- `docker run --net host --add-host=host.docker.internal:host-gateway restatedev/restate:latest`
- Use the webui [http://localhost:9070](http://localhost:9070)
- Add a deployment at http://localhost:9080 (checkout the [quickstart](https://docs.restate.dev/get_started/quickstart?sdk=ts) for a detailed walkthrough)
- `curl http://localhost:8080/default/bob/create --json '{}'`
- `curl http://localhost:8080/default/bob/send --json '{"type":"PaymentReceivedEvent","accountId":"1234","payment":{"amount":100},"customer":{"name":"bob"},"funds":{"available":true}}'`

### Features

Each machine is a Restate virtual object whose durable state _is_ the machine
snapshot (persisted history-safely). On top of the pure transition core it
supports:

- **Promise actors** in two flavors (from
  [`src/restate/promise.ts`](src/restate/promise.ts)):
  - `fromPromise(creator)` — a ctx-less durable promise; runs inside `ctx.run`
    for exactly-once durability. Fail-fast by default: any rejection is terminal
    and routes to `onError` (like vanilla xstate `fromPromise`). Pass `{ retry }`
    to opt into Restate's `ctx.run` retry — `retry: true` for the default policy,
    or a `RetryPolicy` to bound attempts/backoff; a `TerminalError` always skips
    retries.
  - `fromHandler(creator)` — the creator receives the Restate `ctx`
    (`ctx.run` / `ctx.date` / `ctx.rand`) and journals its own effects; a
    `TerminalError` routes to `onError`, any other error is retried by Restate.

  `fromPromise` and vanilla xstate actors run inside `ctx.run`, so a side effect
  executes exactly once and its result is journaled — replay-safe by default.
  Because the object is locked while an actor runs, prefer `fromPromise` with
  `{ retry }` (or `fromHandler`) over a fail-fast promise for work that can fail
  transiently. `fromHandler` runs directly (it already owns `ctx`).

- **Delayed transitions** (`after`) and delayed events, with **cancellation**
  (`cancel(id)`), via guarded Restate delayed self-sends.
- **`waitFor` / `subscribe`** on `done` / `hasTag:*` conditions, backed by
  Restate awakeables, plus tag exposure on snapshots.
- **Ingress validation from the machine's own `schemas`** — real
  [Standard Schema](https://standardschema.dev/) validators (e.g. Zod 4) on
  `schemas.input` / `schemas.events` validate and coerce `create`, `send`, and
  the optional event carried by `waitFor`, and surface as JSON Schemas in Restate
  discovery.
- **`finalStateTTL`** disposal of completed instances.
- **Cross-machine messaging**: `invoke` / `spawn` of a child machine runs it as
  its own virtual object (keyed `${parent}::${childId}`), with `enq.sendTo` to a
  child or to the parent routed as Restate sends between objects, and invoke
  `onDone` / `onError` reported back to the parent.
- **Private actor protocols**: actor completion and failure use distinct
  ingress-private handlers with execution-generation tokens, so callers cannot
  forge XState lifecycle events and late results from superseded actors are
  harmless.

### Current limitation

`createCallbackLogic` push actors (e.g. a `setInterval` that `sendBack`s events)
are not supported — they require a long-lived in-process actor, which the
stateless-between-requests model deliberately avoids. Model such cases by sending
events into the machine externally, or with a recurring delayed self-event. See
the skipped [stopwatchMachine.test.ts](test/e2e/stopwatchMachine.test.ts).
