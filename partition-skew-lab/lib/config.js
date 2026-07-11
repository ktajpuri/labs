// Shared config for the Node scripts. Env vars override everything.
module.exports = {
  brokers: (process.env.KAFKA_BROKERS || 'localhost:29092').split(','),
  topic: process.env.TOPIC || 'events',
  groupId: process.env.GROUP_ID || 'skew-lab-group',
  defaultPartitions: 4,
};
