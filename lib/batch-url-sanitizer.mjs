const SENSITIVE_KEYS = new Set([
  'token',
  'accesstoken',
  'refreshtoken',
  'apikey',
  'key',
  'password',
  'passwd',
  'secret',
  'auth',
  'authorization'
]);

function normalizedKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSensitiveKey(value) {
  return SENSITIVE_KEYS.has(normalizedKey(value));
}

function redactParams(params) {
  for (const key of [...params.keys()]) {
    if (isSensitiveKey(key)) params.set(key, 'REDACTED');
  }
}

export function hasUrlCredentials(value) {
  try {
    const url = new URL(String(value || ''));
    return url.username.length > 0 || url.password.length > 0;
  } catch (_) {
    return false;
  }
}

export function sanitizeBatchUrl(value) {
  const raw = String(value || '');
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    redactParams(url.searchParams);
    if (url.hash.includes('=')) {
      const hashParams = new URLSearchParams(url.hash.slice(1));
      redactParams(hashParams);
      url.hash = hashParams.toString();
    }
    return url.href;
  } catch (_) {
    return sanitizeDiagnosticText(raw);
  }
}

export function sanitizeDiagnosticText(value) {
  let text = String(value || '');
  text = text.replace(/https?:\/\/[^\s"'<>]+/gi, (candidate) => {
    try {
      return sanitizeBatchUrl(candidate);
    } catch (_) {
      return candidate.replace(
        /^(https?:\/\/)[^/@\s]+@/i,
        '$1'
      );
    }
  });
  return text.replace(
    /\b(token|access[_-]?token|refresh[_-]?token|api[_-]?key|key|password|passwd|secret|auth|authorization)\s*([=:])\s*([^\s;&]+)/gi,
    (_match, key, separator) => `${key}${separator}REDACTED`
  );
}
