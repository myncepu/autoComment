import { fail } from './http';

function jsonContentType(request: Request): boolean {
  const contentType = request.headers.get('Content-Type');
  return (
    contentType !== null &&
    contentType.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
  );
}

async function readBoundedBytes(
  request: Request,
  maximumBytes: number
): Promise<Uint8Array> {
  const contentLength = request.headers.get('Content-Length');
  if (contentLength !== null) {
    if (!/^\d+$/u.test(contentLength)) fail('INVALID_REQUEST', 400);
    if (Number(contentLength) > maximumBytes) fail('PAYLOAD_TOO_LARGE', 413);
  }

  if (!request.body) fail('INVALID_JSON', 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const result = await reader.read();
    if (result.done) break;
    totalBytes += result.value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel();
      fail('PAYLOAD_TOO_LARGE', 413);
    }
    chunks.push(result.value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readBoundedJson(
  request: Request,
  maximumBytes: number
): Promise<unknown> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    fail('INTERNAL_ERROR', 500, true);
  }
  if (!jsonContentType(request)) fail('UNSUPPORTED_MEDIA_TYPE', 415);

  const bytes = await readBoundedBytes(request, maximumBytes);
  try {
    const text = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: false
    }).decode(bytes);
    return JSON.parse(text);
  } catch {
    fail('INVALID_JSON', 400);
  }
}

export function isJsonObject(
  value: unknown
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requireJsonObject(
  value: unknown,
  allowedKeys: readonly string[],
  code = 'INVALID_REQUEST'
): Record<string, unknown> {
  if (!isJsonObject(value)) fail(code, 400);
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) fail(code, 400);
  return value;
}

export function boundedString(
  value: unknown,
  minimumLength: number,
  maximumLength: number,
  code = 'INVALID_REQUEST'
): string {
  if (
    typeof value !== 'string' ||
    value.length < minimumLength ||
    value.length > maximumLength ||
    value.trim() !== value
  ) {
    fail(code, 400);
  }
  return value;
}

export function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  code = 'INVALID_REQUEST'
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    fail(code, 400);
  }
  return value;
}

export function rejectUnknownQuery(
  url: URL,
  allowedNames: readonly string[],
  code = 'INVALID_REQUEST'
): void {
  const allowed = new Set(allowedNames);
  for (const name of url.searchParams.keys()) {
    if (!allowed.has(name)) fail(code, 400);
  }
}

export function boundedQueryString(
  url: URL,
  name: string,
  minimumLength: number,
  maximumLength: number,
  code = 'INVALID_REQUEST'
): string {
  const values = url.searchParams.getAll(name);
  if (values.length !== 1) fail(code, 400);
  return boundedString(
    values[0],
    minimumLength,
    maximumLength,
    code
  );
}

export function boundedQueryInteger(
  url: URL,
  name: string,
  minimum: number,
  maximum: number,
  code = 'INVALID_REQUEST'
): number {
  const values = url.searchParams.getAll(name);
  if (values.length !== 1 || !/^(?:0|[1-9]\d*)$/u.test(values[0] ?? '')) {
    fail(code, 400);
  }
  return boundedInteger(Number(values[0]), minimum, maximum, code);
}
