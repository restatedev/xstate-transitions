# xstate-transitions

### What

This is an experiment to use the pure transition api with restate,
as described here https://stately.ai/docs/machines#transitioning-state

This largely following this structure from here:

https://github.com/statelyai/xstate/blob/main/packages/core/test/transition.test.ts#L480,L570

### Run tests

```sh
pnpm test
```

### Run the example

```sh
pnpm run dev
```

It should listen at port 9080

```sh
docker run --net host --add-host=host.docker.internal:host-gateway restatedev/restate:latest
```

Then [http://localhost:9070](http://localhost:9070) add a deployment at http://localhost:9080
[see quickstart over here] (https://docs.restate.dev/get_started/quickstart?sdk=ts)

### Current limitation

There is a failing (ignored) test at the moment [workflowReusingFunction.test.ts](test/workflowReusingFunctions.test.ts).
This test is based off [xstate's workflow-reusing-functions example](https://github.com/statelyai/xstate/blob/main/examples/workflow-reusing-functions/main.ts).
This test has two parallel machines, where one machine forwards machines to another, which somewhat doesn't work well with the pure transition api.
copying the same machine into [transition.test.ts](https://github.com/statelyai/xstate/blob/main/packages/core/test/transition.test.ts#L480,L570) results in the same
behavior. (a stuck execution)
