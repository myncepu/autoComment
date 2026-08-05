function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function canonicalSuccessHost(value) {
  const raw = text(value).toLowerCase();
  if (!raw) return '';
  try {
    const parsed = new URL(raw.includes('://') ? raw : `https://${raw}`);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return parsed.hostname.toLowerCase().replace(/^www\./, '');
  } catch (_) {
    return '';
  }
}

export function canonicalSuccessUrl(value) {
  const raw = text(value);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    parsed.hash = '';
    return parsed.href;
  } catch (_) {
    return '';
  }
}

function normalizePromotion(value = {}) {
  return {
    promotionSiteId: text(value.promotionSiteId),
    promotedDomain: canonicalSuccessHost(value.promotedDomain),
    successCount: Number.isInteger(value.successCount)
      ? Math.max(0, value.successCount)
      : 0,
    lastSuccessAt: Number.isFinite(value.lastSuccessAt)
      ? value.lastSuccessAt
      : null
  };
}

export function normalizeOutlinkSuccessStats(stats) {
  const byHost = new Map();
  for (const raw of Array.isArray(stats) ? stats : []) {
    const targetHost = canonicalSuccessHost(raw?.targetHost || raw?.targetDomain);
    if (!targetHost) continue;
    const promotions = (Array.isArray(raw?.promotions) ? raw.promotions : [])
      .map(normalizePromotion)
      .filter(({ promotionSiteId, promotedDomain }) => (
        promotionSiteId || promotedDomain
      ));
    byHost.set(targetHost, {
      targetHost,
      successCount: Number.isInteger(raw?.successCount)
        ? Math.max(0, raw.successCount)
        : promotions.reduce((total, item) => total + item.successCount, 0),
      lastSuccessAt: Number.isFinite(raw?.lastSuccessAt)
        ? raw.lastSuccessAt
        : promotions.reduce((latest, item) => (
            Number.isFinite(item.lastSuccessAt)
              ? Math.max(latest || 0, item.lastSuccessAt)
              : latest
          ), null),
      promotions,
      pairs: (Array.isArray(raw?.pairs) ? raw.pairs : []).flatMap((pair) => {
        const targetPageUrl = canonicalSuccessUrl(pair?.targetPageUrl);
        const promotedWebsiteUrl = canonicalSuccessUrl(pair?.promotedWebsiteUrl);
        return targetPageUrl && promotedWebsiteUrl
          ? [{ targetPageUrl, promotedWebsiteUrl }]
          : [];
      })
    });
  }
  return [...byHost.values()];
}

export function summarizeSuccessfulComments(comments) {
  const domains = new Map();
  for (const comment of Array.isArray(comments) ? comments : []) {
    const targetHost = canonicalSuccessHost(
      comment?.targetDomain || comment?.targetPageUrl
    );
    if (!targetHost) continue;
    const submittedAt = Number.isFinite(comment?.submittedAt)
      ? comment.submittedAt
      : null;
    let domain = domains.get(targetHost);
    if (!domain) {
      domain = {
        targetHost,
        successCount: 0,
        lastSuccessAt: null,
        promotions: new Map(),
        pairs: new Map()
      };
      domains.set(targetHost, domain);
    }
    domain.successCount += 1;
    if (submittedAt !== null) {
      domain.lastSuccessAt = Math.max(domain.lastSuccessAt || 0, submittedAt);
    }
    const promotionSiteId = text(comment?.promotionSiteId);
    const targetPageUrl = canonicalSuccessUrl(comment?.targetPageUrl);
    const promotedWebsiteUrl = canonicalSuccessUrl(comment?.promotedWebsiteUrl);
    if (targetPageUrl && promotedWebsiteUrl) {
      domain.pairs.set(
        `${targetPageUrl}\0${promotedWebsiteUrl}`,
        { targetPageUrl, promotedWebsiteUrl }
      );
    }
    const promotedDomain = canonicalSuccessHost(
      comment?.promotedDomain || comment?.promotedWebsiteUrl
    );
    if (!promotionSiteId && !promotedDomain) continue;
    const key = `${promotionSiteId}\0${promotedDomain}`;
    const promotion = domain.promotions.get(key) || {
      promotionSiteId,
      promotedDomain,
      successCount: 0,
      lastSuccessAt: null
    };
    promotion.successCount += 1;
    if (submittedAt !== null) {
      promotion.lastSuccessAt = Math.max(
        promotion.lastSuccessAt || 0,
        submittedAt
      );
    }
    domain.promotions.set(key, promotion);
  }
  return [...domains.values()]
    .map((domain) => ({
      targetHost: domain.targetHost,
      successCount: domain.successCount,
      lastSuccessAt: domain.lastSuccessAt,
      promotions: [...domain.promotions.values()].sort((left, right) => (
        (right.lastSuccessAt || 0) - (left.lastSuccessAt || 0)
      )),
      pairs: [...domain.pairs.values()]
    }))
    .sort((left, right) => (
      right.successCount - left.successCount
      || (right.lastSuccessAt || 0) - (left.lastSuccessAt || 0)
      || left.targetHost.localeCompare(right.targetHost)
    ));
}

export function exactPromotionAlreadySucceeded(stat, targetPageUrl, promotionPageUrl) {
  if (!stat) return false;
  const target = canonicalSuccessUrl(targetPageUrl);
  const promotion = canonicalSuccessUrl(promotionPageUrl);
  if (!target || !promotion) return false;
  return (stat.pairs || []).some((pair) => (
    pair.targetPageUrl === target && pair.promotedWebsiteUrl === promotion
  ));
}

export function successStatsMap(stats) {
  return new Map(
    normalizeOutlinkSuccessStats(stats).map((item) => [item.targetHost, item])
  );
}

export function promotionAlreadySucceeded(stat, promotionSite) {
  if (!stat) return false;
  const promotionSiteId = text(promotionSite?.id || promotionSite?.promotionSiteId);
  const promotedDomain = canonicalSuccessHost(
    promotionSite?.url || promotionSite?.promotedDomain
  );
  return stat.promotions.some((promotion) => (
    (promotionSiteId && promotion.promotionSiteId === promotionSiteId)
    || (promotedDomain && promotion.promotedDomain === promotedDomain)
  ));
}

export function annotateOutlinkRecords(records, stats) {
  const byHost = successStatsMap(stats);
  return (Array.isArray(records) ? records : []).map((record) => {
    const stat = byHost.get(canonicalSuccessHost(record?.host || record?.url));
    return {
      ...record,
      successCount: stat?.successCount || 0,
      lastSuccessAt: stat?.lastSuccessAt || null,
      successfulPromotionSiteIds: stat
        ? [...new Set(stat.promotions.map((item) => item.promotionSiteId).filter(Boolean))]
        : [],
      successfulPromotedDomains: stat
        ? [...new Set(stat.promotions.map((item) => item.promotedDomain).filter(Boolean))]
        : []
    };
  });
}

export function compareOutlinksBySuccess(left, right) {
  return (Number(right?.successCount) || 0) - (Number(left?.successCount) || 0)
    || (Number(right?.lastSuccessAt) || 0) - (Number(left?.lastSuccessAt) || 0);
}
