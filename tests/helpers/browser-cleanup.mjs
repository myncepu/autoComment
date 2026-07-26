export async function closeBrowserContextWithin(
  context,
  timeoutMs = 10_000
) {
  if (typeof context?.close !== 'function') return 'not_started';
  let timeoutId;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => context.close())
        .then(() => 'closed', () => 'failed'),
      new Promise((resolve) => {
        timeoutId = setTimeout(() => resolve('timeout'), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

