# GBrain autopilot cadence: fast path vs heavy path

Use this reference when Panda reports repeated `gbrain watchdog` queue warnings, `stalled` / `dead` `autopilot-cycle` jobs, or frequent full extract pressure.

## Durable lesson

Do not put full extract/full cycle work on the same high-frequency cadence as freshness polling.

A healthy maintenance design has two lanes:

- **Fast lane, 5-15 min:** cheap freshness work only.
  - `sync`
  - changed-page import
  - changed/stale-only extraction if supported
  - small `embed-backfill` / `embed-catch-up`
  - lightweight health/status checks
- **Heavy lane, 4-12h or overnight:** global/full maintenance.
  - full `autopilot-cycle`
  - full extract / full timeline rebuild
  - global symbol resolution
  - patterns / consolidate / schema-suggest / purge
  - any phase whose runtime can exceed a fast tick interval

## First-principles diagnosis

A queue worker is healthy only if the scheduling rate is lower than or equal to the completion rate.

If `autopilot-cycle` takes longer than the scheduler interval, the system creates work faster than it drains work. The symptom is not simply "gbrain is down". The real mismatch is:

```text
heavy job runtime > enqueue interval
+ lease/lock duration shorter than worst-case DB pressure window
+ repeated full-cycle submissions
= waiting backlog, lock renewal churn, stalled/dead jobs, noisy watchdog alerts
```

## Inspection pattern

Use the lightest status commands first:

```bash
gbrain status
gbrain jobs stats
gbrain jobs list --status waiting --limit 60
gbrain jobs list --status stalled
```

Then check the running service only if status suggests pressure:

```bash
launchctl print gui/$(id -u)/com.gbrain.autopilot
sed -n '1,80p' ~/.gbrain/autopilot-run.sh
```

Avoid treating a transient `stalled` count as fatal if `gbrain jobs list --status stalled` is empty and the worker is still making forward progress. That is usually lease churn/noise, not a dead system.

## Preferred fix shape

Separate the knobs instead of using one interval for everything:

```text
autopilot.fast_interval_min = 15
autopilot.full_cycle_floor_min = 240
autopilot.heavy_job_timeout_min = 60
```

Routing rule:

```text
Every fast tick:
  enqueue only fast freshness jobs

Only if last full cycle is older than the heavy floor:
  allow one full cycle

Before enqueueing a full cycle:
  if any autopilot-cycle is already waiting or active, do not enqueue another
```

## Practical defaults for Panda's brain

- Fast lane: 15 minutes by default, 5 minutes only when freshness matters more than noise.
- Heavy lane: 4 hours minimum. Use 12 hours or overnight if full cycles regularly exceed 30 minutes.
- Watchdog: alert on no worker/no progress, not on actionable-looking lease churn while a worker is advancing.

## Pitfall

Do not keep raising timeouts or suppressing all watchdog alerts as the primary fix. That hides symptoms. First fix cadence and duplicate enqueue behavior, then tune lease/timeout settings if there is still real pressure.
