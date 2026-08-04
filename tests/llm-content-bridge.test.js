const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildPageUserPrompt, generate } = require('../lib/llm-content-bridge.js');

test('returns trimmed generated text from the background service', async () => {
  const runtime = {
    async sendMessage(message) {
      assert.deepEqual(message, {
        type: 'LLM_GENERATE_COPY',
        payload: { systemPrompt: 'system', userPrompt: 'page' }
      });
      return { success: true, text: ' useful comment ' };
    }
  };

  assert.equal(await generate(runtime, { systemPrompt: 'system', userPrompt: 'page' }), 'useful comment');
});

test('preserves a stable background error code', async () => {
  const runtime = {
    async sendMessage() {
      return { success: false, error: { code: 'RATE_LIMITED', message: '请求过于频繁' } };
    }
  };

  await assert.rejects(
    generate(runtime, { systemPrompt: 'system', userPrompt: 'page' }),
    { code: 'RATE_LIMITED' }
  );
});

test('rejects an empty successful response', async () => {
  const runtime = { async sendMessage() { return { success: true, text: '   ' }; } };

  await assert.rejects(
    generate(runtime, { systemPrompt: 'system', userPrompt: 'page' }),
    { code: 'INVALID_RESPONSE' }
  );
});

test('builds a bounded page prompt from title URL description and normalized body text', () => {
  const prompt = buildPageUserPrompt({
    websiteUrl: 'https://example.test/post',
    title: 'Article',
    description: 'Description',
    bodyText: `first\n\n second\tthird ${'x'.repeat(5000)}`
  });

  assert.match(prompt, /Article/);
  assert.match(prompt, /https:\/\/example\.test\/post/);
  assert.match(prompt, /Description/);
  assert.match(prompt, /first second third/);
  assert.equal(prompt.includes('x'.repeat(4001)), false);
  assert.equal(/provider|account|points/i.test(prompt), false);
});

test('loads the bridge before content code and routes every generation through it', () => {
  const root = path.resolve(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');

  assert.deepEqual(manifest.content_scripts[0].js, [
    'lib/content-runtime-bootstrap.js',
    'illegal-site-filter.js',
    'lib/outlink-export-rules.js',
    'lib/llm-content-bridge.js',
    'lib/batch-task-config.js',
    'lib/batch-handle-dispatch.js',
    'lib/batch-submit-context-client.js',
    'lib/comment-history-capture.js',
    'lib/batch-phase-reporter.js',
    'content.js'
  ]);
  assert.equal((content.match(/generatePromotionCopyWithLlm\(\)/g) || []).length, 4);
  assert.match(content, /AutoCommentLlmBridge\.buildPageUserPrompt/);
  assert.match(content, /AutoCommentLlmBridge\.generate\(chrome\.runtime/);
  assert.doesNotMatch(content, /QWEN_API_BASE|USER_ID_STORAGE_KEY|POINTS_API_BASE|getPointsBalance|deductPoints|refund-points|jieyunsang/);
});
