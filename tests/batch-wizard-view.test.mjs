import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createBatchWizardView } from '../lib/batch-wizard-view.mjs';

function wizardDocument() {
  return new JSDOM(`<!doctype html>
    <html>
      <body>
        <button data-action="new-batch">新建批次</button>
        <dialog data-batch-wizard></dialog>
      </body>
    </html>`, {
    url: 'http://127.0.0.1:4173/tests/fixtures/batch-console-page.html'
  }).window.document;
}

function validDraftFixture(overrides = {}) {
  return {
    step: 1,
    assignment: {
      identityId: 'default-identity',
      promotionSiteId: 'default-promotion-site',
      identitySnapshot: {
        displayName: 'CloudHu',
        email: 'you@test.com'
      },
      promotionSiteSnapshot: {
        label: 'promo.test',
        url: 'https://promo.test/',
        contentSummary: 'Local fixture'
      }
    },
    preflight: null,
    settings: {
      autoOpenPanel: false,
      autoGenerate: true,
      autoSubmit: true,
      concurrency: 3,
      timeoutSeconds: 60
    },
    readinessError: '',
    ...overrides
  };
}

function preflightWithExcludedRows() {
  return {
    headers: ['原URL'],
    summary: {
      raw: 8,
      eligible: 5,
      duplicate: 1,
      blocked: 1,
      invalid: 1,
      included: 5
    },
    rows: [
      ...Array.from({ length: 5 }, (_, index) => ({
        rowNumber: index + 2,
        url: `https://target.test/${index + 1}`,
        sourceDomain: 'target.test',
        status: 'eligible',
        reason: 'URL 和域名有效',
        included: true,
        overridable: false
      })),
      {
        rowNumber: 7,
        url: 'https://target.test/1',
        sourceDomain: 'target.test',
        status: 'duplicate',
        reason: '重复 URL',
        included: false,
        overridable: true
      },
      {
        rowNumber: 8,
        url: 'https://blocked.test/',
        sourceDomain: 'blocked.test',
        status: 'blocked',
        reason: '命中非法站点规则',
        included: false,
        overridable: false
      },
      {
        rowNumber: 9,
        url: null,
        sourceDomain: '',
        status: 'invalid',
        reason: 'URL 无效',
        included: false,
        overridable: false
      }
    ]
  };
}

function click(document, selector) {
  const element = document.querySelector(selector);
  assert.ok(element, `missing element: ${selector}`);
  element.dispatchEvent(new document.defaultView.MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    button: 0
  }));
}

function change(document, selector, value, checked) {
  const element = document.querySelector(selector);
  assert.ok(element, `missing element: ${selector}`);
  if (value !== undefined) element.value = value;
  if (checked !== undefined) element.checked = checked;
  element.dispatchEvent(new document.defaultView.Event('change', {
    bubbles: true
  }));
}

test('moves through labelled steps and allows start when invalid rows stay excluded', () => {
  const document = wizardDocument();
  const events = [];
  const view = createBatchWizardView(document, {
    onDraftChange(draft) {
      events.push(['draft', draft]);
    },
    onStart(draft) {
      events.push(['start', draft]);
    }
  });

  view.open(validDraftFixture());
  assert.equal(document.querySelector('[aria-current="step"]').textContent, '分配配置');
  assert.equal(document.querySelectorAll('ol[data-wizard-steps]').length, 1);
  assert.equal(document.querySelectorAll('section[aria-labelledby]').length, 4);

  click(document, '[data-action="wizard-next"]');
  assert.equal(document.querySelector('[aria-current="step"]').textContent, '导入与预检');
  view.render(validDraftFixture({
    step: 2,
    preflight: preflightWithExcludedRows()
  }));

  assert.match(document.querySelector('[data-preflight-summary]').textContent, /将处理 5/);
  assert.equal(document.querySelector('[data-preflight-row="8"]').dataset.included, 'false');
  assert.equal(document.querySelector('[data-preflight-row="9"]').dataset.included, 'false');
  assert.equal(document.querySelector('[data-preflight-row="8"] button'), null);
  assert.equal(document.querySelector('[data-preflight-row="9"] button'), null);

  view.render(validDraftFixture({
    step: 4,
    preflight: preflightWithExcludedRows()
  }));
  assert.equal(document.querySelector('[data-action="wizard-start"]').disabled, false);
  click(document, '[data-action="wizard-start"]');
  assert.equal(events.at(-1)[0], 'start');
  assert.equal(events.at(-1)[1].preflight.summary.included, 5);
});

test('renders column mapping, assignment preview, quotas, and risk-bound confirmations', () => {
  const document = wizardDocument();
  const changes = [];
  const plan = {
    planFingerprint: 'a'.repeat(64),
    quotas: {
      batch: 120,
      perProfile: 50,
      perPromotionSite: 50,
      perTargetDomain: 3
    },
    confirmationRequirements: [
      'multiple_assignments',
      'raised_quota',
      'recent_success_override'
    ],
    tasks: [
      {
        rowNumber: 2,
        targetUrl: 'https://one.test/',
        profileId: 'profile-a',
        promotionSiteId: 'site-a',
        assignmentSource: 'explicit',
        state: 'eligible',
        blockReason: null,
        recentSuccessOverride: false
      },
      {
        rowNumber: 3,
        targetUrl: 'https://one.test/',
        profileId: 'profile-b',
        promotionSiteId: 'site-b',
        assignmentSource: 'default_blocked',
        state: 'blocked',
        blockReason: 'duplicate_in_batch',
        recentSuccessOverride: false
      },
      {
        rowNumber: 4,
        targetUrl: 'https://recent.test/',
        profileId: 'profile-b',
        promotionSiteId: 'site-b',
        assignmentSource: 'weighted',
        state: 'blocked',
        blockReason: 'recent_success',
        recentSuccessOverride: false
      }
    ]
  };
  const view = createBatchWizardView(document, {
    onDraftChange(draft) {
      changes.push(draft);
    }
  });

  const domainDraft = {
    ...validDraftFixture(),
    step: 2,
    domainConfig: {
      profiles: [
        { id: 'profile-a', displayName: '作者 A' },
        { id: 'profile-b', displayName: '作者 B' }
      ],
      promotionSites: [
        { id: 'site-a', name: '产品 A' },
        { id: 'site-b', name: '产品 B' }
      ],
      assignmentPolicy: {
        pairs: [
          {
            id: 'pair-a',
            profileId: 'profile-a',
            promotionSiteId: 'site-a',
            weight: 2,
            enabled: true
          },
          {
            id: 'pair-b',
            profileId: 'profile-b',
            promotionSiteId: 'site-b',
            weight: 1,
            enabled: true
          }
        ],
        quotas: plan.quotas
      }
    },
    parsedCsv: {
      headers: ['目标', '来源', '身份', '推广网站'],
      rows: []
    },
    mapping: {
      targetUrl: 0,
      sourceDomain: 1,
      profileRef: 2,
      promotionSiteRef: 3
    },
    plan,
    planSummary: {
      status: { eligible: 1, blocked: 2 },
      byBlockReason: {
        duplicate_in_batch: 1,
        recent_success: 1
      },
      byProfile: { 'profile-a': 1 },
      byPromotionSite: { 'site-a': 1 }
    },
    confirmation: null
  };
  view.open(domainDraft);

  assert.equal(document.querySelector('[name="mappingTargetUrl"]').value, '0');
  assert.equal(document.querySelector('[name="mappingProfileRef"]').value, '2');
  assert.match(document.querySelector('[data-plan-summary]').textContent, /可执行 1/);
  assert.match(document.querySelector('[data-quota-summary]').textContent, /批次 120/);
  assert.match(
    document.querySelector('[data-plan-row="2"]').textContent,
    /作者 A.*产品 A.*显式/
  );
  assert.equal(
    document.querySelector('[data-plan-row="3"] [data-action="toggle-repeat-override"]'),
    null
  );
  assert.ok(
    document.querySelector('[data-plan-row="4"] [data-action="toggle-repeat-override"]')
  );

  view.render({
    ...domainDraft,
    step: 4,
    confirmation: null
  });
  assert.ok(document.querySelector('[name="normalConfirmed"]'));
  assert.ok(document.querySelector('[name="highRiskConfirmed"]'));
  assert.match(document.querySelector('[data-confirmation-risks]').textContent, /多身份或多推广网站/);
  assert.match(document.querySelector('[data-confirmation-risks]').textContent, /提高了配额/);
  assert.match(document.querySelector('[data-confirmation-risks]').textContent, /近期成功目标/);
  assert.equal(document.querySelector('[data-action="wizard-start"]').disabled, true);
});

test('requires assignment snapshots and keeps credentials out of emitted drafts', () => {
  const document = wizardDocument();
  const drafts = [];
  const view = createBatchWizardView(document, {
    onDraftChange(draft) {
      drafts.push(draft);
    }
  });

  view.open(validDraftFixture({
    password: 'root-secret',
    assignment: {
      ...validDraftFixture().assignment,
      password: 'assignment-secret',
      identitySnapshot: {
        displayName: '',
        email: 'you@test.com',
        apiKey: 'snapshot-secret'
      }
    }
  }));

  assert.equal(document.querySelector('[data-action="wizard-next"]').disabled, true);
  assert.equal(document.querySelector('input[type="password"]'), null);
  assert.doesNotMatch(document.querySelector('[data-batch-wizard]').textContent, /secret/);

  change(document, '[name="identityId"]', 'fixture-identity');
  assert.equal(drafts.at(-1).assignment.identityId, 'fixture-identity');
  assert.doesNotMatch(JSON.stringify(drafts.at(-1)), /secret|password|apiKey/);
});

test('redacts sensitive CSV columns and strips unknown row secrets from every emitted draft', () => {
  const document = wizardDocument();
  const emitted = [];
  const preflight = {
    headers: ['原URL', 'apiKey'],
    summary: {
      raw: 2,
      eligible: 1,
      duplicate: 1,
      blocked: 0,
      invalid: 0,
      included: 1
    },
    rows: [
      {
        rowNumber: 2,
        originalRow: ['https://target.test/1', 'csv-secret-sentinel'],
        url: 'https://target.test/1',
        sourceDomain: 'target.test',
        status: 'eligible',
        reasonCode: 'eligible',
        reason: 'URL 和域名有效',
        included: true,
        overridable: false,
        apiKey: 'row-secret-sentinel'
      },
      {
        rowNumber: 3,
        originalRow: ['https://target.test/1', 'duplicate-secret-sentinel'],
        url: 'https://target.test/1',
        sourceDomain: 'target.test',
        status: 'duplicate',
        reasonCode: 'duplicate_url',
        reason: '重复 URL',
        included: false,
        overridable: true,
        credential: 'credential-secret-sentinel'
      }
    ]
  };
  const view = createBatchWizardView(document, {
    onDraftChange(draft) {
      emitted.push(draft);
    },
    onStart(draft) {
      emitted.push(draft);
    }
  });

  view.open(validDraftFixture({ step: 2, preflight }));
  click(document, '[data-preflight-row="3"] button');
  view.render(validDraftFixture({ step: 4, preflight }));
  click(document, '[data-action="wizard-start"]');

  assert.equal(emitted.length, 2);
  for (const draft of emitted) {
    assert.deepEqual(
      draft.preflight.rows.map((row) => row.originalRow[1]),
      ['[REDACTED]', '[REDACTED]']
    );
    assert.equal(Object.hasOwn(draft.preflight.rows[0], 'apiKey'), false);
    assert.equal(Object.hasOwn(draft.preflight.rows[1], 'credential'), false);
    assert.doesNotMatch(JSON.stringify(draft), /secret-sentinel/);
  }
});

test('sanitizes restored header labels, URLs, and reasons across DOM and callbacks', () => {
  const document = wizardDocument();
  const emitted = [];
  const sensitiveUrl = 'https://target.test/post?view=keep'
    + '&token=url-query-sentinel'
    + '#route?access_token=hash-token-sentinel&panel=comments';
  const ordinaryUrl = 'https://ordinary.test/post?view=thread#comments';
  const preflight = {
    headers: ['原URL', 'apiKey header-label-sentinel', '普通列'],
    rows: [
      {
        rowNumber: 2,
        originalRow: [
          sensitiveUrl,
          'sensitive-column-sentinel',
          'ordinary cell'
        ],
        url: sensitiveUrl,
        sourceDomain: 'target.test',
        status: 'eligible',
        reasonCode: 'eligible',
        reason: 'Provider Bearer reason-bearer-sentinel; '
          + 'token=reason-token-sentinel; '
          + 'token=#reason-hash-token-sentinel&normal=keep; '
          + 'client_secret=#reason-client-secret-sentinel&mode=safe; '
          + '{"client_secret":"reason-json-sentinel","message":"ordinary detail"}',
        included: true,
        overridable: false
      },
      {
        rowNumber: 3,
        originalRow: [ordinaryUrl, 'another-column-sentinel', 'keep cell'],
        url: ordinaryUrl,
        sourceDomain: 'ordinary.test',
        status: 'duplicate',
        reasonCode: 'duplicate_url',
        reason: '普通重复说明保持不变',
        included: false,
        overridable: true
      }
    ],
    summary: {
      raw: 2,
      eligible: 1,
      duplicate: 1,
      blocked: 0,
      invalid: 0,
      included: 1
    }
  };
  const view = createBatchWizardView(document, {
    onDraftChange(draft) {
      emitted.push(draft);
    },
    onStart(draft) {
      emitted.push(draft);
    }
  });

  view.open(validDraftFixture({ step: 2, preflight }));
  const wizardText = document.querySelector('[data-batch-wizard]').textContent;
  assert.doesNotMatch(wizardText, /sentinel/);
  assert.match(wizardText, /view=keep/);
  assert.match(wizardText, /ordinary detail/);
  assert.match(wizardText, /普通重复说明保持不变/);
  click(document, '[data-preflight-row="3"] button');
  view.render(validDraftFixture({ step: 4, preflight }));
  click(document, '[data-action="wizard-start"]');

  assert.equal(emitted.length, 2);
  for (const draft of emitted) {
    assert.doesNotMatch(JSON.stringify(draft), /sentinel/);
    assert.deepEqual(draft.preflight.headers, ['原URL', '敏感列', '普通列']);
    assert.equal(
      draft.preflight.rows[0].url,
      'https://target.test/post?view=keep&token=REDACTED'
        + '#route?access_token=REDACTED&panel=comments'
    );
    assert.equal(draft.preflight.rows[0].originalRow[0], draft.preflight.rows[0].url);
    assert.equal(draft.preflight.rows[0].originalRow[1], '[REDACTED]');
    assert.match(draft.preflight.rows[0].reason, /Bearer REDACTED/);
    assert.match(draft.preflight.rows[0].reason, /token=REDACTED/);
    assert.match(draft.preflight.rows[0].reason, /client_secret":"REDACTED"/);
    assert.match(draft.preflight.rows[0].reason, /normal=keep/);
    assert.match(draft.preflight.rows[0].reason, /mode=safe/);
    assert.match(draft.preflight.rows[0].reason, /ordinary detail/);
    assert.equal(draft.preflight.rows[1].url, ordinaryUrl);
    assert.equal(draft.preflight.rows[1].reason, '普通重复说明保持不变');
    assert.equal(draft.preflight.rows[1].originalRow[2], 'keep cell');
  }
});

test('normalizes malicious restored inclusion flags and recalculates the summary', () => {
  const document = wizardDocument();
  const starts = [];
  const preflight = {
    headers: ['原URL'],
    summary: {
      raw: 99,
      eligible: 0,
      duplicate: 0,
      blocked: 0,
      invalid: 0,
      included: 99
    },
    rows: [
      {
        rowNumber: 2,
        url: 'https://target.test/ok',
        status: 'eligible',
        reason: 'URL 和域名有效',
        included: false,
        overridable: true
      },
      {
        rowNumber: 3,
        url: 'https://blocked.test/',
        status: 'blocked',
        reason: '命中非法站点规则',
        included: true,
        overridable: true
      },
      {
        rowNumber: 4,
        url: null,
        status: 'invalid',
        reason: 'URL 无效',
        included: true,
        overridable: true
      }
    ]
  };
  const view = createBatchWizardView(document, {
    onStart(draft) {
      starts.push(draft);
    }
  });

  view.open(validDraftFixture({ step: 2, preflight }));
  assert.equal(document.querySelector('[data-preflight-row="2"]').dataset.included, 'true');
  assert.equal(document.querySelector('[data-preflight-row="3"]').dataset.included, 'false');
  assert.equal(document.querySelector('[data-preflight-row="4"]').dataset.included, 'false');
  assert.match(document.querySelector('[data-preflight-summary]').textContent, /共 3 行；将处理 1 行/);
  assert.equal(document.querySelector('[data-preflight-row="3"] button'), null);
  assert.equal(document.querySelector('[data-preflight-row="4"] button'), null);

  view.render(validDraftFixture({ step: 4, preflight }));
  click(document, '[data-action="wizard-start"]');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].preflight.summary.included, 1);
  assert.equal(starts[0].preflight.summary.blocked, 1);
  assert.equal(starts[0].preflight.summary.invalid, 1);
  assert.deepEqual(
    starts[0].preflight.rows.map(({ status, included, overridable }) => ({
      status,
      included,
      overridable
    })),
    [
      { status: 'eligible', included: true, overridable: false },
      { status: 'blocked', included: false, overridable: false },
      { status: 'invalid', included: false, overridable: false }
    ]
  );
});

test('renders native file import states and only lets duplicate rows be overridden', () => {
  const document = wizardDocument();
  const parsedFiles = [];
  const drafts = [];
  const view = createBatchWizardView(document, {
    onParseFile(file) {
      parsedFiles.push(file);
    },
    onDraftChange(draft) {
      drafts.push(draft);
    }
  });

  view.open(validDraftFixture({
    step: 2,
    parseError: 'CSV 无法解析'
  }));
  const input = document.querySelector('input[type="file"][accept*=".csv"]');
  assert.ok(input);
  assert.equal(document.querySelector('[data-import-drop-zone]').getAttribute('for'), input.id);
  assert.match(document.querySelector('[data-parse-error]').textContent, /CSV 无法解析/);
  assert.match(document.querySelector('[data-preflight-empty]').textContent, /尚未导入/);

  const file = { name: 'fixture.csv' };
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  input.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
  assert.equal(parsedFiles[0], file);

  view.render(validDraftFixture({
    step: 2,
    preflight: preflightWithExcludedRows()
  }));
  assert.equal(
    document.querySelector('[data-preflight-row="7"] button').textContent,
    '包含此重复项'
  );
  click(document, '[data-preflight-row="7"] button');

  assert.equal(drafts.at(-1).preflight.rows.find((row) => row.rowNumber === 7).included, true);
  assert.equal(drafts.at(-1).preflight.summary.included, 6);
  assert.equal(document.querySelector('[data-preflight-row="7"]').dataset.included, 'true');
  assert.equal(document.querySelector('[data-preflight-row="8"] button'), null);
});

test('clamps execution settings and enforces auto-submit implies auto-generate', () => {
  const document = wizardDocument();
  const drafts = [];
  const view = createBatchWizardView(document, {
    onDraftChange(draft) {
      drafts.push(draft);
    }
  });

  view.open(validDraftFixture({
    step: 3,
    settings: {
      autoOpenPanel: false,
      autoGenerate: false,
      autoSubmit: false,
      concurrency: 3,
      timeoutSeconds: 60
    }
  }));

  change(document, '[name="concurrency"]', '99');
  assert.equal(drafts.at(-1).settings.concurrency, 10);
  change(document, '[name="timeoutSeconds"]', '1');
  assert.equal(drafts.at(-1).settings.timeoutSeconds, 10);
  change(document, '[name="autoSubmit"]', undefined, true);
  assert.equal(drafts.at(-1).settings.autoSubmit, true);
  assert.equal(drafts.at(-1).settings.autoGenerate, true);

  change(document, '[name="autoGenerate"]', undefined, false);
  assert.equal(drafts.at(-1).settings.autoGenerate, false);
  assert.equal(drafts.at(-1).settings.autoSubmit, false);
  assert.equal(document.querySelector('[name="concurrency"]').min, '1');
  assert.equal(document.querySelector('[name="concurrency"]').max, '10');
  assert.equal(document.querySelector('[name="timeoutSeconds"]').min, '10');
  assert.equal(document.querySelector('[name="timeoutSeconds"]').max, '600');
});

test('uses final readiness validation to block start with an actionable error', () => {
  const document = wizardDocument();
  let readinessError = '请先保存模型配置';
  const view = createBatchWizardView(document, {
    getReadinessError() {
      return readinessError;
    }
  });

  view.open(validDraftFixture({
    step: 4,
    preflight: preflightWithExcludedRows()
  }));
  assert.equal(document.querySelector('[data-action="wizard-start"]').disabled, true);
  assert.match(document.querySelector('[data-readiness-error]').textContent, /模型配置/);

  readinessError = '';
  view.render(validDraftFixture({
    step: 4,
    preflight: preflightWithExcludedRows()
  }));
  assert.equal(document.querySelector('[data-action="wizard-start"]').disabled, false);
});

test('traps focus while open, restores the trigger, and cancels on Escape', () => {
  const document = wizardDocument();
  const trigger = document.querySelector('[data-action="new-batch"]');
  let cancelCount = 0;
  trigger.focus();
  const view = createBatchWizardView(document, {
    onCancel() {
      cancelCount += 1;
    }
  });

  view.open(validDraftFixture());
  const close = document.querySelector('[data-wizard-close]');
  assert.equal(document.querySelector('[data-batch-wizard]').getAttribute('role'), 'dialog');
  assert.equal(document.querySelector('[data-batch-wizard]').getAttribute('aria-modal'), 'true');
  assert.equal(document.activeElement, close);

  close.dispatchEvent(new document.defaultView.KeyboardEvent('keydown', {
    bubbles: true,
    key: 'Tab',
    shiftKey: true
  }));
  assert.equal(document.activeElement, document.querySelector('[data-action="wizard-next"]'));

  document.activeElement.dispatchEvent(new document.defaultView.KeyboardEvent('keydown', {
    bubbles: true,
    key: 'Tab'
  }));
  assert.equal(document.activeElement, close);

  document.querySelector('[data-batch-wizard]').dispatchEvent(
    new document.defaultView.KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Escape'
    })
  );
  assert.equal(cancelCount, 1);
  assert.equal(document.querySelector('[data-batch-wizard]').hasAttribute('open'), false);
  assert.equal(document.activeElement, trigger);
});

test('keeps focus inside the dialog across step, field, and duplicate rerenders', () => {
  const document = wizardDocument();
  const view = createBatchWizardView(document);
  view.open(validDraftFixture());

  const identity = document.querySelector('[name="identityId"]');
  identity.focus();
  change(document, '[name="identityId"]', 'updated-identity');
  assert.equal(document.activeElement, document.querySelector('[name="identityId"]'));
  assert.equal(document.querySelector('[data-batch-wizard]').contains(document.activeElement), true);

  click(document, '[data-action="wizard-next"]');
  assert.equal(document.activeElement, document.querySelector('#batch-wizard-step-2'));
  assert.equal(document.querySelector('[data-batch-wizard]').contains(document.activeElement), true);

  view.render(validDraftFixture({
    step: 2,
    preflight: preflightWithExcludedRows()
  }));
  const duplicate = document.querySelector('[data-preflight-row="7"] button');
  duplicate.focus();
  click(document, '[data-preflight-row="7"] button');
  assert.equal(
    document.activeElement,
    document.querySelector('[data-preflight-row="7"] button')
  );
  assert.equal(document.querySelector('[data-batch-wizard]').contains(document.activeElement), true);
});

test('fallback dialog isolates background focus and restores prior attributes on close', () => {
  const document = wizardDocument();
  const trigger = document.querySelector('[data-action="new-batch"]');
  const background = document.createElement('button');
  background.textContent = '背景操作';
  background.setAttribute('aria-hidden', 'false');
  document.body.insertBefore(background, document.querySelector('[data-batch-wizard]'));
  trigger.focus();
  const view = createBatchWizardView(document);

  view.open(validDraftFixture());
  assert.equal(background.hasAttribute('inert'), true);
  assert.equal(background.getAttribute('aria-hidden'), 'true');
  background.focus();
  assert.equal(document.querySelector('[data-batch-wizard]').contains(document.activeElement), true);

  view.close();
  assert.equal(background.hasAttribute('inert'), false);
  assert.equal(background.getAttribute('aria-hidden'), 'false');
  assert.equal(document.activeElement, trigger);

  view.open(validDraftFixture());
  assert.equal(background.hasAttribute('inert'), true);
  view.destroy();
  assert.equal(background.hasAttribute('inert'), false);
  assert.equal(background.getAttribute('aria-hidden'), 'false');
  assert.equal(document.activeElement, trigger);
});
