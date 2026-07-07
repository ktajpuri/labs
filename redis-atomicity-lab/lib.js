'use strict';
const Redis = require('ioredis');

const KEY = 'stock';

function connect() {
  return new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    maxRetriesPerRequest: null,
  });
}

module.exports = { connect, KEY };
