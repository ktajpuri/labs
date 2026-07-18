'use strict';
// A hand-rolled MINIMAL durable-execution engine — the mechanism Temporal implements,
// with none of the SDK. ~40 lines of real logic.
//
// The whole idea:
//  - Workflow code never does side effects directly. It calls ctx.step(name, fn).
//  - Every step's RESULT is appended to an append-only history AFTER the step returns.
//  - On restart we re-run the workflow from the top. When code reaches a step whose
//    result is already in history, we RETURN THE RECORDED RESULT — we do NOT re-run it
//    (this is REPLAY, not recompute). We only actually execute the first step that has
//    no recorded result yet.
//
// That single rule => completed steps never re-run, and computed values are never lost.

const fs = require('fs');
const path = require('path');

const HISTORY = path.join(__dirname, '..', 'state', 'wf-history.json');

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY, 'utf8')); } catch { return { events: [] }; }
}
function appendEvent(ev) {
  const h = loadHistory();
  h.events.push(ev);
  fs.writeFileSync(HISTORY, JSON.stringify(h, null, 2)); // durable write = the commit point
}

// crash hook: process dies abruptly at the named point
function maybeCrash(point, crashAfter) {
  if (point === crashAfter) {
    console.log(`  !! CRASH (kill -9) right after: ${point}`);
    process.exit(137);
  }
}

// Build a context whose .step() replays from history or executes-and-records.
function makeContext(crashAfter) {
  const history = loadHistory();
  let cursor = 0; // walk recorded events in order as the workflow re-issues the same steps

  return {
    step(name, fn) {
      const recorded = history.events[cursor];
      if (recorded && recorded.step === name) {
        // REPLAY: this step already completed in a previous life. Return its recorded
        // result. Do NOT run fn() — no side effect, no recompute.
        cursor += 1;
        console.log(`  [replay] ${name} -> ${JSON.stringify(recorded.result)}`);
        return recorded.result;
      }
      // EXECUTE: first not-yet-recorded step. Run the real side effect...
      const result = fn();
      // ...crash window: the side effect has happened in the world, but the result is
      // NOT yet in history. A crash here means replay will re-run this step (at-least-once).
      maybeCrash(`${name}-side`, crashAfter);
      appendEvent({ step: name, result });      // durable record — the point of no re-run
      cursor += 1;
      maybeCrash(`${name}-recorded`, crashAfter); // clean boundary: recorded, safe to die
      console.log(`  [exec]   ${name} -> ${JSON.stringify(result)}`);
      return result;
    },
  };
}

// Run a workflow function to completion, replaying prior history first.
function run(workflowFn, crashAfter) {
  const ctx = makeContext(crashAfter);
  return workflowFn(ctx);
}

module.exports = { run };
