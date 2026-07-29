export const BATCH_SKIP_REASON_LABELS = Object.freeze({
  recent_success: '近期已有成功发布记录',
  duplicate_in_batch: '批次内目标重复，未执行',
  quota_batch: '达到批次配额，未执行',
  quota_target_domain: '达到目标域名配额，未执行',
  quota_profile: '达到身份配额，未执行',
  quota_promotion_site: '达到推广网站配额，未执行',
  no_assignment: '没有可用分配，未执行',
  invalid_target_url: '目标 URL 无效，未执行',
  invalid_source_domain: '来源域名无效，未执行',
  blocked_illegal: '命中非法站点规则，未执行'
});

export function isRecentSuccessResult(result) {
  return result?.result === 'skipped' &&
    result?.skipReason === 'recent_success';
}

export function hasPublishedEvidence(result) {
  return result?.result === 'success' || isRecentSuccessResult(result);
}

export function isUnexecutedResult(result) {
  return ['skipped', 'blocked_illegal'].includes(result?.result) &&
    !isRecentSuccessResult(result);
}

export function batchSkipReasonLabel(skipReason) {
  return BATCH_SKIP_REASON_LABELS[skipReason] || '该目标未执行';
}
