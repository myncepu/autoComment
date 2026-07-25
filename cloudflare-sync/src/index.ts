import {
  allowedOrigin,
  allowedMethods,
  apiError,
  hasForbiddenOrigin,
  HttpError,
  preflight,
  withCors
} from './http';
import { requireVault } from './auth';
import { pushMutations } from './push';
import { bootstrapSnapshot, pullChanges } from './pull';
import { deleteVault, getStatus, putVault } from './vault';

function pushPreflight(
  request: Request,
  env: Env,
  requestId: string
): Response {
  if (!allowedOrigin(request, env)) {
    return apiError('CORS_ORIGIN_FORBIDDEN', 403, false, requestId);
  }
  if (
    request.headers.get('Access-Control-Request-Method') !== 'POST'
  ) {
    const response = apiError(
      'METHOD_NOT_ALLOWED',
      405,
      false,
      requestId
    );
    response.headers.set('Allow', 'POST, OPTIONS');
    return response;
  }

  const requestedHeaders = request.headers.get(
    'Access-Control-Request-Headers'
  );
  if (requestedHeaders) {
    const supported = new Set(['authorization', 'content-type']);
    const valid = requestedHeaders
      .split(',')
      .map((header) => header.trim().toLowerCase())
      .every((header) => supported.has(header));
    if (!valid) {
      return apiError('CORS_HEADER_NOT_ALLOWED', 403, false, requestId);
    }
  }

  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Cache-Control': 'no-store'
    }
  });
}

function readPreflight(
  request: Request,
  env: Env,
  requestId: string
): Response {
  if (!allowedOrigin(request, env)) {
    return apiError('CORS_ORIGIN_FORBIDDEN', 403, false, requestId);
  }
  if (
    request.headers.get('Access-Control-Request-Method') !== 'GET'
  ) {
    const response = apiError(
      'METHOD_NOT_ALLOWED',
      405,
      false,
      requestId
    );
    response.headers.set('Allow', 'GET, OPTIONS');
    return response;
  }
  const requestedHeaders = request.headers.get(
    'Access-Control-Request-Headers'
  );
  if (requestedHeaders) {
    const supported = new Set(['authorization', 'content-type']);
    const valid = requestedHeaders
      .split(',')
      .map((header) => header.trim().toLowerCase())
      .every((header) => supported.has(header));
    if (!valid) {
      return apiError('CORS_HEADER_NOT_ALLOWED', 403, false, requestId);
    }
  }
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Cache-Control': 'no-store'
    }
  });
}

function methodNotAllowed(pathname: string, requestId: string): Response {
  const response = apiError(
    'METHOD_NOT_ALLOWED',
    405,
    false,
    requestId
  );
  const methods = allowedMethods(pathname);
  if (methods) response.headers.set('Allow', methods);
  return response;
}

async function route(
  request: Request,
  env: Env,
  requestId: string
): Promise<Response> {
  const pathname = new URL(request.url).pathname;

  if (request.method === 'OPTIONS') {
    if (pathname === '/v1/sync/push') {
      return pushPreflight(request, env, requestId);
    }
    if (
      pathname === '/v1/sync/pull' ||
      pathname === '/v1/sync/bootstrap'
    ) {
      return readPreflight(request, env, requestId);
    }
    return preflight(request, env, requestId);
  }

  if (pathname === '/v1/vault') {
    if (request.method === 'PUT') {
      return putVault(request, env, requestId);
    }
    if (request.method === 'DELETE') {
      return deleteVault(request, env, requestId);
    }
    return methodNotAllowed(pathname, requestId);
  }

  if (pathname === '/v1/status') {
    if (request.method === 'GET') {
      return getStatus(request, env, requestId);
    }
    return methodNotAllowed(pathname, requestId);
  }

  if (pathname === '/v1/sync/push') {
    if (request.method === 'POST') {
      const vault = await requireVault(request, env);
      return pushMutations(request, env, vault, requestId);
    }
    const response = apiError(
      'METHOD_NOT_ALLOWED',
      405,
      false,
      requestId
    );
    response.headers.set('Allow', 'POST, OPTIONS');
    return response;
  }

  if (pathname === '/v1/sync/pull') {
    if (request.method === 'GET') {
      const vault = await requireVault(request, env);
      return pullChanges(request, env, vault, requestId);
    }
    const response = apiError(
      'METHOD_NOT_ALLOWED',
      405,
      false,
      requestId
    );
    response.headers.set('Allow', 'GET, OPTIONS');
    return response;
  }

  if (pathname === '/v1/sync/bootstrap') {
    if (request.method === 'GET') {
      const vault = await requireVault(request, env);
      return bootstrapSnapshot(request, env, vault, requestId);
    }
    const response = apiError(
      'METHOD_NOT_ALLOWED',
      405,
      false,
      requestId
    );
    response.headers.set('Allow', 'GET, OPTIONS');
    return response;
  }

  return apiError('NOT_FOUND', 404, false, requestId);
}

export default {
  async fetch(request, env): Promise<Response> {
    const requestId = crypto.randomUUID();
    let response: Response;

    try {
      response = hasForbiddenOrigin(request, env)
        ? apiError('CORS_ORIGIN_FORBIDDEN', 403, false, requestId)
        : await route(request, env, requestId);
    } catch (error) {
      response =
        error instanceof HttpError
          ? apiError(
              error.code,
              error.status,
              error.retryable,
              requestId
            )
          : apiError('INTERNAL_ERROR', 500, true, requestId);
    }

    return withCors(request, response, env);
  }
} satisfies ExportedHandler<Env>;
