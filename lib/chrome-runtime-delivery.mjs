const BENIGN_RUNTIME_DELIVERY_PATTERNS = Object.freeze([
  'receiving end does not exist',
  'message channel closed',
  'message port closed'
]);

export function isBenignRuntimeDeliveryError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return BENIGN_RUNTIME_DELIVERY_PATTERNS.some((pattern) => (
    message.includes(pattern)
  ));
}
