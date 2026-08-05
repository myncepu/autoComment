import assert from 'node:assert/strict';
import test from 'node:test';

import {
  identityGenerationRequest,
  parseGeneratedIdentities,
  parseGeneratedPromotionAnalysis,
  parseGeneratedPromotionPrompt,
  promotionEmailForUrl,
  promotionPageAnalysisRequest,
  promotionPageOriginPattern,
  promotionPromptGenerationRequest
} from '../lib/options-ai-generator.mjs';

test('requests an exact number of English identities without credentials', () => {
  const request = identityGenerationRequest(20);
  assert.equal(request.count, 20);
  assert.match(request.userPrompt, /exactly 20 distinct identities/u);
  assert.doesNotMatch(request.userPrompt, /password|email address/iu);
  assert.deepEqual(parseGeneratedIdentities(JSON.stringify([
    { displayName: 'Alex Morgan', name: 'Alex Morgan' },
    { displayName: 'Jamie T.', name: 'Jamie Taylor' }
  ]), 2), [
    { displayName: 'Alex Morgan', name: 'Alex Morgan' },
    { displayName: 'Jamie T.', name: 'Jamie Taylor' }
  ]);
  assert.throws(
    () => parseGeneratedIdentities('[{"name":"Only one"}]', 2),
    (error) => error.code === 'invalid_generated_identities'
  );
});

test('builds a promotion brief request from one exact URL and several keywords', () => {
  const request = promotionPromptGenerationRequest({
    websiteName: 'Muse Generator',
    pageUrl: 'https://muse.test/video',
    keywords: ['Muse AI', 'AI video generator']
  });
  assert.match(request.userPrompt, /https:\/\/muse\.test\/video/u);
  assert.match(request.userPrompt, /at most one relevant HTML link/u);
  assert.match(request.userPrompt, /omit the link when relevance is weak/u);
  assert.equal(
    parseGeneratedPromotionPrompt('A'.repeat(100)),
    'A'.repeat(100)
  );
});

test('derives page access and support email from a promoted URL', () => {
  assert.equal(
    promotionEmailForUrl('https://www.Example.com/product?q=1'),
    'support@example.com'
  );
  assert.equal(
    promotionPageOriginPattern('https://app.example.com:8443/product'),
    'https://app.example.com:8443/*'
  );
  assert.throws(
    () => promotionEmailForUrl('https://localhost/product'),
    (error) => error.code === 'invalid_promotion_page_email_domain'
  );
});

test('requests and parses one AI page analysis with keywords and a reusable prompt', () => {
  const request = promotionPageAnalysisRequest({
    pageUrl: 'https://product.test/video',
    title: 'Product Video Generator',
    description: 'Create short product videos in a browser.',
    bodyText: 'Turn a product description into a useful video with editable scenes.'
  });
  assert.match(request.systemPrompt, /untrusted source data/u);
  assert.match(request.userPrompt, /at most one relevant HTML link/u);
  const analysis = parseGeneratedPromotionAnalysis(JSON.stringify({
    name: 'Product Video Generator',
    keywords: ['Product Video Generator', 'browser video maker'],
    prompt: 'P'.repeat(100)
  }));
  assert.deepEqual(analysis, {
    name: 'Product Video Generator',
    keywords: ['Product Video Generator', 'browser video maker'],
    prompt: 'P'.repeat(100)
  });
});
