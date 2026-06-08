'use strict';

const { Queue } = require('bullmq');

const POSTING_QUEUE_NAME = process.env.POSTING_QUEUE_NAME || 'posting';

function getRedisConnection() {
  return {
    host: process.env.REDIS_HOST || 'easypost_redis',
    port: Number.parseInt(process.env.REDIS_PORT, 10) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,
  };
}

function createPostingQueue() {
  return new Queue(POSTING_QUEUE_NAME, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { age: 60 * 60 * 24 * 7, count: 1000 },
      removeOnFail: { age: 60 * 60 * 24 * 14, count: 2000 },
    },
  });
}

module.exports = {
  POSTING_QUEUE_NAME,
  createPostingQueue,
  getRedisConnection,
};
