# xstate-transitions

### What

This is an experiment to use the pure transition api with restate,
as described here https://stately.ai/docs/machines#transitioning-state

This largely follows this structure:

https://github.com/statelyai/xstate/blob/main/packages/core/test/transition.test.ts#L480,L570

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

- **Promise actors** with an injected Restate `ctx` (`fromPromise` from
  [`src/restate/promise.ts`](src/restate/promise.ts) → `ctx.run` / `ctx.date` /
  `ctx.rand`);
  transient errors are retried by Restate, `TerminalError` routes to `onError`.
- **Delayed transitions** (`after`) and delayed events, with **cancellation**
  (`cancel(id)`), via guarded Restate delayed self-sends.
- **`waitFor` / `subscribe`** on `done` / `hasTag:*` conditions, backed by
  Restate awakeables, plus tag exposure on snapshots.
- **`finalStateTTL`** disposal of completed instances.
- **Cross-machine messaging**: `invoke` / `spawn` of a child machine runs it as
  its own virtual object (keyed `${parent}::${childId}`), with `sendTo` /
  `forwardTo` / `sendParent` routed as Restate sends between objects, and invoke
  `onDone` / `onError` reported back to the parent.

### Current limitation

`fromCallback` push actors (e.g. a `setInterval` that `sendBack`s events) are not
supported — they require a long-lived in-process actor, which the
stateless-between-requests model deliberately avoids. Model such cases by sending
events into the machine externally, or with a recurring delayed self-event. See
the skipped [stopwatchMachine.test.ts](test/stopwatchMachine.test.ts).
