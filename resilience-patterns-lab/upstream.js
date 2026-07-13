'use strict';
const http = require('http');
const client = require('prom-client');

// ---- prometheus metrics ----
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const metricRequestsTotal = new client.Counter({
  name: 'upstream_requests_total',
  help: 'Requests to /work by outcome',
  labelNames: ['outcome'], // received | completed | errored | shed | hung
  registers: [register],
});
const metricActiveRequests = new client.Gauge({
  name: 'upstream_active_requests',
  help: 'Requests currently holding a concurrency slot',
  registers: [register],
});
const metricQueueDepth = new client.Gauge({
  name: 'upstream_queue_depth',
  help: 'Requests waiting for a free slot (shedMode=queue only)',
  registers: [register],
});

// ---- injectable behavior, changed via POST /admin/config ----
let config = {
  latencyMs: 20,          // baseline processing delay
  spikeProbability: 0,    // 0..1 chance a request takes spikeLatencyMs instead
  spikeLatencyMs: 500,
  hangProbability: 0,     // 0..1 chance a request is accepted then never answered
  errorRate: 0,           // 0..1 chance of a 500 response
  concurrencyCap: 1000,   // hard capacity: max requests processed at once
  shedMode: 'queue',      // 'queue' (accept everything, serialize behind cap) | 'shed' (503 immediately over cap)
};

const counters = {
  received: 0,
  completed: 0,
  errored: 0,
  shed: 0,
  hungActive: 0,
  hungTotal: 0,
};

let activeCount = 0;
const waiters = []; // resolve functions waiting for a free slot when shedMode === 'queue'

function acquireSlot() {
  if (activeCount < config.concurrencyCap) {
    activeCount++;
    metricActiveRequests.set(activeCount);
    return Promise.resolve(true);
  }
  if (config.shedMode === 'shed') {
    counters.shed++;
    metricRequestsTotal.inc({ outcome: 'shed' });
    return Promise.resolve(false);
  }
  metricQueueDepth.set(waiters.length + 1);
  return new Promise((resolve) => waiters.push(resolve));
}

function releaseSlot() {
  activeCount--;
  metricActiveRequests.set(activeCount);
  const next = waiters.shift();
  if (next) {
    activeCount++;
    metricActiveRequests.set(activeCount);
    metricQueueDepth.set(waiters.length);
    next(true);
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/admin/config') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const patch = JSON.parse(body || '{}');
        Object.assign(config, patch);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, config }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/admin/reset') {
    counters.received = 0;
    counters.completed = 0;
    counters.errored = 0;
    counters.shed = 0;
    counters.hungTotal = 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'GET' && req.url === '/admin/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ config, counters, activeCount, queueDepth: waiters.length }));
    return;
  }

  if (req.method === 'GET' && req.url === '/metrics') {
    register.metrics().then((body) => {
      res.writeHead(200, { 'Content-Type': register.contentType });
      res.end(body);
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/work') {
    counters.received++;
    metricRequestsTotal.inc({ outcome: 'received' });
    let responded = false;

    const finish = (statusCode, body, extraHeaders) => {
      if (responded) return;
      responded = true;
      res.writeHead(statusCode, Object.assign({ 'Content-Type': 'text/plain' }, extraHeaders || {}));
      res.end(body);
    };

    req.on('close', () => {
      // client aborted (e.g. its own timeout fired) before we responded
      if (!responded) {
        responded = true;
        if (req.__gotSlot) releaseSlot();
        if (req.__hanging) {
          counters.hungActive--;
        }
      }
    });

    acquireSlot().then((got) => {
      if (responded) {
        // client already gave up while we were queued; drop the slot we were just handed
        if (got) releaseSlot();
        return;
      }
      if (!got) {
        finish(503, 'shed', { 'X-Shed': '1' });
        return;
      }
      req.__gotSlot = true;

      if (Math.random() < config.hangProbability) {
        req.__hanging = true;
        counters.hungActive++;
        counters.hungTotal++;
        metricRequestsTotal.inc({ outcome: 'hung' });
        return; // accept-then-stall: never respond, never release the slot ourselves
      }

      const isError = Math.random() < config.errorRate;
      const isSpike = Math.random() < config.spikeProbability;
      const delay = isSpike ? config.spikeLatencyMs : config.latencyMs;

      setTimeout(() => {
        if (responded) return; // client already aborted; its slot was already released in 'close'
        releaseSlot();
        if (isError) {
          counters.errored++;
          metricRequestsTotal.inc({ outcome: 'errored' });
          finish(500, 'upstream error');
        } else {
          counters.completed++;
          metricRequestsTotal.inc({ outcome: 'completed' });
          finish(200, 'ok');
        }
      }, delay);
    });
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

const port = process.env.PORT || 4000;
server.listen(port, () => {
  console.log(`upstream listening on :${port}`);
});
