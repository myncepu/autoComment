import {
  DEFAULT_QUOTAS,
  assertNoSensitiveFields
} from './domain-config-schema.mjs';

export const PLAN_CONFIRMATION_VERSION = 1;
export const DEFAULT_CONFIRMATION_MAX_AGE_MS = 15 * 60 * 1_000;

const CONFIRMATION_KEYS = [
  'version',
  'planFingerprint',
  'normalConfirmed',
  'requiredRisks',
  'highRiskConfirmed',
  'confirmedAt'
];
const RISK_CODES = Object.freeze([
  'multiple_assignments',
  'raised_quota',
  'recent_success_override'
]);

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function canonicalValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw codedError('invalid_batch_plan');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) throw codedError('invalid_batch_plan');
  return Object.fromEntries(Object.keys(value)
    .sort()
    .map((key) => [key, canonicalValue(value[key])]));
}

function fingerprintPayload(plan) {
  if (!isRecord(plan)) throw codedError('invalid_batch_plan');
  const {
    planFingerprint: _planFingerprint,
    warnings: _warnings,
    confirmationRequirements: _confirmationRequirements,
    ...payload
  } = plan;
  return canonicalValue(payload);
}

function subtleFrom(cryptoImpl) {
  const subtle = cryptoImpl?.subtle;
  if (!subtle || typeof subtle.digest !== 'function') {
    throw codedError('crypto_unavailable');
  }
  return subtle;
}

export async function fingerprintBatchPlan(plan, cryptoImpl = globalThis.crypto) {
  assertNoSensitiveFields(plan);
  const serialized = JSON.stringify(fingerprintPayload(plan));
  const digest = await subtleFrom(cryptoImpl).digest(
    'SHA-256',
    new TextEncoder().encode(serialized)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function raisedQuota(quotas) {
  return Object.entries(DEFAULT_QUOTAS).some(([key, defaultValue]) => (
    Number.isFinite(quotas?.[key]) && quotas[key] > defaultValue
  ));
}

export function getPlanConfirmationRequirements(plan) {
  if (!isRecord(plan) || !Array.isArray(plan.tasks)) {
    throw codedError('invalid_batch_plan');
  }
  const eligible = plan.tasks.filter(({ state }) => state === 'eligible');
  const profileIds = new Set(eligible.map(({ profileId }) => profileId).filter(Boolean));
  const siteIds = new Set(
    eligible.map(({ promotionSiteId }) => promotionSiteId).filter(Boolean)
  );
  const requirements = [];
  if (profileIds.size > 1 || siteIds.size > 1) {
    requirements.push(RISK_CODES[0]);
  }
  if (raisedQuota(plan.quotas)) {
    requirements.push(RISK_CODES[1]);
  }
  if ((Array.isArray(plan.repeatOverrides) && plan.repeatOverrides.length > 0)
      || eligible.some(({ recentSuccessOverride }) => recentSuccessOverride === true)) {
    requirements.push(RISK_CODES[2]);
  }
  return requirements;
}

function deepFreeze(value, visited = new WeakSet()) {
  if (!value || typeof value !== 'object' || visited.has(value)) return value;
  visited.add(value);
  for (const child of Object.values(value)) deepFreeze(child, visited);
  return Object.freeze(value);
}

export async function finalizeBatchPlan(planDraft, cryptoImpl = globalThis.crypto) {
  assertNoSensitiveFields(planDraft);
  const finalized = structuredClone(planDraft);
  finalized.planFingerprint = null;
  finalized.confirmationRequirements = getPlanConfirmationRequirements(finalized);
  finalized.planFingerprint = await fingerprintBatchPlan(finalized, cryptoImpl);
  return deepFreeze(finalized);
}

function resolvedNow(now) {
  const value = typeof now === 'function' ? now() : now;
  if (!Number.isInteger(value) || value < 0) throw codedError('invalid_confirmation_time');
  return value;
}

function finalizedFingerprint(plan) {
  const fingerprint = plan?.planFingerprint;
  if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(fingerprint)) {
    throw codedError('plan_not_finalized');
  }
  return fingerprint;
}

export function createPlanConfirmation(
  plan,
  { normalConfirmed, highRiskConfirmed },
  now = Date.now
) {
  const planFingerprint = finalizedFingerprint(plan);
  if (typeof normalConfirmed !== 'boolean' || typeof highRiskConfirmed !== 'boolean') {
    throw codedError('invalid_confirmation_input');
  }
  return {
    version: PLAN_CONFIRMATION_VERSION,
    planFingerprint,
    normalConfirmed,
    requiredRisks: getPlanConfirmationRequirements(plan),
    highRiskConfirmed,
    confirmedAt: resolvedNow(now)
  };
}

function sameRisks(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((risk, index) => risk === expected[index]);
}

export function validatePlanConfirmation(
  plan,
  confirmation,
  {
    now = Date.now,
    maxAgeMs = DEFAULT_CONFIRMATION_MAX_AGE_MS
  } = {}
) {
  try {
    const fingerprint = finalizedFingerprint(plan);
    if (!exactKeys(confirmation, CONFIRMATION_KEYS)
        || confirmation.version !== PLAN_CONFIRMATION_VERSION
        || typeof confirmation.planFingerprint !== 'string'
        || typeof confirmation.normalConfirmed !== 'boolean'
        || typeof confirmation.highRiskConfirmed !== 'boolean'
        || !Number.isInteger(confirmation.confirmedAt)
        || confirmation.confirmedAt < 0
        || !Number.isInteger(maxAgeMs)
        || maxAgeMs <= 0) {
      return { ok: false, error: 'invalid_plan_confirmation' };
    }
    if (confirmation.planFingerprint !== fingerprint) {
      return { ok: false, error: 'plan_fingerprint_changed' };
    }
    const requiredRisks = getPlanConfirmationRequirements(plan);
    if (!sameRisks(confirmation.requiredRisks, requiredRisks)) {
      return { ok: false, error: 'confirmation_risk_set_changed' };
    }
    if (!confirmation.normalConfirmed) {
      return { ok: false, error: 'normal_confirmation_required' };
    }
    if (requiredRisks.length > 0 && !confirmation.highRiskConfirmed) {
      return { ok: false, error: 'high_risk_confirmation_required' };
    }
    const currentTime = resolvedNow(now);
    if (confirmation.confirmedAt > currentTime) {
      return { ok: false, error: 'confirmation_from_future' };
    }
    if (currentTime - confirmation.confirmedAt > maxAgeMs) {
      return { ok: false, error: 'confirmation_expired' };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error?.code === 'plan_not_finalized'
        ? 'plan_not_finalized'
        : 'invalid_plan_confirmation'
    };
  }
}
