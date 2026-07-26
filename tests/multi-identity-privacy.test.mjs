import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {
  createBatchPlanDraftController
} from '../lib/batch-plan-draft-controller.mjs';
import {
  createBatchRuntimeCheckpoint
} from '../lib/batch-runtime-checkpoint.mjs';
import {
  BATCH_SECRET_VAULTS_KEY,
  createBatchSecretVaultStore
} from '../lib/batch-secret-vault.mjs';
import {
  PROFILE_SECRETS_KEY,
  createProfileSecretRepository
} from '../lib/profile-secret-repository.mjs';
import {
  buildDomainConfigExport
} from '../lib/domain-config-import-export.mjs';
import {
  createDomainConfigMutations
} from '../lib/cloud-sync-domain-config.mjs';

function memoryStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(keys) {
      const names = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(names.flatMap((key) => (
        Object.hasOwn(data, key) ? [[key, structuredClone(data[key])]] : []
      )));
    },
    async set(values) {
      Object.assign(data, structuredClone(values));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    }
  };
}

function configFixture() {
  return {
    version: 2,
    revision: 4,
    profiles: [{
      id: 'profile-a',
      displayName: '作者 A',
      name: 'Alice',
      email: 'alice@example.test',
      createdAt: 1,
      updatedAt: 1
    }],
    promotionSites: [{
      id: 'site-a',
      name: '产品 A',
      url: 'https://promo.test/',
      content: 'Promotion A',
      enabled: true,
      createdAt: 1,
      updatedAt: 1
    }],
    assignmentPolicy: {
      defaultPairId: 'pair-a',
      pairs: [{
        id: 'pair-a',
        profileId: 'profile-a',
        promotionSiteId: 'site-a',
        weight: 1,
        enabled: true
      }],
      quotas: {
        batch: 100,
        perProfile: 50,
        perPromotionSite: 50,
        perTargetDomain: 3
      }
    }
  };
}

function pathsContaining(value, sentinel, path = '$', visited = new WeakSet()) {
  if (typeof value === 'string') return value.includes(sentinel) ? [path] : [];
  if (!value || typeof value !== 'object' || visited.has(value)) return [];
  visited.add(value);
  return Object.entries(value).flatMap(([key, child]) => (
    pathsContaining(child, sentinel, `${path}.${key}`, visited)
  ));
}

test('runtime password sentinel exists only in the three approved local secret surfaces', async () => {
  const sentinel = `runtime-secret-${webcrypto.randomUUID()}`;
  const localStorage = memoryStorage();
  const profileSecrets = createProfileSecretRepository(localStorage);
  await profileSecrets.setPassword('profile-a', sentinel);

  const config = configFixture();
  const planController = createBatchPlanDraftController({
    config,
    illegalSiteEvaluator: () => ({ blocked: false }),
    cryptoImpl: webcrypto,
    now: () => 1_000,
    createPlanId: () => 'privacy-plan'
  });
  await planController.setParsedCsv({
    headers: ['URL', '来源域名'],
    rows: [{
      rowNumber: 2,
      originalRow: ['https://target.test/post', 'target.test']
    }]
  });
  await planController.setMapping({
    targetUrl: 0,
    sourceDomain: 1,
    profileRef: null,
    promotionSiteRef: null
  });
  const confirmed = planController.confirm({
    normalConfirmed: true,
    highRiskConfirmed: false
  });
  const checkpoint = createBatchRuntimeCheckpoint({
    batchId: confirmed.plan.planId,
    plan: confirmed.plan,
    confirmation: confirmed.confirmation,
    settings: {
      concurrency: 1,
      timeoutSeconds: 60,
      autoGenerate: true,
      autoSubmit: true
    }
  }, 1_001);

  const vaultStore = createBatchSecretVaultStore(localStorage, {
    now: () => 1_001
  });
  const entry = await vaultStore.buildPreparedEntry(
    checkpoint.batchId,
    ['profile-a'],
    profileSecrets
  );
  const vaultPatch = await vaultStore.buildStoragePatch(
    checkpoint.batchId,
    entry
  );
  await localStorage.set(vaultPatch);

  const activeCheckpoint = structuredClone(checkpoint);
  Object.assign(activeCheckpoint.tasks['0'], {
    state: 'active',
    tabId: 91,
    windowId: 42,
    startedAt: 1_002
  });
  activeCheckpoint.status = 'running';
  const passwordResponse = await vaultStore.getAuthorizedPassword({
    request: {
      type: 'BATCH_GET_TASK_PASSWORD',
      batchId: checkpoint.batchId,
      taskId: checkpoint.tasks['0'].taskId,
      urlIndex: 0,
      profileId: 'profile-a'
    },
    senderTabId: 91,
    checkpoint: activeCheckpoint
  });

  const task = confirmed.plan.tasks[0];
  const handle = {
    type: 'BATCH_HANDLE',
    batchId: checkpoint.batchId,
    taskId: task.taskId,
    urlIndex: task.urlIndex,
    attempt: 1,
    url: task.targetUrl,
    profileId: task.profileId,
    promotionSiteId: task.promotionSiteId,
    assignmentPairId: task.assignmentPairId,
    assignmentSource: task.assignmentSource,
    configRevision: confirmed.plan.configRevision,
    profile: confirmed.plan.profiles[task.profileId],
    promotionSite: confirmed.plan.promotionSites[task.promotionSiteId]
  };
  const submitContext = {
    batchId: checkpoint.batchId,
    taskId: task.taskId,
    urlIndex: 0,
    profileId: task.profileId,
    promotionSiteId: task.promotionSiteId,
    attempt: 1,
    url: task.targetUrl,
    result: 'success',
    aiContent: 'Generated comment',
    history: {
      submittedAt: 1_003,
      targetPageUrl: task.targetUrl,
      promotedWebsiteUrl: confirmed.plan.promotionSites[task.promotionSiteId].url,
      profileId: task.profileId,
      profileDisplayName: confirmed.plan.profiles[task.profileId].displayName,
      promotionSiteId: task.promotionSiteId,
      promotionSiteName:
        confirmed.plan.promotionSites[task.promotionSiteId].name,
      commentHtml: 'Generated comment',
      commentText: 'Generated comment',
      anchors: []
    }
  };
  const result = {
    originalIndex: 0,
    attempt: 1,
    profileId: task.profileId,
    promotionSiteId: task.promotionSiteId,
    profileDisplayName: confirmed.plan.profiles[task.profileId].displayName,
    promotionSiteName: confirmed.plan.promotionSites[task.promotionSiteId].name,
    result: 'success',
    aiContent: 'Generated comment'
  };
  const nextConfig = structuredClone(config);
  nextConfig.revision = 5;
  nextConfig.profiles[0].displayName = '作者 A2';
  nextConfig.profiles[0].updatedAt = 2;
  const publicSurfaces = {
    domainConfig: config,
    configExport: buildDomainConfigExport(config, { exportedAt: 1_004 }),
    cloudMutations: createDomainConfigMutations({
      oldValue: config,
      newValue: nextConfig
    }, {
      now: () => 1_004,
      createMutationId: (() => {
        let sequence = 0;
        return () => `privacy-mutation-${++sequence}`;
      })()
    }),
    batchPlan: confirmed.plan,
    planConfirmation: confirmed.confirmation,
    checkpoint,
    urlQueue: checkpoint.source,
    batchHandle: handle,
    submitContext,
    result,
    history: submitContext.history,
    resultExport: JSON.stringify(result),
    capturedLogs: [
      'batch_start:privacy-plan',
      'task_phase:submitting',
      'task_result:success'
    ]
  };

  assert.deepEqual(pathsContaining(publicSurfaces, sentinel), []);
  assert.deepEqual(
    pathsContaining(localStorage.data[PROFILE_SECRETS_KEY], sentinel),
    ['$.passwordsByProfileId.profile-a']
  );
  assert.deepEqual(
    pathsContaining(localStorage.data[BATCH_SECRET_VAULTS_KEY], sentinel),
    ['$.privacy-plan.passwordsByProfileId.profile-a']
  );
  assert.deepEqual(pathsContaining(passwordResponse, sentinel), ['$.password']);
  assert.equal(passwordResponse.password, sentinel);
});

test('production submit-context diagnostics omit identity and comment values', () => {
  const source = readFileSync(
    new URL('../content.js', import.meta.url),
    'utf8'
  );
  const start = source.indexOf('function restoredContextDiagnostic(');
  const end = source.indexOf(
    '\n\n  async function confirmRestoredBatchSubmit',
    start
  );
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const context = vm.createContext({});
  vm.runInContext(
    `${source.slice(start, end)}
globalThis.restoredContextDiagnostic = restoredContextDiagnostic;`,
    context
  );
  const sentinel = 'PRIVATE-SENTINEL-DO-NOT-LOG';
  const diagnostic = context.restoredContextDiagnostic({
    batchId: 'batch-a',
    taskId: 'task-a',
    urlIndex: 1,
    attempt: 2,
    profileId: 'profile-a',
    promotionSiteId: 'site-a',
    name: sentinel,
    email: `${sentinel}@example.test`,
    aiContent: sentinel,
    history: {
      commentText: sentinel,
      targetPageUrl: `https://target.test/${sentinel}`
    }
  });

  assert.equal(JSON.stringify(diagnostic).includes(sentinel), false);
  assert.equal(diagnostic.aiContentLength, sentinel.length);
  assert.equal(diagnostic.hasHistory, true);
});

test('production content diagnostics never log raw URLs comments or exception messages', () => {
  const source = readFileSync(
    new URL('../content.js', import.meta.url),
    'utf8'
  );
  assert.doesNotMatch(source, /console\.(?:log|warn|error)\([^\n]*location\.href/);
  assert.doesNotMatch(
    source,
    /console\.(?:log|warn|error)\([^\n]*(?:substring|slice)\(0,\s*(?:50|80|100)\)/
  );
  assert.doesNotMatch(
    source,
    /console\.(?:log|warn|error)\([^\n]*\b(?:err|error|e|e2|e3)\.message/
  );
});
