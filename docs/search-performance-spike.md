# Global Chat Search Performance Spike

Date: 2026-07-21

## Decision

The message projection, cold backfill, storage footprint, selective global search, and chat-scoped
search are suitable for the mobile search MVP. Broad project and global queries need a query-plan
optimization before the search work can be considered complete.

The measured acceptance targets were:

- cold backfill below 120 seconds;
- selective global search p95 below 500 ms;
- chat-scoped search p95 below 500 ms;
- project-scoped search p95 below 750 ms;
- broad global search p95 below 1,000 ms;
- projected message table plus FTS index below 3.5 KiB per visible message.

Four of the six targets passed on the embedded PGlite test database in the development container.
Broad project and global search missed their latency targets.

## Dataset

The reproducible benchmark creates:

- 4 projects;
- 100 chats;
- 100 user/agent exchanges per chat;
- 40,000 canonical events;
- 20,000 projected visible messages.

Each exchange contains a prompt, an agent response split over two streamed text deltas, and a
terminal result. The deterministic text distribution is 60% short (24 words), 30% medium (120
words), and 10% long (480 words), using varied technical vocabulary and a unique searchable token.
The canonical events are inserted without maintaining the projection first, so the backfill
measurement exercises a true cold rebuild. Search timings are warm and use 30 iterations each.

## Results

| Measurement | Result | Target status |
| --- | ---: | --- |
| Cold projection backfill | 23.70 s | Pass |
| Selective global search p50 / p95 | 86.34 / 113.46 ms | Pass |
| Broad global search p50 / p95 | 1,712.42 / 1,981.73 ms | **Fail** |
| Broad chat search p50 / p95 | 129.55 / 275.70 ms | Pass |
| Broad project search p50 / p95 | 542.15 / 818.68 ms | **Fail** |
| Canonical events table | 16.05 MiB | Informational |
| Projected messages table | 25.03 MiB | Informational |
| GIN FTS index | 5.09 MiB | Informational |
| Total projection storage | 34.75 MiB | Informational |
| Total projection storage per message | 1,821.90 bytes | Pass |

The backfill implementation is intentionally asynchronous, resumable, and outside the canonical
event persistence path. A new or upgraded installation may therefore return progressively more
historical results during the initial rebuild. This spike measures rebuild duration, not concurrent
UI or event-stream latency; those isolation properties remain covered by the store tests. The
storage breakdown uses `pg_table_size` for heap and TOAST data and `pg_relation_size` for the GIN
index. The acceptance value uses `pg_total_relation_size` for both projection relations, including
all indexes and projection state without double-counting.

The run used Node.js 24.18.0 and the repository's embedded in-memory PGlite database in a shared
development container. These absolute latencies are development evidence, not production
telemetry; the executable thresholds deliberately leave headroom for host variance.

## Reproduction

Run the default dataset:

```sh
VERITY_SEARCH_PERF_SPIKE=1 \
npx vitest run scripts/search-performance-spike.test.ts --maxWorkers=1 --reporter=verbose
```

Tune the dataset or repetitions with environment variables:

```sh
VERITY_SEARCH_SPIKE_SESSIONS=200 \
VERITY_SEARCH_SPIKE_EXCHANGES=200 \
VERITY_SEARCH_SPIKE_ITERATIONS=50 \
VERITY_SEARCH_PERF_SPIKE=1 \
npx vitest run scripts/search-performance-spike.test.ts --maxWorkers=1 --reporter=verbose
```

The test is opt-in through `VERITY_SEARCH_PERF_SPIKE=1`. Normal Vitest and CI discovery skip it so
performance sampling does not add noise or roughly two minutes to the required test suite. The
opt-in command currently exits non-zero for the two missed latency targets; that is intentional and
gives the follow-up optimization a reproducible completion criterion.

## Follow-up threshold

Retain the GIN index and optimize broad-result ranking in PostgreSQL before considering partitioning
or an external search service. The first experiment should avoid recalculating and sorting rank over
all matching rows when only the first 50 results are returned. The spike is complete when the same
opt-in command passes all encoded thresholds with the realistic corpus.
