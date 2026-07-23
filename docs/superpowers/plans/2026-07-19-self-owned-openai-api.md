# 自有 OpenAI 兼容 API 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把浏览器插件从原作者积分/Qwen 服务改造成由后台 Service Worker 直接调用用户自有 OpenAI 兼容 API 的独立插件，默认使用 OpenRouter `qwen/qwen-plus`，同时允许填写任意 OpenRouter 模型 ID。

**Architecture:** 新增可独立测试的配置模块、OpenAI 兼容客户端、后台消息服务和内容脚本桥接层。API Key 只进入 `chrome.storage.local`，模型网络请求只从 `background.js` 发出；设置页和批量页移除全部原作者账户、积分、购买和统计依赖。

**Tech Stack:** Chrome Extension Manifest V3、原生 JavaScript/ES Modules、Chrome Storage/Permissions/Runtime APIs、Node.js `node:test`、OpenRouter OpenAI-compatible Chat Completions API、真实 Google Chrome 验收。

## Global Constraints

- API Base URL 默认值必须是 `https://openrouter.ai/api/v1`。
- 模型默认值必须是 `qwen/qwen-plus`，但不得写死 Qwen 专属判断；任意有效 OpenRouter 模型 ID 都能保存和调用。
- API Key 只能保存在 `chrome.storage.local`，不得进入 `chrome.storage.sync`、配置导出、Git、日志或测试夹具。
- 收费生成请求不得自动重试。
- 插件活动代码不得请求 `jieyunsang.cn`、DashScope、作者积分、购买、退款或运行统计接口。
- 浏览器验收只能向本地测试表单提交评论，不得向公开第三方博客发布测试内容。
- 所有产品代码必须遵循红—绿—重构；每个新增函数先有失败测试。
- 所有开发继续在 `/Users/moltbot/Code/autoComment/.worktrees/codex-self-owned-openai-api` 的 `codex/self-owned-openai-api` 分支中进行。

## 文件职责图

- `lib/llm-config.mjs`：模型配置键、默认值、规范化、校验、分层存储、导出清理和主机权限模式。
- `lib/openai-client.mjs`：Chat Completions URL、请求体、网络调用、响应解析和错误映射。
- `lib/llm-service.mjs`：后台消息类型、消息校验、连接测试和正式生成编排。
- `lib/llm-options-controller.mjs`：设置页保存、域名授权和真实连接测试的可测试控制器。
- `lib/llm-content-bridge.js`：经典内容脚本可用的 Runtime 消息桥，并提供 CommonJS 导出供 Node 测试。
- `lib/batch-readiness.mjs`：批量任务启动前的模型配置和 URL 校验。
- `background.js`：接入模型服务消息监听，保留原有批量结果持久化监听。
- `options.html` / `options.js`：自有 API 配置、真实测试连接、密钥隔离及安全导入导出。
- `content.js`：移除积分调用，通过内容脚本桥请求后台模型服务。
- `batch.html` / `batch.js`：移除积分、用户 ID 和作者统计，按本地模型配置控制启动。
- `manifest.json`：加载内容桥、声明 OpenRouter 与可选兼容端点权限。
- `tests/llm-config.test.mjs`：配置和权限逻辑单元测试。
- `tests/openai-client.test.mjs`：OpenAI 兼容协议和错误单元测试。
- `tests/llm-service.test.mjs`：后台服务消息与存储隔离测试。
- `tests/llm-options-controller.test.mjs`：设置页权限、保存和连接测试控制器测试。
- `tests/llm-content-bridge.test.js`：内容脚本桥成功/失败行为测试。
- `tests/batch-readiness.test.mjs`：批量启动门禁测试。
- `tests/fixtures/comment-page.html`：本地评论表单和提交结果页内夹具。
- `scripts/serve-extension-fixture.js`：使用 Node 内置 HTTP 服务提供本地浏览器夹具。

---

### Task 1：模型配置模块与密钥隔离

**Files:**
- Create: `lib/llm-config.mjs`
- Create: `tests/llm-config.test.mjs`

**Interfaces:**
- Produces: `DEFAULT_LLM_CONFIG`、`LLM_SYNC_KEYS`、`LLM_LOCAL_KEYS`、`normalizeLlmConfig(values)`、`validateLlmConfig(config)`、`getHostPermissionPattern(baseUrl)`、`loadLlmConfig(storage)`、`saveLlmConfig(storage, config)`、`toExportableLlmSettings(config)`。
- Consumes: Chrome 风格的 `storage.sync.get/set` 与 `storage.local.get/set` Promise 接口。

- [ ] **Step 1：先写配置、存储分层和导出清理的失败测试**

```js
// tests/llm-config.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LLM_CONFIG,
  LLM_LOCAL_KEYS,
  LLM_SYNC_KEYS,
  getHostPermissionPattern,
  loadLlmConfig,
  normalizeLlmConfig,
  saveLlmConfig,
  toExportableLlmSettings,
  validateLlmConfig
} from '../lib/llm-config.mjs';

function createStorage(syncSeed = {}, localSeed = {}) {
  const sync = { ...syncSeed };
  const local = { ...localSeed };
  const area = (target) => ({
    async get(keys) {
      return Object.fromEntries(keys.filter((key) => key in target).map((key) => [key, target[key]]));
    },
    async set(values) {
      Object.assign(target, values);
    }
  });
  return { storage: { sync: area(sync), local: area(local) }, sync, local };
}

test('uses OpenRouter Qwen-Plus defaults and trims user settings', () => {
  assert.deepEqual(normalizeLlmConfig({}), DEFAULT_LLM_CONFIG);
  assert.deepEqual(normalizeLlmConfig({
    apiBaseUrl: ' https://example.com/v1/ ',
    model: ' openai/gpt-4.1-mini ',
    apiKey: ' secret '
  }), {
    apiBaseUrl: 'https://example.com/v1',
    model: 'openai/gpt-4.1-mini',
    apiKey: 'secret'
  });
});

test('validates only http(s) OpenAI-compatible configuration', () => {
  assert.equal(validateLlmConfig(DEFAULT_LLM_CONFIG).valid, false);
  assert.equal(validateLlmConfig({ ...DEFAULT_LLM_CONFIG, apiKey: 'sk-test' }).valid, true);
  assert.equal(validateLlmConfig({ apiBaseUrl: 'file:///tmp/api', model: 'x', apiKey: 'y' }).code, 'INVALID_API_URL');
});

test('creates an origin-scoped permission pattern', () => {
  assert.equal(getHostPermissionPattern('https://openrouter.ai/api/v1'), 'https://openrouter.ai/*');
  assert.equal(getHostPermissionPattern('http://127.0.0.1:3000/v1'), 'http://127.0.0.1:3000/*');
});

test('stores key locally and exports only non-secret settings', async () => {
  const fixture = createStorage();
  const config = {
    apiBaseUrl: 'https://openrouter.ai/api/v1',
    model: 'qwen/qwen-plus',
    apiKey: 'sk-or-private'
  };
  await saveLlmConfig(fixture.storage, config);
  assert.equal(fixture.sync[LLM_SYNC_KEYS.apiBaseUrl], config.apiBaseUrl);
  assert.equal(fixture.sync[LLM_SYNC_KEYS.model], config.model);
  assert.equal(fixture.sync[LLM_LOCAL_KEYS.apiKey], undefined);
  assert.equal(fixture.local[LLM_LOCAL_KEYS.apiKey], config.apiKey);
  assert.deepEqual(await loadLlmConfig(fixture.storage), config);
  assert.equal(JSON.stringify(toExportableLlmSettings(config)).includes(config.apiKey), false);
});
```

- [ ] **Step 2：运行测试并确认因模块不存在而失败**

Run: `node --test tests/llm-config.test.mjs`

Expected: FAIL，错误包含 `ERR_MODULE_NOT_FOUND` 和 `lib/llm-config.mjs`。

- [ ] **Step 3：实现最小配置模块**

```js
// lib/llm-config.mjs
export const DEFAULT_LLM_CONFIG = Object.freeze({
  apiBaseUrl: 'https://openrouter.ai/api/v1',
  model: 'qwen/qwen-plus',
  apiKey: ''
});

export const LLM_SYNC_KEYS = Object.freeze({
  apiBaseUrl: 'llm_api_base_url',
  model: 'llm_model'
});

export const LLM_LOCAL_KEYS = Object.freeze({ apiKey: 'llm_api_key' });

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeLlmConfig(values = {}) {
  return {
    apiBaseUrl: (clean(values.apiBaseUrl) || DEFAULT_LLM_CONFIG.apiBaseUrl).replace(/\/+$/, ''),
    model: clean(values.model) || DEFAULT_LLM_CONFIG.model,
    apiKey: clean(values.apiKey)
  };
}

export function validateLlmConfig(values) {
  const config = normalizeLlmConfig(values);
  let url;
  try {
    url = new URL(config.apiBaseUrl);
  } catch {
    return { valid: false, code: 'INVALID_API_URL', message: 'API Base URL 格式无效。' };
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    return { valid: false, code: 'INVALID_API_URL', message: 'API Base URL 仅支持 HTTP 或 HTTPS。' };
  }
  if (!config.model) return { valid: false, code: 'MISSING_MODEL', message: '请填写模型 ID。' };
  if (!config.apiKey) return { valid: false, code: 'MISSING_API_KEY', message: '请填写 API Key。' };
  return { valid: true, config };
}

export function getHostPermissionPattern(baseUrl) {
  const url = new URL(normalizeLlmConfig({ apiBaseUrl: baseUrl }).apiBaseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('INVALID_API_URL');
  return `${url.protocol}//${url.host}/*`;
}

export async function loadLlmConfig(storage) {
  const [syncValues, localValues] = await Promise.all([
    storage.sync.get(Object.values(LLM_SYNC_KEYS)),
    storage.local.get(Object.values(LLM_LOCAL_KEYS))
  ]);
  return normalizeLlmConfig({
    apiBaseUrl: syncValues[LLM_SYNC_KEYS.apiBaseUrl],
    model: syncValues[LLM_SYNC_KEYS.model],
    apiKey: localValues[LLM_LOCAL_KEYS.apiKey]
  });
}

export async function saveLlmConfig(storage, values) {
  const validation = validateLlmConfig(values);
  if (!validation.valid) {
    const error = new Error(validation.message);
    error.code = validation.code;
    throw error;
  }
  const config = validation.config;
  await Promise.all([
    storage.sync.set({
      [LLM_SYNC_KEYS.apiBaseUrl]: config.apiBaseUrl,
      [LLM_SYNC_KEYS.model]: config.model
    }),
    storage.local.set({ [LLM_LOCAL_KEYS.apiKey]: config.apiKey })
  ]);
  return config;
}

export function toExportableLlmSettings(values) {
  const config = normalizeLlmConfig(values);
  return {
    [LLM_SYNC_KEYS.apiBaseUrl]: config.apiBaseUrl,
    [LLM_SYNC_KEYS.model]: config.model
  };
}
```

- [ ] **Step 4：运行配置测试并确认通过**

Run: `node --test tests/llm-config.test.mjs`

Expected: PASS，4 tests，0 failures。

- [ ] **Step 5：提交配置模块**

```bash
git add lib/llm-config.mjs tests/llm-config.test.mjs
git commit -m "feat: add secure model configuration"
```

---

### Task 2：OpenAI 兼容客户端和稳定错误

**Files:**
- Create: `lib/openai-client.mjs`
- Create: `tests/openai-client.test.mjs`

**Interfaces:**
- Consumes: `{ apiBaseUrl, model, apiKey }` 与 OpenAI 兼容 `messages`。
- Produces: `getChatCompletionsUrl(baseUrl)`、`buildChatCompletionBody(model, messages, maxTokens)`、`extractCompletionText(payload)`、`requestChatCompletion(options)`、`LlmApiError`、`toPublicLlmError(error)`。

- [ ] **Step 1：写 URL、任意模型、响应解析和错误映射失败测试**

```js
// tests/openai-client.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildChatCompletionBody,
  extractCompletionText,
  getChatCompletionsUrl,
  requestChatCompletion,
  toPublicLlmError
} from '../lib/openai-client.mjs';

test('appends chat/completions exactly once', () => {
  assert.equal(getChatCompletionsUrl('https://openrouter.ai/api/v1'), 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(getChatCompletionsUrl('https://host/v1/chat/completions/'), 'https://host/v1/chat/completions');
});

test('passes arbitrary OpenRouter model IDs without Qwen branching', () => {
  const body = buildChatCompletionBody('openrouter/auto', [{ role: 'user', content: 'OK' }], 16);
  assert.deepEqual(body, {
    model: 'openrouter/auto',
    messages: [{ role: 'user', content: 'OK' }],
    stream: false,
    max_tokens: 16
  });
});

test('extracts assistant text and rejects malformed success payloads', () => {
  assert.equal(extractCompletionText({ choices: [{ message: { content: ' hello ' } }] }), 'hello');
  assert.throws(() => extractCompletionText({ choices: [] }), { code: 'INVALID_RESPONSE' });
});

test('sends bearer auth and maps 402 without exposing the key', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({ error: { message: 'Insufficient credits' } }), {
      status: 402,
      headers: { 'Content-Type': 'application/json' }
    });
  };
  await assert.rejects(requestChatCompletion({
    config: { apiBaseUrl: 'https://openrouter.ai/api/v1', model: 'qwen/qwen-plus', apiKey: 'sk-secret' },
    messages: [{ role: 'user', content: 'test' }],
    fetchImpl
  }), { code: 'INSUFFICIENT_CREDITS', status: 402 });
  assert.equal(captured.init.headers.Authorization, 'Bearer sk-secret');
  assert.equal(JSON.stringify(toPublicLlmError(new Error('sk-secret'))).includes('sk-secret'), false);
});
```

- [ ] **Step 2：运行测试并确认缺少客户端模块**

Run: `node --test tests/openai-client.test.mjs`

Expected: FAIL，`ERR_MODULE_NOT_FOUND`。

- [ ] **Step 3：实现非流式客户端、60 秒超时和无重试错误映射**

```js
// lib/openai-client.mjs
const STATUS_CODES = new Map([
  [401, ['INVALID_API_KEY', 'API Key 无效。']],
  [402, ['INSUFFICIENT_CREDITS', '模型服务余额不足。']],
  [403, ['FORBIDDEN', '模型服务拒绝了请求。']],
  [408, ['TIMEOUT', '模型请求超时。']],
  [429, ['RATE_LIMITED', '模型请求过于频繁，请稍后重试。']],
  [502, ['PROVIDER_UNAVAILABLE', '模型上游暂时不可用。']],
  [503, ['PROVIDER_UNAVAILABLE', '模型或服务商暂时不可用。']]
]);

export class LlmApiError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.name = 'LlmApiError';
    this.code = code;
    this.status = status;
  }
}

export function getChatCompletionsUrl(baseUrl) {
  const clean = String(baseUrl || '').trim().replace(/\/+$/, '');
  return clean.endsWith('/chat/completions') ? clean : `${clean}/chat/completions`;
}

export function buildChatCompletionBody(model, messages, maxTokens) {
  const body = { model, messages, stream: false };
  if (Number.isInteger(maxTokens) && maxTokens > 0) body.max_tokens = maxTokens;
  return body;
}

export function extractCompletionText(payload) {
  const text = payload?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) {
    throw new LlmApiError('INVALID_RESPONSE', '模型返回了无效或空的生成结果。');
  }
  return text.trim();
}

function providerMessage(payload) {
  const value = payload?.error?.message;
  return typeof value === 'string' ? value.slice(0, 300) : '';
}

export async function requestChatCompletion({ config, messages, maxTokens, fetchImpl = fetch, timeoutMs = 60000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(getChatCompletionsUrl(config.apiBaseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify(buildChatCompletionBody(config.model, messages, maxTokens)),
      signal: controller.signal
    });
    const raw = await response.text();
    let payload;
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      throw new LlmApiError('INVALID_RESPONSE', '模型服务返回了无法解析的 JSON。', response.status);
    }
    if (!response.ok) {
      const [code, fallback] = STATUS_CODES.get(response.status) || ['API_ERROR', '模型服务请求失败。'];
      const detail = providerMessage(payload);
      throw new LlmApiError(code, detail ? `${fallback} ${detail}` : fallback, response.status);
    }
    return extractCompletionText(payload);
  } catch (error) {
    if (error?.name === 'AbortError') throw new LlmApiError('TIMEOUT', '模型请求超时。');
    if (error instanceof LlmApiError) throw error;
    throw new LlmApiError('NETWORK_ERROR', '无法连接模型服务。');
  } finally {
    clearTimeout(timer);
  }
}

export function toPublicLlmError(error) {
  const known = error instanceof LlmApiError;
  return {
    code: known ? error.code : 'UNKNOWN_ERROR',
    message: known ? error.message : '模型请求失败，请检查配置后重试。',
    status: known ? error.status : null
  };
}
```

- [ ] **Step 4：运行客户端测试与配置测试**

Run: `node --test tests/openai-client.test.mjs tests/llm-config.test.mjs`

Expected: PASS，8 tests，0 failures。

- [ ] **Step 5：提交客户端**

```bash
git add lib/openai-client.mjs tests/openai-client.test.mjs
git commit -m "feat: add OpenAI-compatible model client"
```

---

### Task 3：后台模型服务与消息边界

**Files:**
- Create: `lib/llm-service.mjs`
- Create: `tests/llm-service.test.mjs`
- Modify: `background.js:1-106`

**Interfaces:**
- Consumes: `LLM_TEST_CONNECTION` 或 `LLM_GENERATE_COPY` 消息、Chrome Storage、可注入的 `fetchImpl`。
- Produces: `handleLlmMessage(message, dependencies)`，返回 `{ success: true, text }` 或 `{ success: false, error }`。

- [ ] **Step 1：写连接测试、生成和超长消息失败测试**

```js
// tests/llm-service.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleLlmMessage, isAllowedLlmSender, LLM_MESSAGE_TYPES } from '../lib/llm-service.mjs';

function storageFixture() {
  return {
    sync: { async get() { return { llm_api_base_url: 'https://openrouter.ai/api/v1', llm_model: 'qwen/qwen-plus' }; } },
    local: { async get() { return { llm_api_key: 'sk-test' }; } }
  };
}

const successFetch = async () => new Response(JSON.stringify({
  choices: [{ message: { content: 'generated comment' } }]
}), { status: 200 });

test('connection test uses the saved model and a small real-request shape', async () => {
  const result = await handleLlmMessage({ type: LLM_MESSAGE_TYPES.test }, { storage: storageFixture(), fetchImpl: successFetch });
  assert.deepEqual(result, { success: true, text: 'generated comment' });
});

test('generation accepts bounded system and user prompts', async () => {
  const result = await handleLlmMessage({
    type: LLM_MESSAGE_TYPES.generate,
    payload: { systemPrompt: 'system', userPrompt: 'page context' }
  }, { storage: storageFixture(), fetchImpl: successFetch });
  assert.equal(result.success, true);
});

test('generation rejects oversized page messages before network access', async () => {
  let called = false;
  const result = await handleLlmMessage({
    type: LLM_MESSAGE_TYPES.generate,
    payload: { systemPrompt: 'x', userPrompt: 'y'.repeat(25001) }
  }, { storage: storageFixture(), fetchImpl: async () => { called = true; } });
  assert.equal(called, false);
  assert.equal(result.error.code, 'INVALID_REQUEST');
});

test('accepts only messages sent by this extension', () => {
  assert.equal(isAllowedLlmSender({ id: 'extension-id' }, 'extension-id'), true);
  assert.equal(isAllowedLlmSender({ id: 'other-extension' }, 'extension-id'), false);
  assert.equal(isAllowedLlmSender({}, 'extension-id'), false);
});
```

- [ ] **Step 2：运行测试并确认缺少服务模块**

Run: `node --test tests/llm-service.test.mjs`

Expected: FAIL，`ERR_MODULE_NOT_FOUND`。

- [ ] **Step 3：实现后台服务并只暴露两种模型消息**

```js
// lib/llm-service.mjs
import { loadLlmConfig, validateLlmConfig } from './llm-config.mjs';
import { LlmApiError, requestChatCompletion, toPublicLlmError } from './openai-client.mjs';

export const LLM_MESSAGE_TYPES = Object.freeze({
  test: 'LLM_TEST_CONNECTION',
  generate: 'LLM_GENERATE_COPY'
});

export function isAllowedLlmSender(sender, extensionId) {
  return Boolean(sender && sender.id && sender.id === extensionId);
}

export async function handleLlmMessage(message, { storage, fetchImpl = fetch }) {
  try {
    const config = await loadLlmConfig(storage);
    const validation = validateLlmConfig(config);
    if (!validation.valid) throw new LlmApiError(validation.code, validation.message);

    if (message?.type === LLM_MESSAGE_TYPES.test) {
      const text = await requestChatCompletion({
        config,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        maxTokens: 16,
        fetchImpl
      });
      return { success: true, text };
    }

    if (message?.type !== LLM_MESSAGE_TYPES.generate) {
      throw new LlmApiError('INVALID_REQUEST', '未知的模型请求类型。');
    }

    const systemPrompt = typeof message.payload?.systemPrompt === 'string' ? message.payload.systemPrompt.trim() : '';
    const userPrompt = typeof message.payload?.userPrompt === 'string' ? message.payload.userPrompt.trim() : '';
    if (!systemPrompt || !userPrompt || systemPrompt.length > 12000 || userPrompt.length > 24000) {
      throw new LlmApiError('INVALID_REQUEST', '模型提示词为空或超出长度限制。');
    }

    const text = await requestChatCompletion({
      config,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      fetchImpl
    });
    return { success: true, text };
  } catch (error) {
    return { success: false, error: toPublicLlmError(error) };
  }
}
```

- [ ] **Step 4：在 background.js 顶部导入服务并增加来源校验监听**

```js
import { handleLlmMessage, isAllowedLlmSender, LLM_MESSAGE_TYPES } from './lib/llm-service.mjs';

const LLM_MESSAGE_TYPE_SET = new Set(Object.values(LLM_MESSAGE_TYPES));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!LLM_MESSAGE_TYPE_SET.has(message?.type)) return false;
  if (!isAllowedLlmSender(sender, chrome.runtime.id)) {
    sendResponse({ success: false, error: { code: 'FORBIDDEN_SENDER', message: '拒绝外部模型请求。' } });
    return false;
  }
  handleLlmMessage(message, { storage: chrome.storage })
    .then(sendResponse)
    .catch(() => sendResponse({ success: false, error: { code: 'UNKNOWN_ERROR', message: '模型请求失败。' } }));
  return true;
});
```

- [ ] **Step 5：运行服务测试、全量测试和后台语法检查**

Run: `node --test tests/llm-service.test.mjs tests/openai-client.test.mjs tests/llm-config.test.mjs && node --input-type=module --check < background.js && npm test`

Expected: 新增测试全部 PASS；现有 3 项测试 PASS；0 failures。

- [ ] **Step 6：提交后台服务**

```bash
git add lib/llm-service.mjs tests/llm-service.test.mjs background.js
git commit -m "feat: route model requests through extension background"
```

---

### Task 4：设置页模型配置、真实连接测试和安全导出

**Files:**
- Create: `lib/llm-options-controller.mjs`
- Create: `tests/llm-options-controller.test.mjs`
- Modify: `options.html:170-212,320-328,349`
- Modify: `options.js:1-613`
- Modify: `manifest.json:6-29`
- Modify: `index.html:89-102,151-177,190-202,241-276`

**Interfaces:**
- Consumes: `loadLlmConfig`、`saveLlmConfig`、`getHostPermissionPattern`、`LLM_SYNC_KEYS` 和 `LLM_TEST_CONNECTION`。
- Produces: `saveOptionsModelConfig(dependencies, values)` 和 `testOptionsModelConfig(dependencies, values)`；保存 Base URL/模型/本地 Key、按目标 Origin 申请权限、真实测试连接、导出不含 Key。

- [ ] **Step 1：扩展配置测试，先证明导出键只包含 Base URL 和模型**

```js
// 追加到 tests/llm-config.test.mjs
test('export payload never exposes local key storage name', () => {
  const exported = toExportableLlmSettings({
    apiBaseUrl: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-sonnet-4',
    apiKey: 'sk-private'
  });
  assert.deepEqual(Object.keys(exported).sort(), Object.values(LLM_SYNC_KEYS).sort());
  assert.equal(JSON.stringify(exported).includes('llm_api_key'), false);
});
```

同时创建设置控制器的失败测试：

```js
// tests/llm-options-controller.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { saveOptionsModelConfig, testOptionsModelConfig } from '../lib/llm-options-controller.mjs';

function dependencies({ granted = true, response = { success: true, text: 'OK' } } = {}) {
  const sync = {};
  const local = {};
  return {
    sync,
    local,
    value: {
      storage: {
        sync: { async get() { return sync; }, async set(values) { Object.assign(sync, values); } },
        local: { async get() { return local; }, async set(values) { Object.assign(local, values); } }
      },
      permissions: {
        async contains() { return false; },
        async request(request) {
          assert.deepEqual(request, { origins: ['https://openrouter.ai/*'] });
          return granted;
        }
      },
      runtime: { async sendMessage(message) {
        assert.deepEqual(message, { type: 'LLM_TEST_CONNECTION' });
        return response;
      } }
    }
  };
}

const config = { apiBaseUrl: 'https://openrouter.ai/api/v1', model: 'qwen/qwen-plus', apiKey: 'sk-test' };

test('requests only the configured origin then saves split storage', async () => {
  const fixture = dependencies();
  await saveOptionsModelConfig(fixture.value, config);
  assert.equal(fixture.sync.llm_model, 'qwen/qwen-plus');
  assert.equal(fixture.local.llm_api_key, 'sk-test');
});

test('does not save when the user denies host permission', async () => {
  const fixture = dependencies({ granted: false });
  await assert.rejects(saveOptionsModelConfig(fixture.value, config), { code: 'PERMISSION_DENIED' });
  assert.deepEqual(fixture.sync, {});
  assert.deepEqual(fixture.local, {});
});

test('saves then runs the real connection message contract', async () => {
  const fixture = dependencies();
  assert.equal(await testOptionsModelConfig(fixture.value, config), 'OK');
});
```

- [ ] **Step 2：运行新增测试并确认当前导出集成尚不存在**

Run: `node --test tests/llm-config.test.mjs tests/llm-options-controller.test.mjs`

Expected: 配置测试 PASS；控制器测试因 `lib/llm-options-controller.mjs` 不存在而 FAIL；`rg -n "llm_api_base_url|llm_model" options.js options.html` 无匹配。

- [ ] **Step 3：实现设置页控制器并让失败测试转绿**

```js
// lib/llm-options-controller.mjs
import { getHostPermissionPattern, saveLlmConfig } from './llm-config.mjs';

async function ensurePermission(permissions, apiBaseUrl) {
  const origins = [getHostPermissionPattern(apiBaseUrl)];
  if (await permissions.contains({ origins })) return;
  if (!await permissions.request({ origins })) {
    const error = new Error('未授予模型 API 域名访问权限。');
    error.code = 'PERMISSION_DENIED';
    throw error;
  }
}

export async function saveOptionsModelConfig({ storage, permissions }, values) {
  await ensurePermission(permissions, values.apiBaseUrl);
  return saveLlmConfig(storage, values);
}

export async function testOptionsModelConfig(dependencies, values) {
  await saveOptionsModelConfig(dependencies, values);
  const response = await dependencies.runtime.sendMessage({ type: 'LLM_TEST_CONNECTION' });
  if (!response?.success) {
    const error = new Error(response?.error?.message || '连接测试失败。');
    error.code = response?.error?.code || 'UNKNOWN_ERROR';
    throw error;
  }
  return String(response.text || '').trim();
}
```

Run: `node --test tests/llm-config.test.mjs tests/llm-options-controller.test.mjs`

Expected: 全部测试 PASS，0 failures。

- [ ] **Step 4：用模型配置卡替换用户 ID、积分和购买卡，并删除联系作者卡**

```html
<div style="margin-bottom:20px;padding:14px 16px;background:#eff6ff;border-radius:10px;border:1px solid #bfdbfe;">
  <div style="font-size:14px;font-weight:700;color:#1d4ed8;">自有模型 API</div>
  <div class="hint" style="margin:6px 0 12px;">默认使用 OpenRouter，可填写任意 OpenRouter 模型 ID 或其他 OpenAI 兼容地址。</div>
  <label for="llmApiBaseUrl">API Base URL</label>
  <input id="llmApiBaseUrl" type="url" value="https://openrouter.ai/api/v1" autocomplete="off" />
  <label for="llmApiKey" style="margin-top:10px;">API Key</label>
  <input id="llmApiKey" type="password" autocomplete="off" placeholder="sk-or-v1-..." />
  <label for="llmModel" style="margin-top:10px;">模型 ID</label>
  <input id="llmModel" type="text" value="qwen/qwen-plus" autocomplete="off" />
  <div class="row">
    <button id="saveLlmConfigBtn" class="btn btn-primary" type="button">保存模型配置</button>
    <button id="testLlmConnectionBtn" class="btn btn-secondary" type="button">测试连接</button>
    <span id="llmStatus" class="status"></span>
  </div>
</div>
```

同时把副标题改成“在这里配置自有模型 API、推广网站信息和自动填表信息”，删除 `userId`、`savePointsBtn`、`pointsBalance`、`openPaymentBtn`、购买状态和联系作者节点，并把脚本改成模块：

```html
<script type="module" src="options.js"></script>
```

- [ ] **Step 5：在 options.js 导入控制器并绑定保存与真实测试**

```js
import {
  DEFAULT_LLM_CONFIG,
  LLM_SYNC_KEYS,
  loadLlmConfig
} from './lib/llm-config.mjs';
import { saveOptionsModelConfig, testOptionsModelConfig } from './lib/llm-options-controller.mjs';

const modelDependencies = {
  storage: chrome.storage,
  permissions: chrome.permissions,
  runtime: chrome.runtime
};

saveLlmConfigBtn.addEventListener('click', async () => {
  try {
    await saveOptionsModelConfig(modelDependencies, {
      apiBaseUrl: llmApiBaseUrlInput.value,
      apiKey: llmApiKeyInput.value,
      model: llmModelInput.value
    });
    showStatus(llmStatusEl, '模型配置已保存');
  } catch (error) {
    showStatus(llmStatusEl, error.message || '模型配置保存失败', 3000);
  }
});

testLlmConnectionBtn.addEventListener('click', async () => {
  testLlmConnectionBtn.disabled = true;
  showStatus(llmStatusEl, '正在真实调用模型…', 60000);
  try {
    const text = await testOptionsModelConfig(modelDependencies, {
      apiBaseUrl: llmApiBaseUrlInput.value,
      apiKey: llmApiKeyInput.value,
      model: llmModelInput.value
    });
    showStatus(llmStatusEl, `连接成功：${text}`, 5000);
  } catch (error) {
    showStatus(llmStatusEl, error.message || '连接测试失败', 5000);
  } finally {
    testLlmConnectionBtn.disabled = false;
  }
});

const modelConfig = await loadLlmConfig(chrome.storage);
llmApiBaseUrlInput.value = modelConfig.apiBaseUrl || DEFAULT_LLM_CONFIG.apiBaseUrl;
llmModelInput.value = modelConfig.model || DEFAULT_LLM_CONFIG.model;
llmApiKeyInput.value = modelConfig.apiKey;
```

从 `options.js` 删除全部 `USER_ID_STORAGE_KEY`、`POINTS_API_BASE`、积分和购买 DOM 变量、用户 ID 保存监听、积分/购买查询函数及 `openPaymentBtn` 监听。把 `LLM_SYNC_KEYS.apiBaseUrl` 和 `LLM_SYNC_KEYS.model` 加入 `ACTIVE_STORAGE_KEYS`、`IMPORT_COMPAT_STORAGE_KEYS`、导入清理和表单回填；不得加入本地 Key。

把 `CONFIG_VERSION` 从 `2` 升到 `3`。`mergeCurrentFormValues` 可以合并当前 Base URL 和模型输入值，但不得读取或合并 API Key。

- [ ] **Step 6：更新 manifest 权限和模块加载**

```json
{
  "permissions": ["activeTab", "storage"],
  "host_permissions": ["https://openrouter.ai/*"],
  "optional_host_permissions": ["https://*/*", "http://*/*"],
  "content_scripts": [{
    "matches": ["<all_urls>"],
    "js": ["illegal-site-filter.js", "content.js"],
    "run_at": "document_idle"
  }]
}
```

保留现有 `background`、`action`、`options_page` 和内容脚本字段；内容桥在 Task 5 文件创建后再加入加载顺序。删除 DashScope、Vercel 和 `jieyunsang.cn` 主机权限。

- [ ] **Step 7：同步更新隐私说明**

在 `index.html` 的中英文隐私说明中删除用户 ID、积分和内置作者模型服务描述，并明确说明：

```html
<ul>
  <li>Your OpenAI-compatible API base URL and selected model ID</li>
  <li>Your API key, stored only in local Chrome extension storage</li>
  <li>Page title, URL, description, and a bounded text excerpt sent directly to the provider you configure when you request generation</li>
</ul>
```

```html
<ul>
  <li>你配置的 OpenAI 兼容 API 地址和模型 ID。</li>
  <li>你的 API Key；它只保存在本机 Chrome 插件存储中。</li>
  <li>仅在你请求生成时，页面标题、URL、描述和受长度限制的正文节选会直接发送给你配置的模型服务商。</li>
</ul>
```

- [ ] **Step 8：运行单元测试、HTML 引用检查和语法检查**

Run: `node --test tests/llm-config.test.mjs tests/llm-options-controller.test.mjs && node --input-type=module --check < options.js && node -e "JSON.parse(require('node:fs').readFileSync('manifest.json','utf8'))" && ! rg -n "userId|积分|购买 CSV|jieyunsang|openPaymentBtn" options.html options.js index.html`

Expected: 全部命令退出 0；敏感/旧服务检索无匹配。

- [ ] **Step 9：提交设置页改造**

```bash
git add lib/llm-options-controller.mjs tests/llm-options-controller.test.mjs manifest.json options.html options.js index.html tests/llm-config.test.mjs
git commit -m "feat: add self-owned model settings"
```

---

### Task 5：内容脚本桥接与积分调用移除

**Files:**
- Create: `lib/llm-content-bridge.js`
- Create: `tests/llm-content-bridge.test.js`
- Modify: `content.js:360-456,461-497,1007,3076-3141,3328,4007,4117-4142`

**Interfaces:**
- Produces: `AutoCommentLlmBridge.generate(runtime, { systemPrompt, userPrompt })`。
- Consumes: `chrome.runtime.sendMessage` 和 `LLM_GENERATE_COPY` 后台响应。

- [ ] **Step 1：写内容桥成功、错误和空响应失败测试**

```js
// tests/llm-content-bridge.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPageUserPrompt, generate } = require('../lib/llm-content-bridge.js');

test('returns generated text from the background service', async () => {
  const runtime = { async sendMessage(message) {
    assert.equal(message.type, 'LLM_GENERATE_COPY');
    return { success: true, text: ' useful comment ' };
  } };
  assert.equal(await generate(runtime, { systemPrompt: 'system', userPrompt: 'page' }), 'useful comment');
});

test('preserves stable background error code', async () => {
  const runtime = { async sendMessage() {
    return { success: false, error: { code: 'RATE_LIMITED', message: '请求过于频繁' } };
  } };
  await assert.rejects(generate(runtime, { systemPrompt: 'system', userPrompt: 'page' }), { code: 'RATE_LIMITED' });
});

test('rejects empty successful text', async () => {
  const runtime = { async sendMessage() { return { success: true, text: '' }; } };
  await assert.rejects(generate(runtime, { systemPrompt: 'system', userPrompt: 'page' }), { code: 'INVALID_RESPONSE' });
});

test('builds a bounded page prompt without provider-specific fields', () => {
  const prompt = buildPageUserPrompt({
    websiteUrl: 'https://example.test/post',
    title: 'Article',
    description: 'Description',
    bodyText: 'x'.repeat(5000)
  });
  assert.match(prompt, /Article/);
  assert.match(prompt, /https:\/\/example\.test\/post/);
  assert.equal(prompt.includes('x'.repeat(4001)), false);
});
```

- [ ] **Step 2：运行测试并确认缺少桥接模块**

Run: `node --test tests/llm-content-bridge.test.js`

Expected: FAIL，`MODULE_NOT_FOUND`。

- [ ] **Step 3：实现可在内容脚本和 Node 中复用的最小桥接模块**

```js
// lib/llm-content-bridge.js
(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AutoCommentLlmBridge = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createBridge() {
  function buildPageUserPrompt({ websiteUrl, title, description, bodyText }) {
    const excerpt = String(bodyText || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
    return [
      '下面是当前网站的内容，请根据系统提示词生成一份推广评论：',
      `【网站标题】${title || '(无标题)'}`,
      `【网站 URL】${websiteUrl || '(无URL)'}`,
      description ? `【网站描述】${description}` : '',
      '【页面正文节选】',
      excerpt || '(当前页面正文内容为空或无法提取)'
    ].filter(Boolean).join('\n');
  }

  async function generate(runtime, payload) {
    const response = await runtime.sendMessage({ type: 'LLM_GENERATE_COPY', payload });
    if (!response?.success) {
      const error = new Error(response?.error?.message || '模型生成失败。');
      error.code = response?.error?.code || 'UNKNOWN_ERROR';
      throw error;
    }
    const text = typeof response.text === 'string' ? response.text.trim() : '';
    if (!text) {
      const error = new Error('模型返回了空内容。');
      error.code = 'INVALID_RESPONSE';
      throw error;
    }
    return text;
  }
  return { buildPageUserPrompt, generate };
});
```

在 `manifest.json` 中把内容脚本加载顺序改成：

```json
"js": ["illegal-site-filter.js", "lib/llm-content-bridge.js", "content.js"]
```

- [ ] **Step 4：把 content.js 生成函数切换到后台桥，并移除积分/退款**

保留现有页面采集代码，把 `generatePromotionCopyWithQwen` 更名为 `generatePromotionCopyWithLlm`，核心替换为：

```js
async function generatePromotionCopyWithLlm() {
  const systemPrompt = await getQwenSkillTemplate();
  const websiteUrl = window.location.href || '';
  const title = document.title || '';
  const descriptionMeta = document.querySelector('meta[name="description"], meta[name="Description"]');
  const description = descriptionMeta ? descriptionMeta.content || '' : '';
  const bodyText = document.body ? document.body.innerText || '' : '';
  const userPrompt = globalThis.AutoCommentLlmBridge.buildPageUserPrompt({
    websiteUrl,
    title,
    description,
    bodyText
  });
  return globalThis.AutoCommentLlmBridge.generate(chrome.runtime, { systemPrompt, userPrompt });
}
```

把三个调用点改成 `generatePromotionCopyWithLlm()`；删除 `QWEN_API_BASE`、`USER_ID_STORAGE_KEY`、`POINTS_API_BASE`、`POINTS_COST_PER_GENERATION`、`getUserId`、`getPointsBalance`、`deductPoints` 以及 `handleBatchTask` catch 块中的积分补偿代码。删除“空文本表示后端关键词拦截并退回积分”的不可达分支和相关提示，因为新桥会把空响应作为 `INVALID_RESPONSE` 处理。保留旧 `qwen_*` storage key 和面板 DOM ID，以兼容现有用户冷却记录，不再赋予其服务商含义。

- [ ] **Step 5：运行桥测试、脚本语法检查和作者服务扫描**

Run: `node --test tests/llm-content-bridge.test.js && node --check lib/llm-content-bridge.js && node --check content.js && ! rg -n "jieyunsang|POINTS_API_BASE|getPointsBalance|refund-points|auto_comment_user_id" content.js lib/llm-content-bridge.js`

Expected: 4 tests PASS；语法检查通过；旧服务扫描无匹配。

- [ ] **Step 6：提交内容脚本迁移**

```bash
git add manifest.json lib/llm-content-bridge.js tests/llm-content-bridge.test.js content.js
git commit -m "feat: generate comments with the configured model"
```

---

### Task 6：批量流程本地化和作者服务清理

**Files:**
- Create: `lib/batch-readiness.mjs`
- Create: `tests/batch-readiness.test.mjs`
- Modify: `batch.html:618-631,729-740,873-875`
- Modify: `batch.js:1-17,76-78,141-179,474-513,842,889-951,1035-1065`

**Interfaces:**
- Consumes: `loadLlmConfig(chrome.storage)` 与 `getBatchStartError(config, urlCount)`。
- Produces: 可测试的批量启动门禁，以及无用户 ID、积分或作者统计依赖的本地批量处理。

- [ ] **Step 1：增加批量启动所用配置校验回归测试**

```js
// tests/batch-readiness.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { getBatchStartError } from '../lib/batch-readiness.mjs';

test('batch readiness accepts any complete OpenRouter model', () => {
  const config = {
    apiBaseUrl: 'https://openrouter.ai/api/v1',
    model: 'openrouter/auto',
    apiKey: 'sk-test'
  };
  assert.equal(getBatchStartError(config, 1), '');
});

test('batch readiness explains missing model config before URL errors', () => {
  assert.equal(getBatchStartError({ apiKey: '' }, 0), '请先在设置页面中保存完整的模型 API 配置');
});

test('batch readiness rejects an empty URL list', () => {
  const config = { apiBaseUrl: 'https://openrouter.ai/api/v1', model: 'qwen/qwen-plus', apiKey: 'sk-test' };
  assert.equal(getBatchStartError(config, 0), '请先上传有效的 CSV 文件');
});
```

- [ ] **Step 2：运行回归测试，再用扫描证明批量页仍依赖旧服务**

Run: `node --test tests/batch-readiness.test.mjs`

Expected: FAIL，`ERR_MODULE_NOT_FOUND` 指向 `lib/batch-readiness.mjs`。

- [ ] **Step 3：实现最小批量启动门禁并转绿**

```js
// lib/batch-readiness.mjs
import { validateLlmConfig } from './llm-config.mjs';

export function getBatchStartError(config, urlCount) {
  if (!validateLlmConfig(config).valid) return '请先在设置页面中保存完整的模型 API 配置';
  if (!Number.isInteger(urlCount) || urlCount <= 0) return '请先上传有效的 CSV 文件';
  return '';
}
```

Run: `node --test tests/batch-readiness.test.mjs && rg -n "jieyunsang|userId|积分|BLOG_RUN_STATS" batch.js batch.html`

Expected: 3 tests PASS；扫描仍返回旧依赖位置，证明批量集成清理尚未完成。

- [ ] **Step 4：把 batch.js 转成模块并按本地模型配置启动**

```js
import { loadLlmConfig } from './lib/llm-config.mjs';
import { getBatchStartError } from './lib/batch-readiness.mjs';

async function init() {
  await loadTimeoutSetting();
  await loadBatchCheckboxSettings();
  bindEvents();
  updateUI();
}

async function startBatch() {
  const modelConfig = await loadLlmConfig(chrome.storage);
  const startError = getBatchStartError(modelConfig, parsedUrls.length);
  if (startError) {
    alert(startError);
    return;
  }
  // 保留现有清理上下文、保存设置、创建 batchId 和打开标签页逻辑。
}
```

删除 `API_BASE`、`BLOG_RUN_STATS_ENDPOINT`、`userId`、`initialPoints`、积分 DOM 引用、`loadUserId`、`loadPoints`、`updateCostHint`、积分差值校验、`reportBlogRunStatsIfNeeded` 调用及其 payload/normalize 辅助函数。`resetFile` 不再调用 `updateCostHint`，`onAllCompleted` 关闭标签页后直接更新统计 UI。

- [ ] **Step 5：把 batch.html 的积分卡改成纯本地状态卡并使用模块脚本**

```html
<div class="card">
  <div class="card-title">任务状态</div>
  <div class="current-status">
    当前状态：<span class="status-badge idle" id="statusBadge">空闲</span>
  </div>
  <div class="hint">模型调用使用设置页中保存的自有 API，不消耗插件积分。</div>
</div>
```

删除 `.points-bar` 样式，并把最后一个脚本改成：

```html
<script type="module" src="batch.js"></script>
```

- [ ] **Step 6：运行全部本地测试、语法检查和活动文件服务扫描**

Run: `npm test && node --test tests/batch-readiness.test.mjs tests/llm-config.test.mjs tests/openai-client.test.mjs tests/llm-service.test.mjs tests/llm-content-bridge.test.js && node --input-type=module --check < batch.js && ! rg -n "jieyunsang|dashscope|auto_comment_user_id|refund-points|BLOG_RUN_STATS_ENDPOINT" manifest.json background.js content.js options.js options.html batch.js batch.html`

Expected: 所有测试 PASS；语法检查通过；活动插件文件旧服务扫描无匹配。

- [ ] **Step 7：提交批量流程清理**

```bash
git add lib/batch-readiness.mjs tests/batch-readiness.test.mjs batch.html batch.js
git commit -m "refactor: remove author services from batch flow"
```

---

### Task 7：本地浏览器夹具和可重复验收入口

**Files:**
- Create: `tests/fixtures/comment-page.html`
- Create: `scripts/serve-extension-fixture.js`
- Modify: `package.json:6-15`

**Interfaces:**
- Produces: `http://127.0.0.1:4173/comment-page.html`，包含标准评论字段、提交按钮和可观察的本地成功状态。

- [ ] **Step 1：先写夹具服务器冒烟测试**

```js
// tests/fixture-server.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFixtureServer } = require('../scripts/serve-extension-fixture.js');

test('serves the local comment form without external writes', async (t) => {
  const server = createFixtureServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/comment-page.html`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /id="comment"/);
  assert.match(html, /id="submit"/);
  assert.match(html, /id="submit-result"/);
});
```

- [ ] **Step 2：运行测试并确认服务器模块不存在**

Run: `node --test tests/fixture-server.test.js`

Expected: FAIL，`MODULE_NOT_FOUND`。

- [ ] **Step 3：实现仅绑定 127.0.0.1 的夹具服务器**

```js
// scripts/serve-extension-fixture.js
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

function createFixtureServer() {
  return http.createServer((req, res) => {
    if (req.url !== '/' && req.url !== '/comment-page.html') {
      res.writeHead(404).end('Not Found');
      return;
    }
    const file = path.join(__dirname, '..', 'tests', 'fixtures', 'comment-page.html');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(file).pipe(res);
  });
}

if (require.main === module) {
  createFixtureServer().listen(4173, '127.0.0.1', () => {
    console.log('Fixture: http://127.0.0.1:4173/comment-page.html');
  });
}

module.exports = { createFixtureServer };
```

- [ ] **Step 4：创建不会产生外部副作用的评论页**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="description" content="A local browser-extension test article about practical website accessibility." />
  <title>Local Accessibility Article</title>
</head>
<body>
  <main>
    <article><h1>Practical accessibility checks</h1><p>Use clear labels, keyboard navigation, readable contrast, and useful alternative text.</p></article>
    <form id="commentform">
      <label>Name <input id="author" name="author" /></label>
      <label>Email <input id="email" name="email" type="email" /></label>
      <label>Website <input id="url" name="url" type="url" /></label>
      <label>Comment <textarea id="comment" name="comment"></textarea></label>
      <button id="submit" type="submit">Post Comment</button>
    </form>
    <output id="submit-result"></output>
  </main>
  <script>
    document.getElementById('commentform').addEventListener('submit', (event) => {
      event.preventDefault();
      document.getElementById('submit-result').textContent = 'LOCAL_SUBMIT_OK';
    });
  </script>
</body>
</html>
```

- [ ] **Step 5：增加脚本并运行夹具测试**

```json
"scripts": {
  "test": "node --test tests/*.test.js tests/*.test.mjs",
  "test:fixture": "node scripts/serve-extension-fixture.js",
  "start": "node server.js",
  "dev": "node server.js",
  "csv:export": "node scripts/run-csv-export.js",
  "pm2:start": "pm2 start server.js --name auto-comment-api",
  "pm2:stop": "pm2 stop auto-comment-api",
  "pm2:restart": "pm2 restart auto-comment-api",
  "pm2:logs": "pm2 logs auto-comment-api"
}
```

Run: `npm test`

Expected: 现有支付测试、全部模型测试和夹具服务器测试均 PASS，0 failures。

- [ ] **Step 6：提交本地验收夹具**

```bash
git add package.json tests/fixtures/comment-page.html tests/fixture-server.test.js scripts/serve-extension-fixture.js
git commit -m "test: add local extension acceptance fixture"
```

---

### Task 8：完整验证、真实 Chrome 验收和合并

**Files:**
- Verify: all changed files
- Modify only if a failing regression test identifies a root cause; any fix starts a new red—green cycle and separate commit.

**Interfaces:**
- Consumes: 用户在插件设置页直接输入的 OpenRouter Key。
- Produces: 自动化验证证据、真实模型生成证据、本地表单填充/提交证据和合并后的 `master`。

- [ ] **Step 1：运行功能分支完整自动化门禁**

Run:

```bash
npm test
node --input-type=module --check < background.js
node --check content.js
node --input-type=module --check < options.js
node --input-type=module --check < batch.js
node --check lib/llm-content-bridge.js
node -e "JSON.parse(require('node:fs').readFileSync('manifest.json','utf8'))"
git diff --check master...HEAD
! rg -n "jieyunsang|dashscope|auto_comment_user_id|refund-points|BLOG_RUN_STATS_ENDPOINT" manifest.json background.js content.js options.js options.html batch.js batch.html
```

Expected: 所有命令退出 0；测试 0 failures；活动插件文件无原作者服务匹配。

- [ ] **Step 2：启动本地夹具并加载 worktree 插件到用户 Chrome**

Run: `npm run test:fixture`

浏览器操作：

1. 打开 `chrome://extensions` 并启用开发者模式。
2. 加载 `/Users/moltbot/Code/autoComment/.worktrees/codex-self-owned-openai-api` 为未打包扩展。
3. 打开扩展设置页，确认默认 Base URL 和默认模型显示正确。

Expected: 扩展成功加载，Service Worker 无注册错误，设置页不显示用户 ID、积分、购买或联系作者区域。

- [ ] **Step 3：由用户直接输入 Key，完成真实 OpenRouter 双模型测试**

浏览器操作：

1. 用户在设置页亲自输入 OpenRouter API Key。
2. 保持模型为 `qwen/qwen-plus`，点击“测试连接”。
3. 确认界面显示连接成功。
4. 把模型改成 `openrouter/auto`，再次测试连接并确认成功。
5. 把模型恢复成 `qwen/qwen-plus` 并保存。

Expected: 两个不同模型 ID 都通过同一客户端真实调用成功；Key 不出现在浏览器可见日志、下载文件或聊天中。

- [ ] **Step 4：真实生成并验证本地单页和批量流程**

浏览器操作：

1. 打开 `http://127.0.0.1:4173/comment-page.html`。
2. 通过插件生成真实 Qwen-Plus 评论，确认 `#comment` 获得非空英文内容，Name/Email/Website 按设置填充。
3. 在本地页触发自动提交，确认 `#submit-result` 为 `LOCAL_SUBMIT_OK`。
4. 打开 `batch.html`，确认没有积分 UI；上传仅包含本地夹具 URL 的 CSV，运行一次批量流程并确认结果被本地记录。
5. 从设置页导出配置并检查 JSON：包含 `llm_api_base_url` 和 `llm_model`，不包含 `llm_api_key` 或真实 Key。

Expected: 单页与批量流程成功；所有提交只发生在 127.0.0.1；无 `jieyunsang.cn` 请求。

- [ ] **Step 5：确认验收没有未处理回归并检查分支状态**

Run: `git status --short --branch && git log --oneline --decorate master..HEAD`

Expected: 工作树干净；提交序列只包含规格、计划和本任务的独立功能/测试提交。若 Chrome 验收失败，停止合并，回到根因调查并为该失败新增一个红—绿任务和独立提交，不在本步骤临时打补丁。

- [ ] **Step 6：在主工作区确认安全合并条件**

Run: `git status --short --branch && git fetch origin && git rev-list --left-right --count master...origin/master`

Workdir: `/Users/moltbot/Code/autoComment`

Expected: 主工作区无未提交改动；本地与远端差异已明确。若远端出现新提交，先停止合并并重新基于最新 `origin/master` 验证，不覆盖用户改动。

- [ ] **Step 7：非快进合并到本地 master 并运行合并后验证**

Run:

```bash
git merge --no-ff codex/self-owned-openai-api -m "merge: use self-owned OpenAI-compatible API"
npm ci
npm test
node --input-type=module --check < background.js
node --check content.js
node --input-type=module --check < options.js
node --input-type=module --check < batch.js
! rg -n "jieyunsang|dashscope|auto_comment_user_id|refund-points|BLOG_RUN_STATS_ENDPOINT" manifest.json background.js content.js options.js options.html batch.js batch.html
```

Workdir: `/Users/moltbot/Code/autoComment`

Expected: merge 成功；合并后的完整测试和扫描全部通过。

- [ ] **Step 8：把 Chrome 切换到合并后的主工作区插件**

浏览器操作：

1. 在 `chrome://extensions` 移除从 worktree 路径加载的测试实例。
2. 加载 `/Users/moltbot/Code/autoComment` 为未打包扩展。
3. 由于未打包扩展路径变化会形成新的本地扩展实例，用户在主工作区插件设置页重新输入 OpenRouter Key。
4. 使用 `qwen/qwen-plus` 再执行一次真实连接测试，并重新打开本地夹具确认评论生成。

Expected: 用户最终保留的是合并后 `master` 路径的插件，而不是即将删除的 worktree 路径；真实模型冒烟测试通过。

- [ ] **Step 9：停止本地夹具并清理已合并 worktree 和功能分支**

先在运行 `npm run test:fixture` 的终端发送 `Ctrl-C`，确认 4173 端口不再监听，然后运行：

Run:

```bash
git worktree remove /Users/moltbot/Code/autoComment/.worktrees/codex-self-owned-openai-api
git branch -d codex/self-owned-openai-api
git worktree list
git status --short --branch
```

Workdir: `/Users/moltbot/Code/autoComment`

Expected: 功能 worktree 和已合并分支被删除；`master` 工作区干净。除非用户另行要求，不执行 `git push`。
