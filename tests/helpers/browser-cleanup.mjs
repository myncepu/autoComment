async function settleWithin(promise, timeoutMs) {
  let timeoutId;
  try {
    return await Promise.race([
      Promise.resolve(promise).then(
        () => 'closed',
        () => 'failed'
      ),
      new Promise((resolve) => {
        timeoutId = setTimeout(() => resolve('timeout'), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function closeBrowserContextWithin(context, {
  contextTimeoutMs = 10_000,
  browserTimeoutMs = 5_000
} = {}) {
  if (typeof context?.close !== 'function') return 'not_started';
  const contextOutcome = await settleWithin(
    Promise.resolve().then(() => context.close()),
    contextTimeoutMs
  );
  if (contextOutcome === 'closed') return 'closed';

  const browser = typeof context.browser === 'function'
    ? context.browser()
    : null;
  if (typeof browser?.close !== 'function') return contextOutcome;
  const browserOutcome = await settleWithin(
    Promise.resolve().then(() => browser.close()),
    browserTimeoutMs
  );
  if (browserOutcome === 'closed') return 'forced_closed';
  if (
    contextOutcome === 'timeout' ||
    browserOutcome === 'timeout'
  ) {
    return 'timeout';
  }
  return 'failed';
}

export function finalizeAcceptanceResult(result, browserCleanup) {
  if (['closed', 'forced_closed'].includes(browserCleanup)) {
    return { ...result, ok: true, browserCleanup };
  }
  return {
    ...result,
    ok: false,
    browserCleanup,
    error: browserCleanup === 'timeout'
      ? 'browser_cleanup_timeout'
      : 'browser_cleanup_failed'
  };
}
