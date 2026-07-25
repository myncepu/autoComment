import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySyncFailure,
  createCloudSyncTransport,
  nextRetryAt
} from '../lib/cloud-sync-transport.mjs';

const VALID_SYNC_KEY = 'acsync_AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function successResponse() {
  return Response.json({ ok: true, requestId: 'request-1', highWatermark: 0 });
}

function createTransport(fetchImpl, options = {}) {
  return createCloudSyncTransport({
    baseUrl: 'https://sync.example.workers.dev',
    syncKey: VALID_SYNC_KEY,
    fetchImpl,
    ...options
  });
}

async function captureTransportError(response) {
  const transport = createTransport(async () => response);
  try {
    await transport.status('device-a');
    assert.fail('status should reject');
  } catch (error) {
    return error;
  }
}

test('sends the sync key only in Authorization to the fixed origin', async () => {
  const calls = [];
  const transport = createTransport(async (url, init) => {
    calls.push({ url, init });
    return successResponse();
  });

  await transport.status('device-a');

  assert.equal(calls[0].url, 'https://sync.example.workers.dev/v1/status?deviceId=device-a');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${VALID_SYNC_KEY}`);
  assert.doesNotMatch(JSON.stringify(calls[0].init.body ?? null), /acsync_/u);
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
});

test('uses the documented JSON methods and endpoint paths', async () => {
  const calls = [];
  const transport = createTransport(async (url, init) => {
    calls.push({ url, init });
    return successResponse();
  });

  await transport.createVault('device-a');
  await transport.push({ deviceId: 'device-a', mutations: [{ mutationId: 'mutation-a' }] });
  await transport.pull({ cursor: 7, limit: 100, deviceId: 'device-a' });
  await transport.bootstrap({ cursor: 4, limit: 50, deviceId: 'device-a' });
  await transport.history({ targetDomain: 'target.test', limit: 50 });
  await transport.deleteHistory('batch-a:1', 'delete-a');
  await transport.deleteVault('vault-a');

  assert.deepEqual(calls.map(({ url, init }) => ({
    url,
    method: init.method,
    body: init.body
  })), [
    {
      url: 'https://sync.example.workers.dev/v1/vault',
      method: 'PUT',
      body: JSON.stringify({ deviceId: 'device-a' })
    },
    {
      url: 'https://sync.example.workers.dev/v1/sync/push',
      method: 'POST',
      body: JSON.stringify({ deviceId: 'device-a', mutations: [{ mutationId: 'mutation-a' }] })
    },
    {
      url: 'https://sync.example.workers.dev/v1/sync/pull?cursor=7&limit=100&deviceId=device-a',
      method: 'GET',
      body: undefined
    },
    {
      url: 'https://sync.example.workers.dev/v1/sync/bootstrap?cursor=4&limit=50&deviceId=device-a',
      method: 'GET',
      body: undefined
    },
    {
      url: 'https://sync.example.workers.dev/v1/history?targetDomain=target.test&limit=50',
      method: 'GET',
      body: undefined
    },
    {
      url: 'https://sync.example.workers.dev/v1/history/batch-a%3A1',
      method: 'DELETE',
      body: JSON.stringify({ mutationId: 'delete-a' })
    },
    {
      url: 'https://sync.example.workers.dev/v1/vault',
      method: 'DELETE',
      body: JSON.stringify({ confirmation: 'vault-a' })
    }
  ]);
});

test('returns stable safe failures for Worker response classes', async () => {
  const cases = [
    {
      response: new Response(JSON.stringify({
        error: { code: 'INVALID_SYNC_KEY', message: '同步密钥无效。' }
      }), { status: 401, headers: { 'Content-Type': 'application/json' } }),
      expected: { code: 'INVALID_SYNC_KEY', status: 401, retryable: false, retryAfter: undefined }
    },
    {
      response: new Response(JSON.stringify({
        error: { code: 'VAULT_DELETED', message: '保险库已删除。' }
      }), { status: 403, headers: { 'Content-Type': 'application/json' } }),
      expected: { code: 'VAULT_DELETED', status: 403, retryable: false, retryAfter: undefined }
    },
    {
      response: new Response(JSON.stringify({
        error: { code: 'RATE_LIMITED', message: '请求过于频繁。' }
      }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '120' }
      }),
      expected: { code: 'RATE_LIMITED', status: 429, retryable: true, retryAfter: 120 }
    },
    {
      response: new Response('untrusted diagnostic response', { status: 500 }),
      expected: { code: 'SYNC_SERVER_ERROR', status: 500, retryable: true, retryAfter: undefined }
    }
  ];

  for (const { response, expected } of cases) {
    const error = await captureTransportError(response);
    assert.deepEqual({
      code: error.code,
      status: error.status,
      retryable: error.retryable,
      retryAfter: error.retryAfter
    }, expected);
    assert.doesNotMatch(error.message, /同步密钥|保险库|untrusted/u);
    assert.doesNotMatch(JSON.stringify(error), /untrusted/u);
  }
});

test('maps malformed success JSON and network exceptions to stable retryable errors', async () => {
  const malformed = createTransport(async () => new Response('{not json', { status: 200 }));
  await assert.rejects(
    malformed.status('device-a'),
    (error) => error.code === 'INVALID_SYNC_RESPONSE'
      && error.status === 200
      && error.retryable === true
      && !error.cause
  );

  const network = createTransport(async () => {
    throw new Error(`network failed for ${VALID_SYNC_KEY}`);
  });
  await assert.rejects(
    network.status('device-a'),
    (error) => error.code === 'SYNC_NETWORK_ERROR'
      && error.status === 0
      && error.retryable === true
      && !error.cause
      && !JSON.stringify(error).includes(VALID_SYNC_KEY)
  );
});

test('accepts 204 and empty successful JSON responses', async () => {
  const noContent = createTransport(async () => new Response(null, { status: 204 }));
  const emptyBody = createTransport(async () => new Response(null, { status: 200 }));

  assert.equal(await noContent.status('device-a'), undefined);
  assert.equal(await emptyBody.status('device-a'), undefined);
});

test('keeps response-body reading inside the request timeout', { timeout: 100 }, async () => {
  const transport = createTransport((url, init) => {
    void url;
    const stalledBody = () => new Promise((resolve, reject) => {
      void resolve;
      init.signal.addEventListener('abort', () => {
        reject(new DOMException('body read aborted', 'AbortError'));
      });
    });
    return Promise.resolve({ ok: true, status: 200, json: stalledBody, text: stalledBody });
  }, { timeoutMs: 5 });

  await assert.rejects(
    transport.status('device-a'),
    (error) => error.code === 'SYNC_TIMEOUT'
      && error.status === 0
      && error.retryable === true
      && !error.cause
  );
});

test('times out when a response body ignores the abort signal', { timeout: 100 }, async () => {
  const transport = createTransport(async () => ({
    ok: true,
    status: 200,
    text: () => new Promise(() => {})
  }), { timeoutMs: 5 });

  await assert.rejects(
    transport.status('device-a'),
    (error) => error.code === 'SYNC_TIMEOUT'
      && error.status === 0
      && error.retryable === true
      && !error.cause
  );
});

test('normalizes query enumeration and value-access exceptions without exposing input text', async () => {
  let fetchCalled = false;
  const transport = createTransport(async () => {
    fetchCalled = true;
    return successResponse();
  });
  const throwingGetter = {};
  Object.defineProperty(throwingGetter, 'cursor', {
    enumerable: true,
    get() {
      throw new Error(`getter leaked ${VALID_SYNC_KEY}`);
    }
  });

  for (const query of [
    null,
    new Proxy({}, {
      ownKeys() {
        throw new Error(`enumeration leaked ${VALID_SYNC_KEY}`);
      }
    }),
    throwingGetter
  ]) {
    await assert.rejects(
      Promise.resolve().then(() => transport.pull(query)),
      (error) => error.code === 'INVALID_SYNC_REQUEST'
        && error.status === 0
        && error.retryable === false
        && !error.cause
        && !error.message.includes(VALID_SYNC_KEY)
        && !JSON.stringify(error).includes(VALID_SYNC_KEY)
    );
  }
  assert.equal(fetchCalled, false);
});

test('rejects non-origin base URLs before a request can leave the fixed origin', async () => {
  let called = false;
  const transport = createCloudSyncTransport({
    baseUrl: 'https://sync.example.workers.dev/untrusted-path',
    syncKey: VALID_SYNC_KEY,
    fetchImpl: async () => {
      called = true;
      return successResponse();
    }
  });

  await assert.rejects(
    transport.status('device-a'),
    (error) => error.code === 'SYNC_ORIGIN_MISMATCH'
      && error.status === 0
      && error.retryable === false
  );
  assert.equal(called, false);
});

test('bounds each request with an AbortSignal and reports a stable timeout', async () => {
  const transport = createTransport((url, init) => new Promise((resolve, reject) => {
    void url;
    void resolve;
    assert.ok(init.signal instanceof AbortSignal);
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }), { timeoutMs: 5 });

  await assert.rejects(
    transport.status('device-a'),
    (error) => error.code === 'SYNC_TIMEOUT'
      && error.status === 0
      && error.retryable === true
      && !error.cause
  );
});

test('classifies direct network failures without exposing their source text', () => {
  const error = classifySyncFailure(new Error(`connection failure: ${VALID_SYNC_KEY}`), 1_000);
  assert.deepEqual({
    code: error.code,
    status: error.status,
    retryable: error.retryable,
    retryAfter: error.retryAfter
  }, {
    code: 'SYNC_NETWORK_ERROR',
    status: 0,
    retryable: true,
    retryAfter: undefined
  });
  assert.doesNotMatch(error.message, /acsync_/u);
  assert.doesNotMatch(JSON.stringify(error), /acsync_/u);
});

test('uses full-jitter exponential retry and honours only later Retry-After values', () => {
  assert.equal(nextRetryAt({
    attemptCount: 0,
    now: 1_000,
    random: () => 0.5
  }), 3_500);
  assert.equal(nextRetryAt({
    attemptCount: 20,
    now: 1_000,
    random: () => 1
  }), 1_801_000);
  assert.equal(nextRetryAt({
    attemptCount: 1,
    now: 1_000,
    retryAfter: 120,
    random: () => 0
  }), 121_000);
  assert.equal(nextRetryAt({
    attemptCount: 1,
    now: 1_000,
    retryAfter: -1,
    random: () => 0.5
  }), 6_000);
});
