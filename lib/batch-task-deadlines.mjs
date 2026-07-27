function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function identityKey(identity) {
  if (
    typeof identity?.batchId !== 'string' ||
    identity.batchId.length === 0 ||
    !Number.isInteger(identity.urlIndex) ||
    identity.urlIndex < 0 ||
    !Number.isInteger(identity.attempt) ||
    identity.attempt < 1
  ) {
    throw codedError('invalid_task_deadline_identity');
  }
  return `${identity.batchId}:${identity.urlIndex}:${identity.attempt}`;
}

export function createBatchTaskDeadlines({
  timers = globalThis,
  now = Date.now,
  onExpire
} = {}) {
  if (
    typeof timers?.setTimeout !== 'function' ||
    typeof timers?.clearTimeout !== 'function' ||
    typeof now !== 'function' ||
    typeof onExpire !== 'function'
  ) {
    throw codedError('invalid_task_deadline_dependencies');
  }
  const entries = new Map();

  function clear(identity) {
    const key = identityKey(identity);
    const entry = entries.get(key);
    if (!entry) return false;
    entries.delete(key);
    timers.clearTimeout(entry.timerId);
    return true;
  }

  function arm(identity, startedAt, timeoutMs) {
    const key = identityKey(identity);
    if (
      !Number.isFinite(startedAt) ||
      startedAt < 0 ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0
    ) {
      throw codedError('invalid_task_deadline');
    }
    const previous = entries.get(key);
    if (previous) timers.clearTimeout(previous.timerId);

    const task = structuredClone(identity);
    const token = {};
    const delay = Math.max(0, startedAt + timeoutMs - now());
    const timerId = timers.setTimeout(() => {
      const current = entries.get(key);
      if (current?.token !== token) return;
      entries.delete(key);
      Promise.resolve(onExpire(structuredClone(task))).catch(() => {});
    }, delay);
    timerId?.unref?.();
    entries.set(key, { timerId, token });
    return delay;
  }

  function clearAll() {
    for (const entry of entries.values()) {
      timers.clearTimeout(entry.timerId);
    }
    entries.clear();
  }

  return Object.freeze({
    arm,
    clear,
    clearAll,
    has(identity) {
      return entries.has(identityKey(identity));
    },
    get size() {
      return entries.size;
    }
  });
}
