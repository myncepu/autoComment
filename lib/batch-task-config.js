((root) => {
  const HANDLE_KEYS = [
    'type',
    'batchId',
    'taskId',
    'urlIndex',
    'attempt',
    'url',
    'profileId',
    'promotionSiteId',
    'assignmentPairId',
    'assignmentSource',
    'configRevision',
    'automation',
    'profile',
    'promotionSite'
  ];
  const AUTOMATION_KEYS = ['autoGenerate', 'autoSubmit'];
  const PROFILE_KEYS = ['id', 'displayName', 'name', 'email'];
  const PROMOTION_SITE_KEYS = ['id', 'name', 'url', 'content'];
  const SENSITIVE_KEY = /password|secret|token|api.?key|cookie|authorization/i;
  let current = null;

  function codedError(code) {
    const error = new Error(code);
    error.code = code;
    return error;
  }

  function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function hasExactKeys(value, keys) {
    return isRecord(value)
      && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
  }

  function assertNoSensitiveFields(value, visited = new WeakSet()) {
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) throw codedError('sensitive_task_config');
      assertNoSensitiveFields(child, visited);
    }
  }

  function identifier(value) {
    return typeof value === 'string' && value.length > 0;
  }

  function safeHttpUrl(value) {
    try {
      const parsed = new URL(value);
      return ['http:', 'https:'].includes(parsed.protocol)
        && parsed.username === ''
        && parsed.password === '';
    } catch (_) {
      return false;
    }
  }

  function validProfile(profile) {
    return hasExactKeys(profile, PROFILE_KEYS)
      && PROFILE_KEYS.every((key) => typeof profile[key] === 'string')
      && identifier(profile.id)
      && identifier(profile.displayName)
      && identifier(profile.name)
      && identifier(profile.email);
  }

  function validPromotionSite(site) {
    return hasExactKeys(site, PROMOTION_SITE_KEYS)
      && PROMOTION_SITE_KEYS.every((key) => typeof site[key] === 'string')
      && identifier(site.id)
      && identifier(site.name)
      && safeHttpUrl(site.url);
  }

  function validAutomation(automation) {
    return hasExactKeys(automation, AUTOMATION_KEYS)
      && typeof automation.autoGenerate === 'boolean'
      && typeof automation.autoSubmit === 'boolean'
      && (!automation.autoSubmit || automation.autoGenerate);
  }

  function deepFreeze(value, visited = new WeakSet()) {
    if (!value || typeof value !== 'object' || visited.has(value)) return value;
    visited.add(value);
    Object.values(value).forEach((child) => deepFreeze(child, visited));
    return Object.freeze(value);
  }

  function validateHandle(message) {
    assertNoSensitiveFields(message);
    if (
      !hasExactKeys(message, HANDLE_KEYS)
      || message.type !== 'BATCH_HANDLE'
      || !identifier(message.batchId)
      || !identifier(message.taskId)
      || !Number.isInteger(message.urlIndex)
      || message.urlIndex < 0
      || !Number.isInteger(message.attempt)
      || message.attempt < 1
      || !safeHttpUrl(message.url)
      || !identifier(message.profileId)
      || !identifier(message.promotionSiteId)
      || !identifier(message.assignmentPairId)
      || !identifier(message.assignmentSource)
      || !Number.isInteger(message.configRevision)
      || message.configRevision < 0
      || !validAutomation(message.automation)
      || !validProfile(message.profile)
      || !validPromotionSite(message.promotionSite)
      || message.profile.id !== message.profileId
      || message.promotionSite.id !== message.promotionSiteId
    ) {
      throw codedError('invalid_task_config');
    }
  }

  function cloneFrozen(value) {
    return deepFreeze(structuredClone(value));
  }

  async function loadManualDefault(repository) {
    if (typeof repository?.getConfig !== 'function') {
      throw codedError('invalid_manual_config_repository');
    }
    const config = await repository.getConfig();
    assertNoSensitiveFields(config);
    const pairs = config?.assignmentPolicy?.pairs;
    const defaultPairId = config?.assignmentPolicy?.defaultPairId;
    const pair = pairs?.find(
      ({ id }) => id === defaultPairId
    );
    const profile = config?.profiles?.find(({ id }) => id === pair?.profileId);
    const promotionSite = config?.promotionSites?.find(
      ({ id }) => id === pair?.promotionSiteId
    );
    if (
      pair?.enabled !== true
      || promotionSite?.enabled !== true
      || !isRecord(profile)
      || !identifier(profile.id)
      || !identifier(profile.displayName)
      || !identifier(profile.name)
      || !identifier(profile.email)
      || !isRecord(promotionSite)
      || !identifier(promotionSite.id)
      || !identifier(promotionSite.name)
      || !safeHttpUrl(promotionSite.url)
      || typeof promotionSite.content !== 'string'
    ) {
      throw codedError('manual_default_assignment_unavailable');
    }
    return cloneFrozen({
      profile: {
        id: profile.id,
        displayName: profile.displayName,
        name: profile.name,
        email: profile.email
      },
      promotionSite: {
        id: promotionSite.id,
        name: promotionSite.name,
        url: promotionSite.url,
        content: promotionSite.content
      },
      assignmentPairId: pair.id
    });
  }

  root.AutoCommentBatchTaskConfig = Object.freeze({
    acceptHandle(message) {
      validateHandle(message);
      const candidate = cloneFrozen(message);
      if (
        current &&
        (
          current.batchId !== candidate.batchId ||
          current.taskId !== candidate.taskId ||
          current.urlIndex !== candidate.urlIndex ||
          current.profileId !== candidate.profileId ||
          current.promotionSiteId !== candidate.promotionSiteId ||
          current.attempt !== candidate.attempt
        )
      ) {
        throw codedError('stale_task_config');
      }
      current = candidate;
      return cloneFrozen(current);
    },

    getCurrent() {
      return current ? cloneFrozen(current) : null;
    },

    cacheKey() {
      return current
        ? [
            current.batchId,
            current.taskId,
            current.promotionSiteId,
            current.attempt
          ].join(':')
        : null;
    },

    async getTaskPassword(runtime) {
      if (!current || typeof runtime?.sendMessage !== 'function') {
        throw codedError('task_config_unavailable');
      }
      const response = await runtime.sendMessage({
        type: 'BATCH_GET_TASK_PASSWORD',
        batchId: current.batchId,
        taskId: current.taskId,
        urlIndex: current.urlIndex,
        profileId: current.profileId
      });
      if (
        !response?.ok
        || !(
          response.password === null
          || typeof response.password === 'string'
        )
      ) {
        throw codedError(response?.error || 'task_password_unavailable');
      }
      return response.password;
    },

    clear() {
      current = null;
    },

    loadManualDefault
  });
})(globalThis);
