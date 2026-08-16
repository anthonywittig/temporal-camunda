# Temporal vs Camunda 8: what actually differed

Notes from building the same order-fulfilment saga on both engines. Everything here was
observed while getting the code in this repo to pass, not gathered from documentation.

Versions: Temporal server 1.31.2 / TS SDK 1.22.0, Camunda 8.8.35 / `@camunda8/sdk` 8.8.13.

---

## 1. Where the saga lives

**Temporal.** One function. The compensation stack is an array of closures, pushed as
each effect succeeds and drained on the way out:

```ts
const compensations: Array<{ step: string; run: () => Promise<void> }> = [];

const reservation = await reserveInventory(order);
compensations.unshift({ step: 'inventory', run: () => releaseInventory(...) });
```

The control flow is `try`/`catch`, `if`, and `await`. Someone who has never seen Temporal
can read `temporal/src/workflows.ts` and know what the order lifecycle is.

**Camunda.** The control flow is a 27-element BPMN model; the effects are eight job
workers in a separate file. Neither half tells you the whole story: `camunda/src/workers.ts`
never mentions the fraud gateway, and `order-saga.bpmn` never mentions what "reserve
inventory" does.

That split is the trade, and it cuts both ways. The BPMN file is the artifact you can put
in front of an operations lead or a compliance reviewer and get a real answer about. The
TypeScript file is not, no matter how clean it is. Conversely, "unwind in reverse order"
is one obvious line of code on one side and an emergent property of the engine on the
other — see the next section.

## 2. Compensation ordering: LIFO vs. concurrent

The single most surprising finding, and the reason the report has a `LIFO` column.

BPMN's specified semantics for compensation are reverse order of completion. **Zeebe does
not do this.** Compensation handlers are fanned out concurrently, and their completion
order varies between runs of the same model with the same inputs. Four consecutive runs of
the `capture-fails` scenario:

```
run 0: inventory → payment → shipping
run 1: inventory → shipping → payment
run 2: inventory → payment → shipping
run 3: inventory → payment → shipping
```

Temporal is LIFO every time, because the workflow is literally a `for` loop over a stack.

This matters whenever undo steps are not commutative — release a reservation before
voiding the authorization that paid for it and you can end up briefly inconsistent in ways
your downstream systems notice. On Camunda you would model the ordering explicitly (chain
the handlers, or use nested subprocesses with their own compensation scopes) rather than
relying on the engine. On Temporal you get it for free and would have to work to lose it.

## 3. Exhausting retries does not unwind the process on Camunda

On Temporal, an activity that exhausts its retry policy throws into the workflow. It lands
in your `catch`, and the saga compensates. Nothing extra to configure.

On Zeebe, a job that exhausts its retries raises an **incident**: the instance stops where
it is and waits for a human to look at it in Operate. That is a deliberate and often
correct default for business processes — a human decides whether to retry or cancel — but
it is not saga behaviour, and nothing in the BPMN model turns it into saga behaviour.

Getting the compensation path to fire required the *worker* to translate a technical
failure into a business error:

```ts
if (job.retries > 1) {
  return job.fail({ errorMessage, retries: job.retries - 1, retryBackOff: 200 });
}
// Out of retries. Without this the instance parks on an incident and the
// model's error boundary events never fire.
return job.error({ errorCode: 'STEP_FAILED', errorMessage, variables: {} });
```

Two consequences worth internalising:

- **Retry policy lives in two places.** The retry *count* is on the task in the BPMN
  (`zeebe:taskDefinition retries="3"`); the *backoff* is a parameter the worker passes when
  it fails the job. Temporal keeps both in one `retry` block next to the activity.
- **The error path is a modelling obligation.** Five service tasks meant five error
  boundary events, all converging on a compensation throw. On Temporal it is one `catch`.

## 4. The model↔worker contract is a string

`<zeebe:taskDefinition type="reserve-inventory" />` in the XML has to match
`type: 'reserve-inventory'` in the worker. Nothing checks it. A typo does not fail
deployment and does not fail at startup — the instance simply arrives at that task and
waits forever for a worker that will never poll.

The same applies to variables. `screen-fraud` returns `{ fraudRisk }` because the
gateway's FEEL condition reads `fraudRisk`. Rename the field in the worker and routing
silently changes; no compiler, no test, no deployment check will tell you.

Temporal's equivalent is:

```ts
const { reserveInventory } = proxyActivities<typeof activities>({ ... });
```

The activity names and their full signatures come from `typeof import('./activities')`.
Renaming an activity or changing an argument type is a compile error. Over a large process
estate this is probably the single biggest day-to-day ergonomic difference.

## 5. Human tasks: first-class vs. build-it-yourself

This is where Camunda earns its keep.

The BPMN user task is a real element the broker knows about. It is searchable through the
same API that backs Tasklist, so the driver just asks for it:

```ts
await client.searchUserTasks({ filter: { state: 'CREATED', processInstanceKey } });
await client.completeUserTask({ userTaskKey, variables: { reviewDecision } });
```

And a working task-list UI, with assignment and filtering, exists at
`localhost:8088/tasklist` without anyone writing a line of frontend code.

Temporal has no concept of a human task. The saga blocks on a signal:

```ts
setHandler(reviewDecisionSignal, (incoming) => { decision = incoming; });
const reviewed = await condition(() => decision !== undefined, '7 days');
```

That is elegant, and the seven-day timeout is one argument. But *finding out that an order
is waiting for a human* is now your problem: the driver has to poll a `status` query the
workflow defines for exactly this purpose, and in production you would be building the
task store, the assignment model, and the UI yourself.

If your process is mostly human steps, this difference alone probably decides it.

## 6. Observability is strongly consistent on one side, eventually consistent on the other

Camunda's search APIs are served from Elasticsearch, not from the broker. They lag.

This produced a real bug while building the driver. The first version searched for "any
user task in state CREATED", which returned the *previous* scenario's task — already
completed, but not yet re-indexed. Completing it failed:

```
404 NOT_FOUND: Expected to complete user task with key '2251799813685608',
but no such user task was found
```

The broker is strongly consistent; the read model is not. Every read in
`camunda/src/run-scenarios.ts` is therefore a poll with a deadline, and the fix was to
scope the search to a specific `processInstanceKey`.

Temporal has no equivalent split. A query is executed by the workflow itself against its
current state, and `handle.result()` resolves the moment the workflow completes. The
driver has one poll in it, and that poll is waiting on a human, not on an index.

The flip side: Operate is a genuinely good operational UI, and "which token is where, on
which version, with what variables" is answerable by a non-engineer. The Temporal UI shows
you an event history, which is precise and complete and much less approachable.

## 7. "Start and await the result" does not survive a human step

`createProcessInstanceWithResult` holds the HTTP request open until the instance finishes.
Pointed at a process containing a human review, the gateway returned `503` — and the SDK
retried, which **started a second instance of the same order**. That showed up in the
report as every step being attempted three times.

The fix was to stop awaiting and start polling: `createProcessInstance` to get the key,
then poll for a terminal state. Fine, but it means the natural-looking API is a trap for
exactly the long-running processes Camunda is otherwise good at.

Temporal's `handle.result()` is built for this. It is a long poll against the server that
survives disconnects, and the workflow is decoupled from the caller's request lifetime.
The `fraud-approved` scenario blocks on it with no special handling.

## 8. Testing

Temporal ships a test environment with a **skipping clock**:

```ts
env = await TestWorkflowEnvironment.createTimeSkipping();
```

A workflow blocked on a seven-day timer resolves in milliseconds. The whole suite —
including the review-timeout case — runs in about two seconds with no Docker and no
server:

```
# tests 5
# pass 5
# duration_ms 2145
```

There is no equivalent for a Node-based Camunda project. Zeebe has in-process test support
(`zeebe-process-test`), but it is Java-only; testing this saga end to end means the real
broker plus Elasticsearch. That is a ~1.2 GB image, a second container, and roughly 40
seconds of startup before the first assertion runs.

If you are on the JVM this gap narrows considerably. On Node it is stark.

## 9. Deployment and versioning

Camunda's model is a **versioned resource in the broker**. `npm run camunda:deploy` pushes
it and the broker assigns a version; running instances stay pinned to the version they
started on, and Operate can migrate them between versions.

Temporal's workflow definition is the **worker binary**. Nothing is deployed to the server,
which never sees your code. Changing a workflow that has instances in flight means either
`patched()` guards in the code or worker versioning — a genuinely harder problem than
clicking migrate in Operate, and the thing Temporal newcomers most often get wrong.

Neither is strictly better; they fail differently. Camunda's version pinning is
comprehensible but means old definitions live forever. Temporal's determinism checks are
brutal but catch incompatible changes at replay time rather than in production a week
later.

## 10. Hand-authoring BPMN is not a supported workflow

Worth stating plainly because it cost the most time here. Generating the model in a script
hit two failures that Camunda Modeler would have silently prevented:

1. The BPMN XSD fixes child order — `extensionElements` must precede `incoming`/`outgoing`.
   The rejection message at least says so.
2. `<bpmn:compensateEventDefinition />` must carry an `id`. Without one, Zeebe rejects the
   entire deployment with:

   ```
   Cannot invoke "String.getBytes(java.nio.charset.Charset)" because "value" is null
   ```

   No element name, no line number. Isolating it meant bisecting with minimal models.

This is not an argument against Camunda — you are supposed to use Modeler, and Modeler
emits ids. But it does mean the model is not really a text artifact you edit by hand, which
has knock-on effects for code review and merge conflicts.

## 11. Local footprint

| | Temporal | Camunda 8 |
| --- | --- | --- |
| To run | `temporal server start-dev` (one binary, ~30 MB) | 2 containers + Elasticsearch (~1.2 GB image) |
| Cold start | ~2 s | ~40 s |
| To test | nothing | the full stack |
| Extra memory | negligible | ~2 GB |

---

## Choosing

Not a scorecard — they are aimed at different problems.

**Camunda 8, if:**
- Humans are part of the process. User tasks, Tasklist, and assignment are free, and
  rebuilding them on Temporal is a project.
- Non-engineers need to read, review, or sign off on the flow. The BPMN diagram is a
  genuine shared artifact; a TypeScript function is not.
- The rules change more often than the code. DMN decision tables (not exercised here) let
  analysts change behaviour without a deploy.
- You are on the JVM, where the tooling and test story are much stronger than on Node.

**Temporal, if:**
- The orchestration is essentially programmatic: dynamic fan-out, loops over collections,
  logic that is awkward to draw.
- You want compile-time safety across the whole workflow, and tests that run in seconds in
  CI without infrastructure.
- Exact ordering guarantees matter — compensation order being a property of your code
  rather than of the engine.
- The team that operates it is the team that wrote it.

**The honest summary:** Camunda is a *business process* engine that can express sagas.
Temporal is a *durable execution* engine that can express business processes. For this
particular workload — a technical saga with one human gate — Temporal was substantially
less work and had fewer surprises. Add three more human steps and a compliance auditor,
and the answer flips.
