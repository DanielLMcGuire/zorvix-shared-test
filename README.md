A throughput and latency benchmark for **Zorvix**, **Express**, and **0http**.

Each framework runs an identical set of routes and middleware, and all three are hammered concurrently so results are directly comparable.

---

The script runs all three servers on separate ports, then runs 10 benchmark suites back-to-back. Each suite:

1. **Warms up** for 5 seconds (results discarded)
2. **Tests** for 15 seconds with 200 concurrent workers firing requests as fast as possible
3. Reports RPS, average latency, p50/p75/p95/p99, min/max, standard deviation, and error count

At the end, a formatted table is printed to stdout with per-suite deltas and cross-framework totals.

---

## Benchmark Suites

| # | Suite | What it tests |
|---|-------|---------------|
| 1 | Simple GET (baseline) | Raw routing overhead, a single authenticated GET returning a static JSON payload |
| 2 | Route Params (`:id`) | Single dynamic segment extraction (`/users/:id`) |
| 3 | Nested Params (3 segments) | Deep parameterized routes (`/orgs/:org/repos/:repo/issues/:num`) |
| 4 | Wildcard Route | Glob/wildcard matching (`/static/*`) |
| 5 | POST + JSON Body | Request body ingestion, JSON parse, and echo |
| 6 | Deep Middleware (5 hops) | Cost of chaining five no-op middleware functions before the handler |
| 7 | CPU Compute (fib 20) | Synchronous CPU work inside a handler (recursive Fibonacci) |
| 8 | Mixed PUT/PATCH/DELETE | Multi-method routing with random method selection per request |
| 9 | Auth Rejection (401) | Early middleware short-circuit with an error response |
| 10 | Intentional 500 | Handler-level error path |

All routes that fall under `/api` pass through a fake auth middleware that requires the header `x-token: bench`.

---

## Configuration

| Constant | Default | Description |
|----------|---------|-------------|
| `CONCURRENCY` | `200` | Number of parallel workers |
| `WARMUP_MS` | `5000` | Warm-up duration per suite (ms) |
| `TEST_MS` | `15000` | Measurement window per suite (ms) |

`3001` (Zorvix), `3002` (Express), `3003` (0http).

---

## Usage

```bash
# Install deps
npm install

# Run and print results to stdout
npm start

# Also write per-suite RPS to a CSV file
npm start -- --out results.csv
```

The `--out` flag requires a file path argument. If the flag is present without a path the script exits with an error.

---

```
═══════════════════════════════════════════════════════════
  BENCHMARK RESULTS  concurrency=200  test=15s
═══════════════════════════════════════════════════════════
│ Suite                                         │     RPS │ …
├───────────────────────────────────────────────┤─────────┤
│ Zorvix  1. Simple GET (baseline)              │   18432 │ ▲ …
│ Express 1. Simple GET (baseline)              │   11205 │ …
│ 0http   1. Simple GET (baseline)              │   15901 │ …
│ Δ zorvix vs express: +64.5%   Δ zorvix vs 0http: +15.9%  …
…
```

Each group of three rows covers one suite. The `▲` marker indicates the winner. Below each group is a line showing the percentage delta between all three frameworks.

---

## Dependencies

| Package | Role |
|---------|------|
| `zorvix` | Framework under test (port 3001) |
| `express` | Framework under test (port 3002) |
| `0http` | Framework under test (port 3003) |

No external test runner is required, the test is self-contained and uses the built-in `fetch`, `perf_hooks`, and `fs` APIs.

---

## Metrics Glossary

| Metric | Description |
|--------|-------------|
| **RPS** | Requests per second over the test window |
| **Avg ms** | Mean end-to-end latency across all successful requests |
| **p50 / p95 / p99** | Latency percentiles (50th, 95th, 99th) |
| **Errors** | Requests that threw an uncaught exception (not 4xx/5xx responses) |
