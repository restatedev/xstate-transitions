# xstate-transitions

### What

This is an experiment to use the pure transition api with restate,
as described here https://stately.ai/docs/machines#transitioning-state

This largely follows this structure:

https://github.com/statelyai/xstate/blob/main/packages/core/test/transition.test.ts#L480,L570

For setup, modeling guidance, supported behavior, testing strategy, and a tour
of the implementation, see the **[XState + Restate Integration Manual](MANUAL.md)**.

### Run tests

```sh
pnpm test
```

### Run the example

- `pnpm run dev`
- `docker run --net host --add-host=host.docker.internal:host-gateway restatedev/restate:latest`
- Use the webui [http://localhost:9070](http://localhost:9070)
- Add a deployment at http://localhost:9080 (checkout the [quickstart](https://docs.restate.dev/get_started/quickstart?sdk=ts) for a detailed walkthrough)
- `curl http://localhost:8080/default/bob/create --json '{}'`
- `curl http://localhost:8080/default/bob/send --json '{"type":"PaymentReceivedEvent","accountId":"1234","payment":{"amount":100},"customer":{"name":"bob"},"funds":{"available":true}}'`

### Features

Each machine is a Restate virtual object whose durable state _is_ the machine
snapshot (persisted history-safely). On top of the pure transition core it
supports:

- **Promise actors** in three explicit flavors (from
  [`src/restate/promise.ts`](src/restate/promise.ts)):
  - `fromPromise(creator)` — ctx-less; runs inside `ctx.run` for exactly-once
    durability. Any rejection is terminal and routes to `onError` (fail-fast,
    like vanilla xstate `fromPromise`).
  - `fromPromise(creator, { retry })` — as above, but transient rejections are
    retried by Restate's `ctx.run` (`retry: true` for the default policy, or a
    `RetryPolicy` to bound attempts/backoff); a `TerminalError` skips retries.
  - `fromHandler(creator)` — the creator receives the Restate `ctx`
    (`ctx.run` / `ctx.date` / `ctx.rand`) and journals its own effects; a
    `TerminalError` routes to `onError`, any other error is retried by Restate.
- **Delayed transitions** (`after`) and delayed events, with **cancellation**
  (`cancel(id)`), via guarded Restate delayed self-sends.
- **`waitFor` / `subscribe`** on `done` / `hasTag:*` conditions, backed by
  Restate awakeables, plus tag exposure on snapshots.
- **Runtime ingress contracts** for machine input and public events through
  library-neutral [Standard Schema](https://standardschema.dev/) validators
  (including Zod 4), applied consistently to `create`, `send`, and the optional
  event carried by `waitFor`.
- **`finalStateTTL`** disposal of completed instances.
- **Cross-machine messaging**: `invoke` / `spawn` of a child machine runs it as
  its own virtual object (keyed `${parent}::${childId}`), with `sendTo` /
  `forwardTo` / `sendParent` routed as Restate sends between objects, and invoke
  `onDone` / `onError` reported back to the parent.
- **Private actor protocols**: actor completion and failure use distinct
  ingress-private handlers with execution-generation tokens, so callers cannot
  forge XState lifecycle events and late results from superseded actors are
  harmless.

### Current limitation

`fromCallback` push actors (e.g. a `setInterval` that `sendBack`s events) are not
supported — they require a long-lived in-process actor, which the
stateless-between-requests model deliberately avoids. Model such cases by sending
events into the machine externally, or with a recurring delayed self-event. See
the skipped [stopwatchMachine.test.ts](test/stopwatchMachine.test.ts).
