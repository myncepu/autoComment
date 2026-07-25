const SAFE_MESSAGES = new Map<string, string>([
  ['CORS_HEADER_NOT_ALLOWED', 'The requested headers are not allowed.'],
  ['CORS_ORIGIN_FORBIDDEN', 'The request origin is not allowed.'],
  ['INTERNAL_ERROR', 'Cloud sync service is temporarily unavailable.'],
  ['INVALID_DEVICE_ID', 'The device identifier is invalid.'],
  ['INVALID_JSON', 'The request body must be valid JSON.'],
  ['INVALID_REQUEST', 'The request is invalid.'],
  ['INVALID_SYNC_KEY', 'Cloud sync authentication failed.'],
  ['METHOD_NOT_ALLOWED', 'The request method is not allowed.'],
  ['NOT_FOUND', 'The requested endpoint was not found.'],
  ['PAYLOAD_TOO_LARGE', 'The request body is too large.'],
  ['UNSUPPORTED_MEDIA_TYPE', 'The request body must use application/json.'],
  ['VAULT_CONFIRMATION_MISMATCH', 'The vault confirmation does not match.'],
  ['VAULT_DELETED', 'Cloud sync vault is unavailable.']
]);

const ALLOWED_REQUEST_HEADERS = 'Authorization, Content-Type';

export class HttpError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(code: string, status: number, retryable = false) {
    super(SAFE_MESSAGES.get(code) ?? SAFE_MESSAGES.get('INTERNAL_ERROR'));
    this.name = 'HttpError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export function fail(
  code: string,
  status: number,
  retryable = false
): never {
  throw new HttpError(code, status, retryable);
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function apiError(
  code: string,
  status: number,
  retryable: boolean,
  requestId: string
): Response {
  const safeCode = SAFE_MESSAGES.has(code) ? code : 'INTERNAL_ERROR';
  return json(
    {
      ok: false,
      error: {
        code: safeCode,
        message:
          SAFE_MESSAGES.get(safeCode) ??
          'Cloud sync service is temporarily unavailable.',
        retryable
      },
      requestId
    },
    { status }
  );
}

function configuredOrigins(env: Env): string[] {
  return env.ALLOWED_EXTENSION_ORIGINS.split(',')
    .map((value) => value.trim())
    .filter(
      (value) =>
        /^(?:chrome|moz)-extension:\/\/[A-Za-z0-9_-]+$/u.test(value)
    );
}

export function allowedOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get('Origin');
  return origin && configuredOrigins(env).includes(origin) ? origin : null;
}

export function hasForbiddenOrigin(request: Request, env: Env): boolean {
  return (
    request.headers.has('Origin') && allowedOrigin(request, env) === null
  );
}

function appendVaryOrigin(headers: Headers): void {
  const vary = headers.get('Vary');
  const values = vary
    ? vary.split(',').map((value) => value.trim().toLowerCase())
    : [];
  if (!values.includes('origin')) {
    headers.set('Vary', vary ? `${vary}, Origin` : 'Origin');
  }
}

export function allowedMethods(pathname: string): string | null {
  if (pathname === '/v1/vault') return 'PUT, DELETE, OPTIONS';
  if (pathname === '/v1/status') return 'GET, OPTIONS';
  return null;
}

export function withCors(
  request: Request,
  response: Response,
  env: Env
): Response {
  appendVaryOrigin(response.headers);
  response.headers.delete('Access-Control-Allow-Credentials');

  const origin = allowedOrigin(request, env);
  if (origin) {
    response.headers.set('Access-Control-Allow-Origin', origin);
    const methods = allowedMethods(new URL(request.url).pathname);
    if (methods) response.headers.set('Access-Control-Allow-Methods', methods);
    response.headers.set(
      'Access-Control-Allow-Headers',
      ALLOWED_REQUEST_HEADERS
    );
  } else {
    response.headers.delete('Access-Control-Allow-Origin');
    response.headers.delete('Access-Control-Allow-Methods');
    response.headers.delete('Access-Control-Allow-Headers');
  }

  return response;
}

export function preflight(
  request: Request,
  env: Env,
  requestId: string
): Response {
  const pathname = new URL(request.url).pathname;
  const methods = allowedMethods(pathname);
  if (!methods) return apiError('NOT_FOUND', 404, false, requestId);

  if (!allowedOrigin(request, env)) {
    return apiError('CORS_ORIGIN_FORBIDDEN', 403, false, requestId);
  }

  const requestedMethod = request.headers.get(
    'Access-Control-Request-Method'
  );
  const allowed = methods
    .split(',')
    .map((method) => method.trim())
    .filter((method) => method !== 'OPTIONS');
  if (!requestedMethod || !allowed.includes(requestedMethod)) {
    const response = apiError('METHOD_NOT_ALLOWED', 405, false, requestId);
    response.headers.set('Allow', methods);
    return response;
  }

  const requestedHeaders = request.headers.get(
    'Access-Control-Request-Headers'
  );
  if (requestedHeaders) {
    const supported = new Set(['authorization', 'content-type']);
    const allSupported = requestedHeaders
      .split(',')
      .map((header) => header.trim().toLowerCase())
      .every((header) => supported.has(header));
    if (!allSupported) {
      return apiError('CORS_HEADER_NOT_ALLOWED', 403, false, requestId);
    }
  }

  return new Response(null, {
    status: 204,
    headers: { 'Cache-Control': 'no-store' }
  });
}
