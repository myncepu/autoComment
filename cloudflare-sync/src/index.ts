import {
  allowedMethods,
  apiError,
  hasForbiddenOrigin,
  HttpError,
  preflight,
  withCors
} from './http';
import { deleteVault, getStatus, putVault } from './vault';

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
