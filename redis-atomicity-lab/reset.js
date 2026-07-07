'use strict';
// Reset to clean state: set stock back to a known starting value so every
// experiment is independently repeatable.
const { connect, KEY } = require('./lib');

const STOCK = parseInt(process.env.STOCK || '100', 10);

(async () => {
  const redis = connect();
  await redis.set(KEY, STOCK);
  console.log(`reset: ${KEY} = ${STOCK}`);
  await redis.quit();
})();
