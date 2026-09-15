# Live-advisor prototype

This is an explicit, foreground-only prototype for one worker and one job-local advisor. It does not change ordinary watchdog defaults.

## Behavior

- The worker uses `openai-codex/gpt-5.6-luna` at medium effort and starts fresh.
- The advisor uses `openai-codex/gpt-6-astra` at xhigh effort. It receives an actual native fork of the persisted planner session and retains context within the job.
- Missing required models and unsupported execution modes fail before launch. There is no model fallback.
- Current-job advisor corrections clarify planner requirements and take precedence over conflicting task notes. They do not grant additional tools, filesystem permissions or scope. Parent, stale and other-job warnings remain filtered.
- Advisor failure or timeout cancels pending worker work. Cancellation and disposal invalidate pending reviews. A new job gets a new advisor lifecycle.
- Seed integrity is checked before native opening. Context construction remains native; JSON parsing does not reconstruct session context.

## Use

The candidate must be loaded explicitly into a compatible native Pi process. Installing or updating the ordinary published extension does not activate this prototype.

Start from a persisted planner session containing the approved requirements and permitted scope. Invoke the native subagent tool with a bounded task:

```json
{
  "agent": "worker",
  "task": "<complete task, constraints and permitted files>",
  "context": "fresh",
  "async": false,
  "liveAdvisor": true,
  "timeoutMs": 600000
}
```

The live pilots used Pi 0.85.1, Node 24 and private settings with `subagents.watchdog.agentEndTimeoutMs: 120000`. The ordinary 30-second setting timed out in one Astra review. This private setting does not change repository defaults.

Observe correction in the worker's provider input, a subsequent corrective action and independent output validation. A warning receipt or successful process exit is insufficient. On cancellation, settle both requests before starting another job. Native SDK hosts must emit session shutdown before disposal so extension cleanup runs.

## Validation

The integration tests include controlled native cases for planner forks, persistent context, credential refresh, invalid seeds, correction, failure, timeout, cancellation and fresh-job isolation. Enable the native cases explicitly:

```sh
PI_SUBAGENTS_NATIVE_SDK=/path/to/pi/packages/coding-agent \
  node --experimental-strip-types --import ./test/support/register-loader.mjs \
  --test test/integration/live-advisor-prototype.test.ts
```

Without that environment variable, native cases are skipped. They do not make live provider requests.

Four bounded live-pilot stages were completed locally:

1. Prepared isolated fixtures, an immutable candidate snapshot and independent checks.
2. Observed stale lowercasing, advisor correction in the worker request, a change to case-preserving trimming and a passing independent oracle. A failed attempt first established that the worker received corrections but preferred its stale task brief; the opt-in authority instruction addresses that conflict.
3. Cancelled with both native requests active, observed both abort and no later worker activity, then completed a fresh job in the same process without the cancelled context marker.
4. Ran an ordinary JSONL summarizer task without a planted conflict. The advisor found Python's acceptance of non-JSON constants; the worker corrected it. The captured initial implementation fails the independent NaN check; the final implementation and its tests pass.

The live checkout included pre-existing local repairs that are excluded from this PR. The isolated PR candidate passes typechecks, 71 focused tests without skips and 1,084 integration tests with six skips. Its full unit run has 3,509 passes, ten failures and four skips; all ten failures reproduce on the unchanged base in acceptance-compaction and readonly-session-evidence tests. No exact-commit live rerun is claimed.

Raw pilot sessions and credentials are not published. The last ordinary task reported 178,062 tokens across planner, worker and advisor. This demonstrates one useful intervention, not a net productivity or cost advantage. Keep the feature opt-in for constraint-sensitive tasks.

## Scope

Model-request cancellation was tested; whole-process-tree containment is not claimed. Hard billing caps are not a requirement. Unknown usage and billing cost must not be reported as zero.

The pilot does not authorize installation, merge or broader release acceptance. The final authority increment still requires independent code review. Unrelated inherited cleanup and lint failures are outside this change.
