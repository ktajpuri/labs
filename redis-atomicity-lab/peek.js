'use strict';
// Observe the current steady state: what value is the stock key holding right now?
const { connect, KEY } = require('./lib');

(async () => {
  const redis = connect();
  const v = await redis.get(KEY);
  console.log(`${KEY} = ${v === null ? '(unset)' : v}`);
  await redis.quit();
})();
