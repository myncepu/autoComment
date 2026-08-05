import {
  DEFAULT_QUOTAS,
  assertNoSensitiveFields,
  validateDomainConfig
} from './domain-config-schema.mjs';
import {
  canonicalSuccessHost,
  exactPromotionAlreadySucceeded,
  promotionAlreadySucceeded,
  successStatsMap
} from './outlink-success-stats.mjs';

export const BATCH_PLAN_VERSION = 2;
export const BATCH_SKIP_REASONS = Object.freeze({
  INVALID_TARGET_URL: 'invalid_target_url',
  INVALID_SOURCE_DOMAIN: 'invalid_source_domain',
  BLOCKED_ILLEGAL: 'blocked_illegal',
  DUPLICATE_IN_BATCH: 'duplicate_in_batch',
  RECENT_SUCCESS: 'recent_success',
  PROMOTION_ALREADY_SUCCEEDED: 'promotion_site_already_succeeded_on_target',
  ALL_PROMOTIONS_ALREADY_SUCCEEDED: 'all_promotion_sites_already_succeeded_on_target',
  QUOTA_TARGET_DOMAIN: 'quota_target_domain',
  QUOTA_PROFILE: 'quota_profile',
  QUOTA_PROMOTION_SITE: 'quota_promotion_site',
  QUOTA_BATCH: 'quota_batch'
});

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function validatedConfig(config) {
  const validation = validateDomainConfig(config);
  if (!validation.ok) throw codedError(validation.error);
  return validation.value;
}

export function canonicalizeBatchTargetUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw codedError('invalid_target_url');
  }
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw codedError('invalid_target_url');
    }
    url.hash = '';
    return url.href;
  } catch (error) {
    if (error?.code === 'invalid_target_url') throw error;
    throw codedError('invalid_target_url');
  }
}

function normalizeSourceDomain(value, fallback) {
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  const raw = value.trim();
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    if (!['http:', 'https:'].includes(url.protocol)
        || url.username
        || url.password
        || (url.pathname !== '/' && url.pathname !== '')
        || url.search
        || url.hash) {
      throw new Error();
    }
    return url.hostname.toLocaleLowerCase();
  } catch {
    throw codedError('invalid_source_domain');
  }
}

function canonicalSet(values, errorCode) {
  if (!(Array.isArray(values) || values instanceof Set)) {
    throw codedError(errorCode);
  }
  const result = new Set();
  for (const value of values) {
    try {
      result.add(canonicalizeBatchTargetUrl(value));
    } catch {
      throw codedError(errorCode);
    }
  }
  return result;
}

function compareWeighted(left, right) {
  if (left.proposedCurrent !== right.proposedCurrent) {
    return right.proposedCurrent - left.proposedCurrent;
  }
  return left.id.localeCompare(right.id);
}

function proposedPairStates(weightStates) {
  return weightStates.map((state) => ({
    ...state,
    proposedCurrent: state.current + state.weight
  }));
}

function quotaReason(pair, counts, quotas) {
  if ((counts.profiles.get(pair.profileId) || 0) >= quotas.perProfile) {
    return BATCH_SKIP_REASONS.QUOTA_PROFILE;
  }
  if ((counts.sites.get(pair.promotionSiteId) || 0) >= quotas.perPromotionSite) {
    return BATCH_SKIP_REASONS.QUOTA_PROMOTION_SITE;
  }
  return null;
}

function increment(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function selectWeightedPair(
  weightStates,
  counts,
  quotas,
  unavailablePromotionSiteIds = new Set()
) {
  const proposed = proposedPairStates(weightStates).sort(compareWeighted);
  const available = proposed.filter(
    (pair) => !unavailablePromotionSiteIds.has(pair.promotionSiteId)
  );
  if (available.length === 0) {
    return {
      pair: proposed[0],
      blockReason: BATCH_SKIP_REASONS.ALL_PROMOTIONS_ALREADY_SUCCEEDED,
      changedWeights: false
    };
  }
  const selected = available.find((pair) => !quotaReason(pair, counts, quotas));
  if (!selected) {
    const intended = available[0];
    return {
      pair: intended,
      blockReason: quotaReason(intended, counts, quotas),
      changedWeights: false
    };
  }

  const totalWeight = weightStates.reduce((total, pair) => total + pair.weight, 0);
  for (const state of weightStates) {
    const proposal = proposed.find(({ id }) => id === state.id);
    state.current = proposal.proposedCurrent;
    if (state.id === selected.id) state.current -= totalWeight;
  }
  return {
    pair: selected,
    blockReason: null,
    changedWeights: true
  };
}

function defaultPair(config) {
  return config.assignmentPolicy.pairs.find(
    ({ id }) => id === config.assignmentPolicy.defaultPairId
  );
}

function explicitPair(row, config, sitesById) {
  if (row.assignmentSource !== 'explicit') return null;
  const pair = config.assignmentPolicy.pairs.find(
    ({ id }) => id === row.assignmentPairId
  );
  if (!pair?.enabled
      || row.profileId !== pair.profileId
      || row.promotionSiteId !== pair.promotionSiteId
      || !sitesById.get(pair.promotionSiteId)?.enabled) {
    throw codedError('invalid_explicit_assignment');
  }
  return pair;
}

function taskAssignment(pair, source) {
  return {
    profileId: pair.profileId,
    promotionSiteId: pair.promotionSiteId,
    assignmentPairId: pair.id,
    assignmentSource: source
  };
}

function makeTask({
  planId,
  row,
  index,
  targetUrl,
  canonicalTargetUrl,
  targetDomain,
  sourceDomain,
  pair,
  assignmentSource,
  blockReason,
  recentSuccessOverride
}) {
  return {
    taskId: `${planId}:${row.rowNumber}`,
    urlIndex: index,
    rowNumber: row.rowNumber,
    targetUrl,
    canonicalTargetUrl,
    targetDomain,
    sourceDomain,
    ...taskAssignment(pair, assignmentSource),
    state: blockReason ? 'blocked' : 'eligible',
    blockReason: blockReason || null,
    recentSuccessOverride: Boolean(recentSuccessOverride)
  };
}

function evaluateIllegal(evaluator, targetUrl, sourceDomain) {
  let result;
  try {
    result = evaluator(targetUrl, { sourceDomain });
  } catch {
    throw codedError('illegal_filter_unavailable');
  }
  if (!result || typeof result.blocked !== 'boolean') {
    throw codedError('illegal_filter_unavailable');
  }
  return result.blocked;
}

export function compileBatchPlan({
  planId,
  createdAt,
  config,
  rows,
  recentSuccessUrls = [],
  successfulTargetStats = [],
  selectedProfileIds = null,
  selectedPromotionPageIds = null,
  repeatOverrides = [],
  illegalSiteEvaluator,
  illegalSiteRulesVersion = null
}) {
  if (typeof planId !== 'string' || planId.trim() === ''
      || !Number.isInteger(createdAt) || createdAt < 0
      || !Array.isArray(rows)) {
    throw codedError('invalid_batch_plan_input');
  }
  if (typeof illegalSiteEvaluator !== 'function') {
    throw codedError('illegal_filter_unavailable');
  }

  const normalizedConfig = validatedConfig(config);
  const recentSet = canonicalSet(
    recentSuccessUrls,
    'recent_success_history_unavailable'
  );
  const overrideSet = canonicalSet(repeatOverrides, 'repeat_override_invalid');
  const successfulTargets = successStatsMap(successfulTargetStats);
  const modernMode = normalizedConfig.promotionSites.some(
    (site) => Array.isArray(site.pages)
  );
  const selectedProfiles = new Set(
    Array.isArray(selectedProfileIds)
      ? selectedProfileIds
      : normalizedConfig.profiles.map(({ id }) => id)
  );
  const selectedPages = new Set(
    Array.isArray(selectedPromotionPageIds)
      ? selectedPromotionPageIds
      : normalizedConfig.promotionSites.flatMap(
          (site) => (site.pages || []).map(({ id }) => id)
        )
  );
  const modernProfiles = normalizedConfig.profiles.filter(
    ({ id }) => selectedProfiles.has(id)
  );
  const modernPromotionPages = normalizedConfig.promotionSites.flatMap((site) => (
    (site.enabled && Array.isArray(site.pages) ? site.pages : [])
      .filter((page) => page.enabled && selectedPages.has(page.id))
      .map((page) => ({
        id: page.id,
        name: `${site.name} · ${page.keywords[0] || page.url}`,
        url: page.url,
        content: page.content,
        email: site.email,
        parentSiteId: site.id
      }))
  ));
  const sitesById = new Map((modernMode
    ? modernPromotionPages
    : normalizedConfig.promotionSites
  ).map((site) => [site.id, site]));
  const approvedPairs = modernMode
    ? modernProfiles.flatMap((profile) => modernPromotionPages.map((page) => ({
        id: `round-robin:${profile.id}:${page.id}`,
        profileId: profile.id,
        promotionSiteId: page.id,
        weight: 1,
        enabled: true
      })))
    : normalizedConfig.assignmentPolicy.pairs.filter((pair) => (
        pair.enabled && sitesById.get(pair.promotionSiteId)?.enabled
      ));
  if (approvedPairs.length === 0) throw codedError('no_enabled_assignment_pairs');
  const fallbackPair = modernMode ? approvedPairs[0] : defaultPair(normalizedConfig);
  const weightStates = approvedPairs.map((pair) => ({
    ...pair,
    current: 0
  }));
  const counts = {
    batch: 0,
    domains: new Map(),
    profiles: new Map(),
    sites: new Map()
  };
  const seen = new Set();
  let modernProfileCursor = 0;
  let modernPageCursor = 0;

  function selectModernPair(targetSuccessStat, targetUrl) {
    const quotas = normalizedConfig.assignmentPolicy.quotas;
    const availableProfiles = modernProfiles.filter((profile) => (
      (counts.profiles.get(profile.id) || 0) < quotas.perProfile
    ));
    if (availableProfiles.length === 0) {
      return {
        pair: fallbackPair,
        blockReason: BATCH_SKIP_REASONS.QUOTA_PROFILE
      };
    }
    let page = null;
    let quotaBlocked = false;
    for (let offset = 0; offset < modernPromotionPages.length; offset += 1) {
      const candidate = modernPromotionPages[
        (modernPageCursor + offset) % modernPromotionPages.length
      ];
      if (exactPromotionAlreadySucceeded(
        targetSuccessStat,
        targetUrl,
        candidate.url
      )) continue;
      if ((counts.sites.get(candidate.id) || 0) >= quotas.perPromotionSite) {
        quotaBlocked = true;
        continue;
      }
      page = candidate;
      modernPageCursor = (
        modernPromotionPages.indexOf(candidate) + 1
      ) % modernPromotionPages.length;
      break;
    }
    if (!page) {
      return {
        pair: fallbackPair,
        blockReason: quotaBlocked
          ? BATCH_SKIP_REASONS.QUOTA_PROMOTION_SITE
          : BATCH_SKIP_REASONS.ALL_PROMOTIONS_ALREADY_SUCCEEDED
      };
    }
    const profile = availableProfiles[
      modernProfileCursor % availableProfiles.length
    ];
    modernProfileCursor = (modernProfileCursor + 1) % modernProfiles.length;
    return {
      pair: {
        id: `round-robin:${profile.id}:${page.id}`,
        profileId: profile.id,
        promotionSiteId: page.id
      },
      blockReason: null
    };
  }

  const prioritizedRows = rows.map((row, inputIndex) => {
    const stat = successfulTargets.get(canonicalSuccessHost(row?.targetUrlRaw));
    return { row, inputIndex, stat };
  }).sort((left, right) => (
    (right.stat?.successCount || 0) - (left.stat?.successCount || 0)
    || (right.stat?.lastSuccessAt || 0) - (left.stat?.lastSuccessAt || 0)
    || left.inputIndex - right.inputIndex
  ));

  const tasks = prioritizedRows.map(({ row }, index) => {
    const assignedPair = modernMode
      ? null
      : explicitPair(row, normalizedConfig, sitesById);
    let canonicalTargetUrl = '';
    let targetDomain = '';
    let sourceDomain = '';
    let blockReason = null;
    let recentSuccessOverride = false;
    let targetSuccessStat = null;

    try {
      canonicalTargetUrl = canonicalizeBatchTargetUrl(row.targetUrlRaw);
      targetDomain = new URL(canonicalTargetUrl).hostname;
      targetSuccessStat = successfulTargets.get(
        canonicalSuccessHost(targetDomain)
      ) || null;
    } catch {
      blockReason = BATCH_SKIP_REASONS.INVALID_TARGET_URL;
    }
    if (!blockReason) {
      try {
        sourceDomain = normalizeSourceDomain(row.sourceDomainRaw, targetDomain);
      } catch {
        blockReason = BATCH_SKIP_REASONS.INVALID_SOURCE_DOMAIN;
      }
    }
    if (!blockReason
        && evaluateIllegal(illegalSiteEvaluator, canonicalTargetUrl, sourceDomain)) {
      blockReason = BATCH_SKIP_REASONS.BLOCKED_ILLEGAL;
    }
    if (!blockReason) {
      if (seen.has(canonicalTargetUrl)) {
        blockReason = BATCH_SKIP_REASONS.DUPLICATE_IN_BATCH;
      } else {
        seen.add(canonicalTargetUrl);
      }
    } else if (canonicalTargetUrl) {
      seen.add(canonicalTargetUrl);
    }
    if (!modernMode && !blockReason && recentSet.has(canonicalTargetUrl)) {
      if (overrideSet.has(canonicalTargetUrl)) {
        recentSuccessOverride = true;
      } else {
        blockReason = BATCH_SKIP_REASONS.RECENT_SUCCESS;
      }
    }
    if (!blockReason) {
      if (counts.batch >= normalizedConfig.assignmentPolicy.quotas.batch) {
        blockReason = BATCH_SKIP_REASONS.QUOTA_BATCH;
      } else if ((counts.domains.get(targetDomain) || 0)
          >= normalizedConfig.assignmentPolicy.quotas.perTargetDomain) {
        blockReason = BATCH_SKIP_REASONS.QUOTA_TARGET_DOMAIN;
      }
    }

    if (blockReason) {
      return makeTask({
        planId,
        row,
        index,
        targetUrl: canonicalTargetUrl || String(row.targetUrlRaw || '').trim(),
        canonicalTargetUrl,
        targetDomain,
        sourceDomain,
        pair: assignedPair || fallbackPair,
        assignmentSource: assignedPair ? 'explicit' : 'default_blocked',
        blockReason,
        recentSuccessOverride
      });
    }

    if (modernMode) {
      const selection = selectModernPair(targetSuccessStat, canonicalTargetUrl);
      if (!selection.blockReason) {
        counts.batch += 1;
        increment(counts.domains, targetDomain);
        increment(counts.profiles, selection.pair.profileId);
        increment(counts.sites, selection.pair.promotionSiteId);
      }
      return makeTask({
        planId,
        row,
        index,
        targetUrl: canonicalTargetUrl,
        canonicalTargetUrl,
        targetDomain,
        sourceDomain,
        pair: selection.pair,
        assignmentSource: 'round_robin',
        blockReason: selection.blockReason,
        recentSuccessOverride
      });
    }

    if (assignedPair) {
      const assignmentBlock = promotionAlreadySucceeded(
        targetSuccessStat,
        sitesById.get(assignedPair.promotionSiteId)
      )
        ? BATCH_SKIP_REASONS.PROMOTION_ALREADY_SUCCEEDED
        : quotaReason(
            assignedPair,
            counts,
            normalizedConfig.assignmentPolicy.quotas
          );
      if (!assignmentBlock) {
        counts.batch += 1;
        increment(counts.domains, targetDomain);
        increment(counts.profiles, assignedPair.profileId);
        increment(counts.sites, assignedPair.promotionSiteId);
      }
      return makeTask({
        planId,
        row,
        index,
        targetUrl: canonicalTargetUrl,
        canonicalTargetUrl,
        targetDomain,
        sourceDomain,
        pair: assignedPair,
        assignmentSource: 'explicit',
        blockReason: assignmentBlock,
        recentSuccessOverride
      });
    }

    const unavailablePromotionSiteIds = new Set(
      approvedPairs
        .filter((pair) => promotionAlreadySucceeded(
          targetSuccessStat,
          sitesById.get(pair.promotionSiteId)
        ))
        .map((pair) => pair.promotionSiteId)
    );
    const selection = selectWeightedPair(
      weightStates,
      counts,
      normalizedConfig.assignmentPolicy.quotas,
      unavailablePromotionSiteIds
    );
    if (!selection.blockReason) {
      counts.batch += 1;
      increment(counts.domains, targetDomain);
      increment(counts.profiles, selection.pair.profileId);
      increment(counts.sites, selection.pair.promotionSiteId);
    }
    return makeTask({
      planId,
      row,
      index,
      targetUrl: canonicalTargetUrl,
      canonicalTargetUrl,
      targetDomain,
      sourceDomain,
      pair: selection.pair,
      assignmentSource: 'weighted',
      blockReason: selection.blockReason,
      recentSuccessOverride
    });
  });

  const referencedProfileIds = new Set(tasks.map(({ profileId }) => profileId));
  const referencedSiteIds = new Set(tasks.map(({ promotionSiteId }) => promotionSiteId));
  const profiles = Object.fromEntries(normalizedConfig.profiles
    .filter(({ id }) => referencedProfileIds.has(id))
    .map(({ id, displayName, name, email }) => [
      id,
      { id, displayName, name, email }
    ]));
  const promotionSites = Object.fromEntries(normalizedConfig.promotionSites
    .flatMap((site) => modernMode ? (site.pages || []).map((page) => ({
      id: page.id,
      name: `${site.name} · ${page.keywords[0] || page.url}`,
      url: page.url,
      content: page.content,
      email: site.email
    })) : [site])
    .filter(({ id }) => referencedSiteIds.has(id))
    .map(({ id, name, url, content, email }) => [
      id,
      {
        id,
        name,
        url,
        content,
        ...(email ? { email } : {})
      }
    ]));

  const plan = {
    version: BATCH_PLAN_VERSION,
    planId,
    planFingerprint: null,
    configRevision: normalizedConfig.revision,
    createdAt,
    illegalSiteRulesVersion,
    quotas: structuredClone(normalizedConfig.assignmentPolicy.quotas),
    repeatOverrides: [...overrideSet].sort(),
    profiles,
    promotionSites,
    tasks,
    warnings: tasks.some(({ recentSuccessOverride: override }) => override)
      ? ['recent_success_override']
      : [],
    confirmationRequirements: []
  };
  assertNoSensitiveFields(plan);
  return plan;
}

function countInto(target, key) {
  if (!key) return;
  target[key] = (target[key] || 0) + 1;
}

export function summarizeBatchPlan(plan) {
  if (!plan || !Array.isArray(plan.tasks)) throw codedError('invalid_batch_plan');
  const summary = {
    status: { eligible: 0, blocked: 0 },
    byBlockReason: {},
    byAssignmentPair: {},
    byProfile: {},
    byPromotionSite: {},
    byTargetDomain: {}
  };
  for (const task of plan.tasks) {
    if (task.state === 'eligible') {
      summary.status.eligible += 1;
      countInto(summary.byAssignmentPair, task.assignmentPairId);
      countInto(summary.byProfile, task.profileId);
      countInto(summary.byPromotionSite, task.promotionSiteId);
      countInto(summary.byTargetDomain, task.targetDomain);
    } else {
      summary.status.blocked += 1;
      countInto(summary.byBlockReason, task.blockReason);
    }
  }
  return summary;
}

export function hasRaisedBatchQuota(quotas) {
  return Object.entries(DEFAULT_QUOTAS).some(([key, value]) => quotas?.[key] > value);
}
