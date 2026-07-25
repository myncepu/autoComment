const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RETRY_DELAY_MS = 30 * 60_000;
const BASE_RETRY_DELAY_MS = 5_000;

const SAFE_MESSAGES = Object.freeze({
  INVALID_SYNC_KEY: 'Cloud sync authentication failed.',
  VAULT_DELETED: 'Cloud sync vault is unavailable.',
  SYNC_ACCESS_DENIED: 'Cloud sync access was denied.',
  RATE_LIMITED: 'Cloud sync is temporarily rate limited.',
  SYNC_SERVER_ERROR: 'Cloud sync service is temporarily unavailable.',
  SYNC_REQUEST_FAILED: 'Cloud sync request failed.',
  INVALID_SYNC_RESPONSE: 'Cloud sync returned an invalid response.',
  INVALID_SYNC_REQUEST: 'Cloud sync request could not be encoded.',
  SYNC_NETWORK_ERROR: 'Cloud sync network request failed.',
  SYNC_TIMEOUT: 'Cloud sync request timed out.',
  SYNC_ORIGIN_MISMATCH: 'Cloud sync origin is invalid.'
});

const TRUSTED_RESPONSE_CODES = new Set([
  'INVALID_SYNC_KEY',
  'VAULT_DELETED',
  'RATE_LIMITED'
]);

export class CloudSyncError extends Error {
  constructor(code, status = 0, retryable = false, retryAfter) {
    super(SAFE_MESSAGES[code] ?? SAFE_MESSAGES.SYNC_REQUEST_FAILED);
    this.name = 'CloudSyncError';
    this.code = Object.hasOwn(SAFE_MESSAGES, code) ? code : 'SYNC_REQUEST_FAILED';
    this.status = Number.isInteger(status) && status >= 0 ? status : 0;
    this.retryable = Boolean(retryable);
    if (Number.isFinite(retryAfter) && retryAfter >= 0) this.retryAfter = retryAfter;
  }

  toJSON() {
    return {
      code: this.code,
      status: this.status,
      retryable: this.retryable,
      ...(this.retryAfter === undefined ? {} : { retryAfter: this.retryAfter })
    };
  }
}

function retryAfterSeconds(value, now) {
  if (typeof value !== 'string') return undefined;
  if (/^\d+(?:\.\d+)?$/u.test(value.trim())) {
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
  }
  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) return undefined;
  return Math.max(0, Math.ceil((retryAt - now) / 1_000));
}

function responseStatus(errorOrResponse) {
  const status = Number(errorOrResponse?.status);
  return Number.isInteger(status) && status >= 0 ? status : 0;
}

function responseHeader(errorOrResponse, name) {
  const headers = errorOrResponse?.headers;
  return headers && typeof headers.get === 'function' ? headers.get(name) : null;
}

function isTrustedResponseCode(code) {
  return typeof code === 'string' && TRUSTED_RESPONSE_CODES.has(code);
}

function responseCode(status, suppliedCode) {
  if (isTrustedResponseCode(suppliedCode)) return suppliedCode;
  if (status === 401) return 'INVALID_SYNC_KEY';
  if (status === 403) return 'SYNC_ACCESS_DENIED';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'SYNC_SERVER_ERROR';
  return 'SYNC_REQUEST_FAILED';
}

export function classifySyncFailure(errorOrResponse, now = Date.now()) {
  if (errorOrResponse instanceof CloudSyncError) return errorOrResponse;

  const status = responseStatus(errorOrResponse);
  if (status > 0) {
    const code = responseCode(status, errorOrResponse?.syncErrorCode);
    const retryable = status === 429 || status >= 500;
    const retryAfter = status === 429
      ? retryAfterSeconds(responseHeader(errorOrResponse, 'Retry-After'), now)
      : undefined;
    return new CloudSyncError(code, status, retryable, retryAfter);
  }

  return new CloudSyncError('SYNC_NETWORK_ERROR', 0, true);
}

function fixedOrigin(baseUrl) {
  try {
    const url = new URL(baseUrl);
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function queryString(query = {}) {
  try {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      if (typeof value === 'object') {
        throw new CloudSyncError('INVALID_SYNC_REQUEST', 0, false);
      }
      params.set(key, String(value));
    }
    const serialized = params.toString();
    return serialized ? `?${serialized}` : '';
  } catch (error) {
    if (error instanceof CloudSyncError) throw error;
    throw new CloudSyncError('INVALID_SYNC_REQUEST', 0, false);
  }
}

function jsonBody(value) {
  try {
    const body = JSON.stringify(value);
    if (typeof body !== 'string') throw new TypeError('JSON body must be defined');
    return body;
  } catch {
    throw new CloudSyncError('INVALID_SYNC_REQUEST', 0, false);
  }
}

async function responseError(response) {
  let syncErrorCode;
  try {
    const body = await response.json();
    const candidate = body?.error?.code;
    if (isTrustedResponseCode(candidate)) syncErrorCode = candidate;
  } catch {
    // Error bodies are untrusted diagnostics; status classification stays stable without them.
  }
  return classifySyncFailure({
    status: response.status,
    headers: response.headers,
    syncErrorCode
  });
}

async function responseData(response) {
  if (response.status === 204) return undefined;
  const body = await response.text();
  if (!body.trim()) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    throw new CloudSyncError('INVALID_SYNC_RESPONSE', responseStatus(response), true);
  }
}

function boundedTimeout(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_TIMEOUT_MS;
}

export function createCloudSyncTransport({
  baseUrl,
  syncKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const origin = fixedOrigin(baseUrl);
  const requestTimeoutMs = boundedTimeout(timeoutMs);

  async function request(path, init = {}) {
    if (!origin || typeof fetchImpl !== 'function') {
      throw new CloudSyncError('SYNC_ORIGIN_MISMATCH', 0, false);
    }

    const url = new URL(path, `${origin}/`);
    if (url.origin !== origin) throw new CloudSyncError('SYNC_ORIGIN_MISMATCH', 0, false);

    const controller = new AbortController();
    let timedOut = false;
    let timeoutId;
    const timeout = new Promise((resolve, reject) => {
      void resolve;
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new CloudSyncError('SYNC_TIMEOUT', 0, true));
      }, requestTimeoutMs);
    });

    try {
      const result = await Promise.race([
        (async () => {
          const response = await fetchImpl(url.toString(), {
            ...init,
            headers: {
              'Content-Type': 'application/json',
              ...(init.headers || {}),
              Authorization: `Bearer ${syncKey}`
            },
            signal: controller.signal
          });
          if (!response || typeof response.ok !== 'boolean') {
            throw new CloudSyncError('SYNC_NETWORK_ERROR', 0, true);
          }
          if (!response.ok) {
            const error = await responseError(response);
            if (timedOut) throw new CloudSyncError('SYNC_TIMEOUT', 0, true);
            throw error;
          }
          return responseData(response);
        })(),
        timeout
      ]);
      return result;
    } catch (error) {
      if (timedOut) throw new CloudSyncError('SYNC_TIMEOUT', 0, true);
      if (error instanceof CloudSyncError) throw error;
      throw classifySyncFailure(error);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return Object.freeze({
    status(deviceId) {
      return request(`/v1/status${queryString({ deviceId })}`, { method: 'GET' });
    },
    createVault(deviceId) {
      return request('/v1/vault', { method: 'PUT', body: jsonBody({ deviceId }) });
    },
    push(body) {
      return request('/v1/sync/push', { method: 'POST', body: jsonBody(body) });
    },
    pull(query) {
      return request(`/v1/sync/pull${queryString(query)}`, { method: 'GET' });
    },
    bootstrap(query) {
      return request(`/v1/sync/bootstrap${queryString(query)}`, { method: 'GET' });
    },
    history(query) {
      return request(`/v1/history${queryString(query)}`, { method: 'GET' });
    },
    deleteHistory(recordId, mutationId) {
      return request(`/v1/history/${encodeURIComponent(recordId)}`, {
        method: 'DELETE',
        body: jsonBody({ mutationId })
      });
    },
    deleteVault(confirmation) {
      return request('/v1/vault', {
        method: 'DELETE',
        body: jsonBody({ confirmation })
      });
    }
  });
}

export function nextRetryAt({
  attemptCount,
  now,
  retryAfter,
  random = Math.random
} = {}) {
  const safeNow = Number.isFinite(now) ? now : Date.now();
  const safeAttemptCount = Number.isFinite(attemptCount) ? Math.max(0, attemptCount) : 0;
  const capMs = Math.min(
    MAX_RETRY_DELAY_MS,
    BASE_RETRY_DELAY_MS * (2 ** Math.min(safeAttemptCount, 12))
  );
  const jitter = Math.min(1, Math.max(0, Number(random())));
  const backoffAt = safeNow + Math.floor(jitter * capMs);
  const retryAfterAt = Number.isFinite(retryAfter) && retryAfter >= 0
    ? safeNow + (retryAfter * 1_000)
    : Number.NEGATIVE_INFINITY;
  return Math.max(backoffAt, retryAfterAt);
}
