import {
  DEFAULT_QUOTAS,
  assertNoSensitiveFields,
  validateDomainConfig
} from './domain-config-schema.mjs';

export const BATCH_PLAN_VERSION = 2;
export const BATCH_SKIP_REASONS = Object.freeze({
  INVALID_TARGET_URL: 'invalid_target_url',
  INVALID_SOURCE_DOMAIN: 'invalid_source_domain',
  BLOCKED_ILLEGAL: 'blocked_illegal',
  DUPLICATE_IN_BATCH: 'duplicate_in_batch',
  RECENT_SUCCESS: 'recent_success',
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

function selectWeightedPair(weightStates, counts, quotas) {
  const proposed = proposedPairStates(weightStates).sort(compareWeighted);
  const selected = proposed.find((pair) => !quotaReason(pair, counts, quotas));
  if (!selected) {
    const intended = proposed[0];
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
  const sitesById = new Map(
    normalizedConfig.promotionSites.map((site) => [site.id, site])
  );
  const approvedPairs = normalizedConfig.assignmentPolicy.pairs.filter((pair) => (
    pair.enabled && sitesById.get(pair.promotionSiteId)?.enabled
  ));
  if (approvedPairs.length === 0) throw codedError('no_enabled_assignment_pairs');
  const fallbackPair = defaultPair(normalizedConfig);
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

  const tasks = rows.map((row, index) => {
    const assignedPair = explicitPair(row, normalizedConfig, sitesById);
    let canonicalTargetUrl = '';
    let targetDomain = '';
    let sourceDomain = '';
    let blockReason = null;
    let recentSuccessOverride = false;

    try {
      canonicalTargetUrl = canonicalizeBatchTargetUrl(row.targetUrlRaw);
      targetDomain = new URL(canonicalTargetUrl).hostname;
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
    if (!blockReason && recentSet.has(canonicalTargetUrl)) {
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
      } else {
        counts.batch += 1;
        increment(counts.domains, targetDomain);
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

    if (assignedPair) {
      const assignmentBlock = quotaReason(
        assignedPair,
        counts,
        normalizedConfig.assignmentPolicy.quotas
      );
      if (!assignmentBlock) {
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

    const selection = selectWeightedPair(
      weightStates,
      counts,
      normalizedConfig.assignmentPolicy.quotas
    );
    if (!selection.blockReason) {
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
    .filter(({ id }) => referencedSiteIds.has(id))
    .map(({ id, name, url, content }) => [
      id,
      { id, name, url, content }
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
