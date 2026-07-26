import {
  parseBatchCsv,
  preflightBatchRows
} from '../../lib/batch-preflight.mjs';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function parseFixtureCsv(text) {
  const data = [];
  const errors = [];
  let row = [];
  let value = '';
  let quoted = false;
  const source = String(text || '').replace(/^\uFEFF/, '');

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') {
      if (quoted && source[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (character === ',' && !quoted) {
      row.push(value);
      value = '';
      continue;
    }
    if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      row.push(value);
      if (row.some((cell) => cell.trim())) data.push(row);
      row = [];
      value = '';
      continue;
    }
    value += character;
  }

  if (quoted) errors.push({ code: 'MissingQuotes', message: 'Unclosed quoted field' });
  row.push(value);
  if (row.some((cell) => cell.trim())) data.push(row);
  return { data, errors };
}

function initialDraft() {
  return {
    step: 1,
    assignment: {
      identityId: 'default-identity',
      promotionSiteId: 'default-promotion-site',
      identitySnapshot: {
        displayName: 'Fixture User',
        email: 'fixture@example.test'
      },
      promotionSiteSnapshot: {
        label: 'fixture-promo.test',
        url: 'https://fixture-promo.test/',
        contentSummary: '普通 HTTP 标签页中的本地确定性配置'
      }
    },
    preflight: null,
    settings: {
      autoOpenPanel: false,
      autoGenerate: true,
      autoSubmit: false,
      concurrency: 3,
      timeoutSeconds: 60
    },
    readinessError: '',
    parseError: ''
  };
}

function evaluateFixtureUrl(url) {
  const hostname = new URL(url).hostname;
  if (hostname === 'blocked.test' || hostname.endsWith('.blocked.test')) {
    return {
      blocked: true,
      code: 'illegal_site',
      reason: '命中 fixture 非法站点规则'
    };
  }
  return { blocked: false };
}

export function createBatchConsoleFixtureAdapter() {
  let savedDraft = initialDraft();

  const application = {
    loadDraft() {
      return clone(savedDraft);
    },
    saveDraft(draft) {
      savedDraft = clone(draft);
      return clone(savedDraft);
    },
    async parseFile(file) {
      if (!file || typeof file.text !== 'function') {
        throw new Error('csv_file_unreadable');
      }
      const parsed = parseBatchCsv(await file.text(), parseFixtureCsv);
      return {
        preflight: preflightBatchRows(parsed, {
          evaluateUrl: evaluateFixtureUrl
        }),
        parseError: ''
      };
    },
    getReadinessError(draft) {
      const included = draft?.preflight?.rows?.filter((row) => (
        row.included === true
        && ['eligible', 'duplicate'].includes(row.status)
      )).length || 0;
      return included > 0 ? '' : '请先导入至少一条可处理 URL';
    }
  };

  const controller = {
    async start(draft) {
      const total = draft?.preflight?.rows?.filter((row) => (
        row.included === true
        && ['eligible', 'duplicate'].includes(row.status)
      )).length || 0;
      if (total === 0) throw new Error('fixture_batch_empty');
      return {
        command: 'start',
        batchId: 'fixture-batch-001',
        status: 'completed',
        counts: {
          total,
          success: total,
          failed: 0
        }
      };
    }
  };

  return { application, controller };
}
