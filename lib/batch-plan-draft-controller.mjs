import {
  resolveBatchRows
} from './batch-csv-import.mjs';
import {
  canonicalizeBatchTargetUrl,
  compileBatchPlan,
  summarizeBatchPlan
} from './batch-plan-compiler.mjs';
import {
  createPlanConfirmation,
  finalizeBatchPlan
} from './batch-plan-confirmation.mjs';
import {
  assertNoSensitiveFields,
  validateDomainConfig
} from './domain-config-schema.mjs';
import { normalizeOutlinkSuccessStats } from './outlink-success-stats.mjs';

const SENSITIVE_COLUMN = /(?:password|passwd|passphrase|secret|token|api[_-]?key|authorization|credential)/i;

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function deepFreeze(value, visited = new WeakSet()) {
  if (!value || typeof value !== 'object' || visited.has(value)) return value;
  visited.add(value);
  for (const child of Object.values(value)) deepFreeze(child, visited);
  return Object.freeze(value);
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function validatedConfig(value) {
  const result = validateDomainConfig(value);
  if (!result.ok) throw codedError(result.error);
  return result.value;
}

function normalizedRecent(values) {
  if (!Array.isArray(values)) throw codedError('invalid_recent_success_urls');
  return [...new Set(values.map(canonicalizeBatchTargetUrl))];
}

function normalizedParsed(value) {
  if (!value || !Array.isArray(value.headers) || !Array.isArray(value.rows)) {
    throw codedError('invalid_parsed_csv');
  }
  return {
    headers: value.headers.map((header) => String(header ?? '').trim()),
    rows: value.rows.map((row, index) => ({
      rowNumber: Number.isInteger(row?.rowNumber) ? row.rowNumber : index + 2,
      originalRow: Array.isArray(row?.originalRow)
        ? row.originalRow.map((cell) => String(cell ?? ''))
        : []
    }))
  };
}

function publicParsed(value) {
  if (!value) return null;
  const sensitiveColumns = new Set(value.headers.flatMap((header, index) => (
    SENSITIVE_COLUMN.test(header) ? [index] : []
  )));
  return {
    headers: value.headers.map((header, index) => (
      sensitiveColumns.has(index) ? '敏感列' : header
    )),
    rows: value.rows.map((row) => ({
      rowNumber: row.rowNumber,
      originalRow: row.originalRow.map((cell, index) => (
        sensitiveColumns.has(index) ? '[REDACTED]' : cell
      ))
    }))
  };
}

function publicResolvedRows(value, source) {
  if (!value || !source) return null;
  const safe = publicParsed(source);
  const originals = new Map(
    safe.rows.map((row) => [row.rowNumber, row.originalRow])
  );
  return value.map((row) => ({
    ...clone(row),
    originalRow: clone(originals.get(row.rowNumber) || [])
  }));
}

export function createBatchPlanDraftController({
  config,
  recentSuccessUrls = [],
  successfulTargetStats = [],
  selectedProfileIds = null,
  selectedPromotionPageIds = null,
  illegalSiteEvaluator,
  illegalSiteRulesVersion = null,
  cryptoImpl = globalThis.crypto,
  now = Date.now,
  createPlanId = () => globalThis.crypto.randomUUID()
}) {
  let domainConfig = validatedConfig(config);
  let recent = normalizedRecent(recentSuccessUrls);
  let successfulTargets = normalizeOutlinkSuccessStats(successfulTargetStats);
  let selectedProfiles = Array.isArray(selectedProfileIds)
    ? [...new Set(selectedProfileIds)]
    : null;
  let selectedPages = Array.isArray(selectedPromotionPageIds)
    ? [...new Set(selectedPromotionPageIds)]
    : null;
  let parsed = null;
  let mapping = null;
  let rows = null;
  let repeatOverrides = new Set();
  let plan = null;
  let summary = null;
  let confirmation = null;
  let planId = null;
  let rebuildRevision = 0;

  function resolvedNow() {
    const value = typeof now === 'function' ? now() : now;
    if (!Number.isInteger(value) || value < 0) throw codedError('invalid_plan_time');
    return value;
  }

  async function rebuild() {
    const revision = ++rebuildRevision;
    confirmation = null;
    if (!parsed || !mapping) {
      rows = null;
      plan = null;
      summary = null;
      return snapshot();
    }
    rows = resolveBatchRows(parsed, mapping, domainConfig);
    planId ||= String(createPlanId());
    const draft = compileBatchPlan({
      planId,
      createdAt: resolvedNow(),
      config: domainConfig,
      rows,
      recentSuccessUrls: recent,
      successfulTargetStats: successfulTargets,
      selectedProfileIds: selectedProfiles,
      selectedPromotionPageIds: selectedPages,
      repeatOverrides: [...repeatOverrides],
      illegalSiteEvaluator,
      illegalSiteRulesVersion
    });
    const finalized = await finalizeBatchPlan(draft, cryptoImpl);
    if (revision !== rebuildRevision) return snapshot();
    plan = finalized;
    summary = summarizeBatchPlan(plan);
    return snapshot();
  }

  function snapshot() {
    const value = {
      configRevision: domainConfig.revision,
      parsed: publicParsed(parsed),
      mapping: clone(mapping),
      resolvedRows: publicResolvedRows(rows, parsed),
      repeatOverrides: [...repeatOverrides].sort(),
      selectedProfileIds: clone(selectedProfiles),
      selectedPromotionPageIds: clone(selectedPages),
      plan: clone(plan),
      summary: clone(summary),
      confirmation: clone(confirmation)
    };
    assertNoSensitiveFields(value);
    return deepFreeze(value);
  }

  return {
    snapshot,
    clearSource() {
      rebuildRevision += 1;
      parsed = null;
      mapping = null;
      rows = null;
      repeatOverrides = new Set();
      plan = null;
      summary = null;
      confirmation = null;
      planId = null;
      return snapshot();
    },
    async setConfig(value) {
      domainConfig = validatedConfig(value);
      return rebuild();
    },
    async setRecentSuccessUrls(values) {
      recent = normalizedRecent(values);
      repeatOverrides = new Set(
        [...repeatOverrides].filter((url) => recent.includes(url))
      );
      return rebuild();
    },
    async setSuccessfulTargetStats(values) {
      successfulTargets = normalizeOutlinkSuccessStats(values);
      return rebuild();
    },
    async setAllocationSelection({ profileIds, promotionPageIds }) {
      if (!Array.isArray(profileIds) || !Array.isArray(promotionPageIds)) {
        throw codedError('invalid_allocation_selection');
      }
      selectedProfiles = [...new Set(profileIds.map(String).filter(Boolean))];
      selectedPages = [...new Set(promotionPageIds.map(String).filter(Boolean))];
      return rebuild();
    },
    async setParsedCsv(value) {
      rebuildRevision += 1;
      parsed = normalizedParsed(value);
      mapping = null;
      rows = null;
      repeatOverrides = new Set();
      plan = null;
      summary = null;
      confirmation = null;
      planId = null;
      return snapshot();
    },
    async setMapping(value) {
      mapping = clone(value);
      return rebuild();
    },
    async setRepeatOverride(rawUrl, included) {
      const url = canonicalizeBatchTargetUrl(rawUrl);
      const currentTask = plan?.tasks.find(
        (task) => task.canonicalTargetUrl === url
      );
      if (!recent.includes(url)
          || currentTask?.blockReason === 'duplicate_in_batch') {
        return false;
      }
      if (included) repeatOverrides.add(url);
      else repeatOverrides.delete(url);
      await rebuild();
      return snapshot();
    },
    confirm(checks) {
      if (!plan) throw codedError('batch_plan_required');
      confirmation = createPlanConfirmation(plan, checks, now);
      return snapshot();
    }
  };
}
