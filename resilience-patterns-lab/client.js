'use strict';
const http = require('http');
const { URL } = require('url');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = argv[i + 1];
      out[key] = val;
      i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const cfg = {
  url: args.url || 'http://localhost:4000/work',
  rate: Number(args.rate || 20),           // logical requests per second (open-loop)
  duration: Number(args.duration || 15),   // seconds
  concurrency: Number(args.concurrency || 50), // client connection budget (agent maxSockets)
  timeout: Number(args.timeout || 0),      // ms; 0 = disabled
  retries: Number(args.retries || 0),      // max retry attempts per logical request
  backoff: args.backoff || 'none',         // none | fixed | exponential
  backoffBase: Number(args['backoff-base'] || 100),
  backoffFactor: Number(args['backoff-factor'] || 2),
  jitter: args.jitter || 'off',            // off | full
  breaker: args.breaker || 'off',          // off | on
  breakerThreshold: Number(args['breaker-threshold'] || 0.5),
  breakerWindow: Number(args['breaker-window'] || 20),
  breakerOpenMs: Number(args['breaker-open-ms'] || 5000),
  breakerHalfOpenProbes: Number(args['breaker-half-open-probes'] || 1),
};

console.log('client config:', cfg);

const target = new URL(cfg.url);
const agent = new http.Agent({ keepAlive: true, maxSockets: cfg.concurrency });

// ---- per-interval stats (reset every reporting tick) ----
let stats = { sent: 0, success: 0, fail: 0, timedOut: 0, retried: 0, shed: 0, breakerRejected: 0 };
let latencies = [];

// ---- circuit breaker state (hand-written, plain) ----
let breakerState = 'CLOSED'; // CLOSED | OPEN | HALF_OPEN
let breakerOpenedAt = 0;
let breakerWindowResults = []; // rolling booleans, true = success
let halfOpenProbesInFlight = 0;

function recordBreakerResult(success) {
  if (cfg.breaker !== 'on') return;
  if (breakerState === 'HALF_OPEN') {
    if (success) {
      breakerState = 'CLOSED';
      breakerWindowResults = [];
      halfOpenProbesInFlight = 0;
    } else {
      breakerState = 'OPEN';
      breakerOpenedAt = Date.now();
      halfOpenProbesInFlight = 0;
    }
    return;
  }
  breakerWindowResults.push(success);
  if (breakerWindowResults.length > cfg.breakerWindow) breakerWindowResults.shift();
  if (breakerWindowResults.length >= cfg.breakerWindow) {
    const failures = breakerWindowResults.filter((r) => !r).length;
    const errorRate = failures / breakerWindowResults.length;
    if (errorRate >= cfg.breakerThreshold) {
      breakerState = 'OPEN';
      breakerOpenedAt = Date.now();
    }
  }
}

function breakerGate() {
  if (cfg.breaker !== 'on') return 'PASS';
  if (breakerState === 'OPEN') {
    if (Date.now() - breakerOpenedAt >= cfg.breakerOpenMs) {
      breakerState = 'HALF_OPEN';
      halfOpenProbesInFlight = 0;
    } else {
      return 'REJECT';
    }
  }
  if (breakerState === 'HALF_OPEN') {
    if (halfOpenProbesInFlight >= cfg.breakerHalfOpenProbes) return 'REJECT';
    halfOpenProbesInFlight++;
  }
  return 'PASS';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeBackoff(attempt) {
  if (cfg.backoff === 'none') return 0;
  const base = cfg.backoff === 'exponential'
    ? cfg.backoffBase * Math.pow(cfg.backoffFactor, attempt - 1)
    : cfg.backoffBase;
  if (cfg.jitter === 'full') return Math.random() * base;
  return base;
}

function doHttpRequest() {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'GET',
      agent,
    }, (res) => {
      res.resume(); // drain body
      res.on('end', () => {
        if (res.statusCode === 503 && res.headers['x-shed'] === '1') {
          reject({ type: 'shed' });
        } else if (res.statusCode >= 500) {
          reject({ type: 'error' });
        } else {
          resolve();
        }
      });
    });

    if (cfg.timeout > 0) {
      req.setTimeout(cfg.timeout, () => {
        req.destroy({ type: 'timeout' });
      });
    }

    req.on('error', (err) => {
      reject({ type: err && err.type === 'timeout' ? 'timeout' : 'error' });
    });

    req.end();
  });
}

async function attemptOnce(attempt) {
  const gate = breakerGate();
  if (gate === 'REJECT') {
    stats.breakerRejected++;
    stats.fail++;
    return;
  }

  stats.sent++;
  const start = Date.now();
  try {
    await doHttpRequest();
    latencies.push(Date.now() - start);
    stats.success++;
    recordBreakerResult(true);
  } catch (err) {
    latencies.push(Date.now() - start);
    const type = (err && err.type) || 'error';
    if (type === 'timeout') stats.timedOut++;
    else if (type === 'shed') stats.shed++;
    else stats.fail++;
    recordBreakerResult(false);

    if (attempt <= cfg.retries) {
      stats.retried++;
      const delay = computeBackoff(attempt);
      if (delay > 0) await sleep(delay);
      return attemptOnce(attempt + 1);
    }
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

// ---- open-loop load generator ----
const intervalMs = 1000 / cfg.rate;
const loadTimer = setInterval(() => {
  attemptOnce(1);
}, intervalMs);

// ---- per-second reporter ----
let secondsElapsed = 0;
const reportTimer = setInterval(() => {
  secondsElapsed++;
  const sorted = latencies.slice().sort((a, b) => a - b);
  const p50 = percentile(sorted, 0.5);
  const p99 = percentile(sorted, 0.99);
  const field = (label, value, width) => `${label}=${String(value)}`.padEnd(width);
  console.log(
    field('t', `${secondsElapsed}s`, 7) +
    field('sent', stats.sent, 9) +
    field('success', stats.success, 12) +
    field('fail', stats.fail, 9) +
    field('timedOut', stats.timedOut, 13) +
    field('retried', stats.retried, 12) +
    field('shed', stats.shed, 9) +
    field('breakerRejected', stats.breakerRejected, 20) +
    field('breaker', breakerState, 17) +
    field('p50', `${p50}ms`, 11) +
    field('p99', `${p99}ms`, 10)
  );
  stats = { sent: 0, success: 0, fail: 0, timedOut: 0, retried: 0, shed: 0, breakerRejected: 0 };
  latencies = [];

  if (secondsElapsed >= cfg.duration) {
    clearInterval(loadTimer);
    clearInterval(reportTimer);
    setTimeout(() => process.exit(0), 200);
  }
}, 1000);
