# Async Jobs and Artifacts (Jobs)

For longer-running research sources with multiple reasoning steps (such as `gma.research` and `browser.render`) or high-throughput batch tasks, `nb-search` provides a unified asynchronous job-management mechanism.

## Job lifecycle and states

When submitting an asynchronous request (`execution: "async"`), you must provide an `idempotency_key`. After accepting the request, the system returns a job receipt containing a valid UUID string in `job.job_id` for follow-up operations.

An asynchronous job has the following public states:

- `queued`: Entered the task queue and waiting to be processed.
- `running`: Currently executing.
- `succeeded`: Execution finished; an immutable artifact was successfully generated and published.
- `failed`: Execution failed, for example because an upstream service failed or the `DEADLINE_EXCEEDED` budget was exhausted.
- `cancelled`: Explicitly cancelled by the caller.

::: tip Lifecycle state and business result are separate
The job lifecycle state `succeeded` means only that the job completed without crashing. It does not guarantee that the returned business data is rich. A partial business result (`partial`) or an empty result (`empty`) is reported explicitly in the artifact status field and the CLI exit code.
:::

## Artifact immutability and retention (TTL)

- After an asynchronous job finishes successfully, the system publishes an immutable JSON artifact file.
- Retention is measured from the time of publication. The default retention period is 72 hours (`NB_SEARCH_RETENTION_HOURS=72`).
- After the retention period, attempts to read the job return `JOB_NOT_FOUND`. The system does not automatically rerun the job or regenerate an expired artifact.

## CLI asynchronous workflow

The CLI provides complete asynchronous subcommands: `run`, `get`, `read`, and `cancel`. Local tasks run directly; add `--profile <name>` explicitly for remote tasks.

### 1. Submit an asynchronous job and set a wait budget (`--wait`)

An asynchronous submission must include `--idempotency-key`. Use `--wait` to set the number of milliseconds to wait synchronously in the current process (from 1 to 3,600,000 ms):

```bash
node scripts/nb-search.mjs search "deep research brief" \
  --lane gma.research \
  --execution async \
  --idempotency-key "brief-20260907-001" \
  --wait 120000
```

- **Completes during the wait**: The CLI prints the final reconstructed logical result. The exit code depends on the logical data state: `0` for complete success, `3` for a partial result, `4` for an empty result, and `2` for failure.
- **Wait budget expires**: If the specified time elapses while the job continues in the background, the CLI prints timeout-status JSON and exits with **`5`** (not 7). The background job continues running; upstream computation is not cancelled automatically.

Get the actual generated `job_id` from the submission receipt (for example, `3f1e9a2b-7c4d-4e1a-8f23-9b5d6e7f8a10`) for subsequent operations.

### 2. Query job status (`get`)

```bash
node scripts/nb-search.mjs search get "3f1e9a2b-7c4d-4e1a-8f23-9b5d6e7f8a10"
```

If the job is still queued or running, the CLI exits with **`7`** (Pending). When metadata is retrieved successfully, it exits with `0` (which means only that the status was retrieved, not that the business data is complete). For a remote-service job, add `--profile <name>` explicitly.

### 3. Read the complete artifact (`read --all`)

For a successfully published job, the underlying artifact is stored through pagination and Base64 slices. The caller does not need to join Base64 slices manually; use `--all` to read and reconstruct the standard logical object directly:

```bash
node scripts/nb-search.mjs search read "3f1e9a2b-7c4d-4e1a-8f23-9b5d6e7f8a10" --all
```

`--all` automatically verifies slice continuity, offsets, SHA-256 integrity, UTF-8 encoding, and the corresponding Schema, then prints the complete logical JSON (search returns top-level `results` or a Typed payload; fetch returns top-level `documents`).

::: warning Note
`--all` is a helper for reconstructing a complete artifact in one operation. Do not combine it with pagination parameters such as `--cursor` or `--page-size`.
:::

### 4. Cancel a job (`cancel`)

```bash
node scripts/nb-search.mjs search cancel "3f1e9a2b-7c4d-4e1a-8f23-9b5d6e7f8a10"
```

- Exit code `0` means only that the cancellation request was acknowledged. It does not guarantee that the upstream operation has fully stopped and does not promise any refund or recovery of incurred costs.
- After cancelling, use `get` to check whether the job has actually transitioned to the terminal `cancelled` state.
