'use strict';

const IORedis = require('ioredis');
const { Worker } = require('bullmq');
const {
  POSTING_QUEUE_NAME,
  getRedisConnection,
} = require('../lib/postingQueue');
const {
  completePostingLog,
  ensurePostingLogTable,
  ensureUserTable,
  executeLivePost,
  executeStoredSlot,
  pool,
} = require('../server');

const connection = getRedisConnection();
const redis = new IORedis(connection);
const WORKER_NAME = process.env.WORKER_NAME || `posting-worker-${process.pid}`;
const GLOBAL_LOCK_KEY = process.env.POSTING_GLOBAL_LOCK_KEY || 'posting:global-execution-lock';
const GLOBAL_LOCK_TTL_MS = Number.parseInt(process.env.POSTING_GLOBAL_LOCK_TTL_MS, 10) || 30 * 60 * 1000;
const LOCK_WAIT_MS = Number.parseInt(process.env.POSTING_LOCK_WAIT_MS, 10) || 2000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function classifyStatus(error) {
  const message = String(error?.message || '');
  if (/captcha|otp|추가 인증|보안문자|본인 확인|verification/i.test(message)) {
    return 'verification_required';
  }
  if (/timeout|시간 초과/i.test(message)) return 'timeout';
  return 'failed';
}

async function withGlobalPostingLock(job, task) {
  const token = `${WORKER_NAME}:${job.id}:${Date.now()}`;

  while (true) {
    const locked = await redis.set(GLOBAL_LOCK_KEY, token, 'PX', GLOBAL_LOCK_TTL_MS, 'NX');
    if (locked) break;
    await sleep(LOCK_WAIT_MS);
  }

  const renew = setInterval(() => {
    redis.eval(
      'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end',
      1,
      GLOBAL_LOCK_KEY,
      token,
      GLOBAL_LOCK_TTL_MS,
    ).catch(() => {});
  }, Math.max(1000, Math.floor(GLOBAL_LOCK_TTL_MS / 3)));

  try {
    return await task();
  } finally {
    clearInterval(renew);
    await redis.eval(
      'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
      1,
      GLOBAL_LOCK_KEY,
      token,
    ).catch(() => {});
  }
}

async function processPostingJob(job) {
  const { logId, user, slotId, trigger, livePayload } = job.data || {};
  if (!logId || !user || !slotId) {
    throw new Error('작업 데이터가 올바르지 않습니다.');
  }

  await withGlobalPostingLock(job, async () => {
    await completePostingLog(logId, {
      status: 'running',
      reason: `${WORKER_NAME}에서 게시 작업을 시작했습니다.`,
      detail: { queueJobId: job.id, trigger, worker: WORKER_NAME },
    });

    try {
      const result = livePayload
        ? await executeLivePost(user, slotId, livePayload)
        : await executeStoredSlot(user, slotId);

      await completePostingLog(logId, {
        status: 'success',
        reason: '게시가 완료되었습니다.',
        postedUrl: result.url || null,
        detail: {
          queueJobId: job.id,
          trigger,
          worker: WORKER_NAME,
          log: result.log || [],
          postId: result.postId || livePayload?.postId || null,
          nextPostId: result.nextPostId || null,
        },
      });
    } catch (err) {
      await completePostingLog(logId, {
        status: classifyStatus(err),
        reason: err.message,
        detail: {
          queueJobId: job.id,
          trigger,
          worker: WORKER_NAME,
          log: err.posterLog || [],
        },
      });
      throw err;
    }
  });
}

async function main() {
  await ensureUserTable();
  await ensurePostingLogTable();

  const worker = new Worker(POSTING_QUEUE_NAME, processPostingJob, {
    connection,
    concurrency: Number.parseInt(process.env.POSTING_WORKER_CONCURRENCY, 10) || 1,
  });

  worker.on('completed', job => {
    console.log(`[${WORKER_NAME}] completed job ${job.id}`);
  });
  worker.on('failed', (job, err) => {
    console.error(`[${WORKER_NAME}] failed job ${job?.id}: ${err.message}`);
  });
  worker.on('error', err => {
    console.error(`[${WORKER_NAME}] worker error: ${err.message}`);
  });

  const shutdown = async signal => {
    console.log(`[${WORKER_NAME}] ${signal} received, shutting down`);
    await worker.close().catch(() => {});
    await redis.quit().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch(err => {
  console.error(`[${WORKER_NAME}] initialization error:`, err);
  process.exitCode = 1;
});
