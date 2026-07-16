const { Client } = require('pg');

const A = { name: 'bank-a', host: 'localhost', port: 55432, user: 'lab', password: 'lab', database: 'bank_a' };
const B = { name: 'bank-b', host: 'localhost', port: 55433, user: 'lab', password: 'lab', database: 'bank_b' };

async function connect(cfg) {
  const c = new Client(cfg);
  await c.connect();
  c.label = cfg.name;
  return c;
}

function ts() {
  return new Date().toISOString().slice(11, 23);
}

function log(...args) {
  console.log(`[${ts()}]`, ...args);
}

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
}

function has(flag) {
  return process.argv.includes(flag);
}

async function balances() {
  const a = await connect(A);
  const b = await connect(B);
  const alice = (await a.query(`SELECT balance FROM accounts WHERE name='alice'`)).rows[0].balance;
  const bob = (await b.query(`SELECT balance FROM accounts WHERE name='bob'`)).rows[0].balance;
  await a.end();
  await b.end();
  return { alice: Number(alice), bob: Number(bob), total: Number(alice) + Number(bob) };
}

const INVARIANT_TOTAL = 2000;

module.exports = { A, B, connect, log, ts, arg, has, balances, INVARIANT_TOTAL };
