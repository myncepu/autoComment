export function createDefaultBatchAssignment(settings = {}) {
  const websiteUrl = String(settings.websiteUrl || '').trim();
  const websiteContent = String(settings.websiteContent || '').trim();
  let label = websiteUrl;
  try {
    label = new URL(websiteUrl).hostname;
  } catch (_) {
    label = websiteUrl;
  }
  return {
    identityId: 'default-identity',
    promotionSiteId: 'default-promotion-site',
    identitySnapshot: {
      displayName: String(settings.userName || '').trim(),
      email: String(settings.userEmail || '').trim()
    },
    promotionSiteSnapshot: {
      label,
      url: websiteUrl,
      contentSummary: websiteContent.slice(0, 160)
    }
  };
}
