import { serve }        from 'zorvix';
import express           from 'express';
import zeroHttpServer    from '0http';
import { performance }   from 'perf_hooks';
import { writeFileSync } from 'fs';

const CONCURRENCY = 200;
const WARMUP_MS   = 5_000;
const TEST_MS     = 15_000;
const Z_BASE      = 'http://localhost:3001';
const E_BASE      = 'http://localhost:3002';
const H_BASE      = 'http://localhost:3003';

const args    = process.argv.slice(2);
const outIdx  = args.indexOf('--out');
const outFile = outIdx !== -1 ? args[outIdx + 1] : null;

if (outIdx !== -1 && !outFile) {
  console.error('Error: --out requires a file path argument');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function percentile(sorted, p) {
  return sorted[Math.floor(sorted.length * p)] ?? 0;
}

function stddev(arr, avg) {
  const variance = arr.reduce((s, v) => s + (v - avg) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

function memMB() {
  return (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
}

async function runPhase(duration, buildRequest) {
  let running = true;
  let total   = 0;
  let errors  = 0;
  const lats  = [];

  async function worker() {
    while (running) {
      const { url, init } = buildRequest();
      const t0 = performance.now();
      try {
        const res = await fetch(url, init);
        await res.json();
        lats.push(performance.now() - t0);
        total++;
      } catch {
        errors++;
      }
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, worker);
  await sleep(duration);
  running = false;
  await Promise.allSettled(workers);

  lats.sort((a, b) => a - b);
  const avg = lats.reduce((s, v) => s + v, 0) / (lats.length || 1);

  return {
    total,
    errors,
    rps: total / (duration / 1000),
    avg,
    sd:  stddev(lats, avg),
    min: lats[0]               ?? 0,
    p50: percentile(lats, 0.50),
    p75: percentile(lats, 0.75),
    p95: percentile(lats, 0.95),
    p99: percentile(lats, 0.99),
    max: lats[lats.length - 1] ?? 0,
  };
}

async function bench(label, buildRequest) {
  process.stdout.write(`  [warmup]  ${label} ... `);
  await runPhase(WARMUP_MS, buildRequest);
  process.stdout.write(`done\n  [test]    ${label} ... `);
  const memBefore = memMB();
  const stats     = await runPhase(TEST_MS, buildRequest);
  const memAfter  = memMB();
  process.stdout.write(`done  (heap ${memBefore} -> ${memAfter} MB)\n`);
  return stats;
}

const results = {};   // { suiteName: { zorvix, express, http0 } }

async function suite(name, zReq, eReq, hReq) {
  console.log(`\n┌─ ${name}`);
  const z = await bench('Zorvix ', zReq);
  const e = await bench('Express', eReq);
  const h = await bench('0http  ', hReq);
  results[name] = { zorvix: z, express: e, http0: h };
}

function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }

async function startZorvix() {
  serve({
    port:    3001,
    workers: true,
    logging: false,
    cache:   true,
  }, async (server) => {

    function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }

    server.use((req, _res, next) => { req._start = performance.now(); next(); });

    const fakeAuth = (req, res, next) => {
      if (req.headers['x-token'] === 'bench') return next();
      res.statusCode = 401;
      res.json({ error: 'unauthorized' });
    };
    server.use('/api', fakeAuth);

    server.get('/api/hello',   (_req, res) => res.json({ message: 'Hello from Zorvix' }));
    server.get('/users/:id',   (req,  res) => res.json({ userId: req.params.id, ts: Date.now() }));
    server.get('/orgs/:org/repos/:repo/issues/:num', (req, res) => res.json(req.params));
    server.get('/static/*',    (req,  res) => res.json({ path: req.url }));

    server.post('/api/echo', (req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => { try { res.json(JSON.parse(body)); } catch { res.json({}); } });
    });

    const noop = (_r, _s, next) => next();
    server.use('/deep', noop, noop, noop, noop, noop);
    server.get('/deep/end', (_req, res) => res.json({ ok: true }));

    server.get('/api/compute', (_req, res) => res.json({ result: fib(20) }));

    server.put('/users/:id',    (req, res) => res.json({ op: 'put',    id: req.params.id }));
    server.patch('/users/:id',  (req, res) => res.json({ op: 'patch',  id: req.params.id }));
    server.delete('/users/:id', (req, res) => res.json({ op: 'delete', id: req.params.id }));

    server.get('/api/error', (_req, res) => { res.statusCode = 500; res.json({ error: 'intentional' }); });

    await server.start();
  });
}

function startExpress() {
  return new Promise((resolve) => {
    const app = express();

    app.use((_req, _res, next) => next());

    const fakeAuth = (req, res, next) => {
      if (req.headers['x-token'] === 'bench') return next();
      res.status(401).json({ error: 'unauthorized' });
    };
    app.use('/api', fakeAuth);

    app.get('/api/hello',    (_req, res) => res.json({ message: 'Hello from Express' }));
    app.get('/users/:id',    (req,  res) => res.json({ userId: req.params.id, ts: Date.now() }));
    app.get('/orgs/:org/repos/:repo/issues/:num', (req, res) => res.json(req.params));
    app.get('/static/*path', (req,  res) => res.json({ path: req.url }));
    app.post('/api/echo', express.json(), (req, res) => res.json(req.body));

    const noop = (_r, _s, next) => next();
    app.use('/deep', noop, noop, noop, noop, noop);
    app.get('/deep/end', (_req, res) => res.json({ ok: true }));

    app.get('/api/compute', (_req, res) => res.json({ result: fib(20) }));

    app.put('/users/:id',    (req, res) => res.json({ op: 'put',    id: req.params.id }));
    app.patch('/users/:id',  (req, res) => res.json({ op: 'patch',  id: req.params.id }));
    app.delete('/users/:id', (req, res) => res.json({ op: 'delete', id: req.params.id }));

    app.get('/api/error', (_req, res) => res.status(500).json({ error: 'intentional' }));

    app.listen(3002, resolve);
  });
}

function jsonEnd(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(body);
}

function start0http() {
  return new Promise((resolve) => {
    const { router, server } = zeroHttpServer();

    router.use((req, _res, next) => { req._start = performance.now(); return next(); });

    const fakeAuth = (req, res, next) => {
      if (req.headers['x-token'] === 'bench') return next();
      jsonEnd(res, 401, { error: 'unauthorized' });
    };
    router.use('/api', fakeAuth);

    router.get('/api/hello',   (_req, res) => jsonEnd(res, 200, { message: 'Hello from 0http' }));
    router.get('/users/:id',   (req,  res) => jsonEnd(res, 200, { userId: req.params.id, ts: Date.now() }));
    router.get('/orgs/:org/repos/:repo/issues/:num', (req, res) => jsonEnd(res, 200, req.params));
    router.get('/static/*',    (req,  res) => jsonEnd(res, 200, { path: req.url }));

    router.post('/api/echo', (req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => { try { jsonEnd(res, 200, JSON.parse(body)); } catch { jsonEnd(res, 200, {}); } });
    });

    const noop = (_r, _s, next) => next();
    router.use('/deep', noop, noop, noop, noop, noop);
    router.get('/deep/end', (_req, res) => jsonEnd(res, 200, { ok: true }));

    router.get('/api/compute', (_req, res) => jsonEnd(res, 200, { result: fib(20) }));

    router.put('/users/:id',    (req, res) => jsonEnd(res, 200, { op: 'put',    id: req.params.id }));
    router.patch('/users/:id',  (req, res) => jsonEnd(res, 200, { op: 'patch',  id: req.params.id }));
    router.delete('/users/:id', (req, res) => jsonEnd(res, 200, { op: 'delete', id: req.params.id }));

    router.get('/api/error', (_req, res) => jsonEnd(res, 500, { error: 'intentional' }));

    server.listen(3003, resolve);
  });
}

const AUTH   = { headers: { 'x-token': 'bench', 'content-type': 'application/json' } };
const ids    = ['1', '42', '999', 'abc', 'xyz-007'];
const rdId   = () => ids[Math.random() * ids.length | 0];
const rdMeth = () => (['PUT', 'PATCH', 'DELETE'])[Math.random() * 3 | 0];

const suites = {
  '1. Simple GET (baseline)': {
    z: () => ({ url: `${Z_BASE}/api/hello`,                               init: AUTH }),
    e: () => ({ url: `${E_BASE}/api/hello`,                               init: AUTH }),
    h: () => ({ url: `${H_BASE}/api/hello`,                               init: AUTH }),
  },
  '2. Route Params (:id)': {
    z: () => ({ url: `${Z_BASE}/users/${rdId()}`,                         init: AUTH }),
    e: () => ({ url: `${E_BASE}/users/${rdId()}`,                         init: AUTH }),
    h: () => ({ url: `${H_BASE}/users/${rdId()}`,                         init: AUTH }),
  },
  '3. Nested Params (3 segments)': {
    z: () => ({ url: `${Z_BASE}/orgs/acme/repos/core/issues/${rdId()}`,   init: AUTH }),
    e: () => ({ url: `${E_BASE}/orgs/acme/repos/core/issues/${rdId()}`,   init: AUTH }),
    h: () => ({ url: `${H_BASE}/orgs/acme/repos/core/issues/${rdId()}`,   init: AUTH }),
  },
  '4. Wildcard Route': {
    z: () => ({ url: `${Z_BASE}/static/assets/img/logo.png`,              init: AUTH }),
    e: () => ({ url: `${E_BASE}/static/assets/img/logo.png`,              init: AUTH }),
    h: () => ({ url: `${H_BASE}/static/assets/img/logo.png`,              init: AUTH }),
  },
  '5. POST + JSON Body': {
    z: () => ({ url: `${Z_BASE}/api/echo`, init: { ...AUTH, method: 'POST', body: JSON.stringify({ n: rdId(), ts: Date.now() }) } }),
    e: () => ({ url: `${E_BASE}/api/echo`, init: { ...AUTH, method: 'POST', body: JSON.stringify({ n: rdId(), ts: Date.now() }) } }),
    h: () => ({ url: `${H_BASE}/api/echo`, init: { ...AUTH, method: 'POST', body: JSON.stringify({ n: rdId(), ts: Date.now() }) } }),
  },
  '6. Deep Middleware (5 hops)': {
    z: () => ({ url: `${Z_BASE}/deep/end`,                                init: AUTH }),
    e: () => ({ url: `${E_BASE}/deep/end`,                                init: AUTH }),
    h: () => ({ url: `${H_BASE}/deep/end`,                                init: AUTH }),
  },
  '7. CPU Compute (fib 20)': {
    z: () => ({ url: `${Z_BASE}/api/compute`,                             init: AUTH }),
    e: () => ({ url: `${E_BASE}/api/compute`,                             init: AUTH }),
    h: () => ({ url: `${H_BASE}/api/compute`,                             init: AUTH }),
  },
  '8. Mixed PUT/PATCH/DELETE': {
    z: () => ({ url: `${Z_BASE}/users/${rdId()}`, init: { ...AUTH, method: rdMeth() } }),
    e: () => ({ url: `${E_BASE}/users/${rdId()}`, init: { ...AUTH, method: rdMeth() } }),
    h: () => ({ url: `${H_BASE}/users/${rdId()}`, init: { ...AUTH, method: rdMeth() } }),
  },
  '9. Auth Rejection (401)': {
    z: () => ({ url: `${Z_BASE}/api/hello`, init: {} }),
    e: () => ({ url: `${E_BASE}/api/hello`, init: {} }),
    h: () => ({ url: `${H_BASE}/api/hello`, init: {} }),
  },
  '10. Intentional 500': {
    z: () => ({ url: `${Z_BASE}/api/error`, init: AUTH }),
    e: () => ({ url: `${E_BASE}/api/error`, init: AUTH }),
    h: () => ({ url: `${H_BASE}/api/error`, init: AUTH }),
  },
};

function pad(s, n, right = false) {
  const str = String(s);
  return right ? str.padStart(n) : str.padEnd(n);
}

function printTable() {
  const cols = {
    suite: 45,
    rps:   8,
    win:   2,
    avg:   9,
    p50:   8,
    p95:   8,
    p99:   8,
    errs:  8,
  };

  const totalW = Object.values(cols).reduce((s, w) => s + w, 0)
               + (Object.keys(cols).length * 3);
  const hr = '─'.repeat(totalW - 2);

  const makeRow = (label, s, isWinner) =>
    `│ ${pad(label, cols.suite)} │ ${pad(s.rps.toFixed(0), cols.rps, true)} │ ${pad(isWinner ? '▲' : '', cols.win)}` +
    `│ ${pad(s.avg.toFixed(2), cols.avg, true)} │ ${pad(s.p50.toFixed(2), cols.p50, true)}` +
    ` │ ${pad(s.p95.toFixed(2), cols.p95, true)} │ ${pad(s.p99.toFixed(2), cols.p99, true)}` +
    ` │ ${pad(s.errors, cols.errs, true)} │`;

  console.log('\n' + '═'.repeat(totalW));
  console.log(`  BENCHMARK RESULTS  concurrency=${CONCURRENCY}  test=${TEST_MS / 1000}s`);
  console.log('═'.repeat(totalW));
  console.log(
    `│ ${pad('Suite', cols.suite)} │ ${pad('RPS', cols.rps, true)} │ ${pad('', cols.win)}` +
    `│ ${pad('Avg ms', cols.avg, true)} │ ${pad('p50', cols.p50, true)}` +
    ` │ ${pad('p95', cols.p95, true)} │ ${pad('p99', cols.p99, true)}` +
    ` │ ${pad('Errors', cols.errs, true)} │`
  );
  console.log(`├${hr}┤`);

  for (const [name, { zorvix: z, express: e, http0: h }] of Object.entries(results)) {
    const best = Math.max(z.rps, e.rps, h.rps);

    console.log(makeRow(`Zorvix  ${name}`, z, z.rps === best));
    console.log(makeRow(`Express ${name}`, e, e.rps === best));
    console.log(makeRow(`0http   ${name}`, h, h.rps === best));

    const fmtDelta = (a, b, aName, bName) => {
      const d    = (((a - b) / b) * 100).toFixed(1);
      const sign = a > b ? '+' : '';
      return `Δ ${aName} vs ${bName}: ${sign}${d}%`;
    };

    const d1 = fmtDelta(z.rps, e.rps, 'zorvix', 'express');
    const d2 = fmtDelta(z.rps, h.rps, 'zorvix', '0http  ');
    const d3 = fmtDelta(e.rps, h.rps, 'express', '0http ');
    console.log(`│ ${pad(`${d1}   ${d2}   ${d3}`, totalW - 4)} │`);

    console.log(`├${hr}┤`);
  }

  console.log(`└${hr}┘`);

  let zTotal = 0, eTotal = 0, hTotal = 0;
  for (const { zorvix: z, express: e, http0: h } of Object.values(results)) {
    zTotal += z.rps; eTotal += e.rps; hTotal += h.rps;
  }

  const sign = (a, b) => a > b ? '+' : '';
  const pct  = (a, b) => (((a - b) / b) * 100).toFixed(1);

  console.log(`\n  Zorvix  total RPS: ${zTotal.toFixed(0)}`);
  console.log(`  Express total RPS: ${eTotal.toFixed(0)}`);
  console.log(`  0http   total RPS: ${hTotal.toFixed(0)}`);
  console.log(`\n  Zorvix  vs Express: ${sign(zTotal, eTotal)}${pct(zTotal, eTotal)}%`);
  console.log(`  Zorvix  vs 0http:   ${sign(zTotal, hTotal)}${pct(zTotal, hTotal)}%`);
  console.log(`  Express vs 0http:   ${sign(eTotal, hTotal)}${pct(eTotal, hTotal)}%\n`);
}

function writeCSV(filePath) {
  const rows = ['Suite,Zorvix,Express,0http'];

  for (const [name, { zorvix: z, express: e, http0: h }] of Object.entries(results)) {
    rows.push(`"${name}",${z.rps.toFixed(2)},${e.rps.toFixed(2)},${h.rps.toFixed(2)}`);
  }


  let zTotal = 0, eTotal = 0, hTotal = 0;
  for (const { zorvix: z, express: e, http0: h } of Object.values(results)) {
    zTotal += z.rps; eTotal += e.rps; hTotal += h.rps;
  }
  rows.push(`"TOTAL",${zTotal.toFixed(2)},${eTotal.toFixed(2)},${hTotal.toFixed(2)}`);

  writeFileSync(filePath, rows.join('\n') + '\n', 'utf8');
  console.log(`  CSV written → ${filePath}`);
}

async function main() {
  console.log('Starting servers...');
  await startZorvix();
  await startExpress();
  await start0http();
  console.log('Servers ready.\n');
  console.log(`Config: CONCURRENCY=${CONCURRENCY}  WARMUP=${WARMUP_MS}ms  TEST=${TEST_MS}ms`);

  for (const [name, { z, e, h }] of Object.entries(suites)) {
    await suite(name, z, e, h);
  }

  printTable();

  if (outFile) writeCSV(outFile);

  process.exit(0);
}

main();
