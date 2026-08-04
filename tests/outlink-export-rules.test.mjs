import test from 'node:test';
import assert from 'node:assert/strict';

await import('../lib/outlink-export-rules.js');
const rules = globalThis.AutoCommentOutlinkRules;

test('normalizes domain and keyword rules from multiline settings', () => {
  assert.deepEqual(rules.normalizeRules({
    excludedDomains: 'https://www.Example.com/path\n*.ads.test\nexample.com',
    excludedKeywords: 'UTM_SOURCE=\nprivacy\nprivacy'
  }), {
    excludedDomains: ['example.com', 'ads.test'],
    excludedKeywords: ['utm_source=', 'privacy']
  });
});

test('domain filters match the domain and its subdomains without partial matches', () => {
  assert.equal(rules.hostnameMatchesRule('cdn.example.com', 'example.com'), true);
  assert.equal(rules.hostnameMatchesRule('example.com', 'example.com'), true);
  assert.equal(rules.hostnameMatchesRule('notexample.com', 'example.com'), false);
});

test('filters links by domain or characters in URL, hostname, and anchor text', () => {
  const result = rules.filterOutlinks([
    {
      url: 'https://cdn.ads.test/pixel',
      host: 'cdn.ads.test',
      text: 'Ad'
    },
    {
      url: 'https://safe.test/page?utm_source=blog',
      host: 'safe.test',
      text: 'Safe'
    },
    {
      url: 'https://kept.test/article',
      host: 'kept.test',
      text: 'Read article'
    }
  ], {
    excludedDomains: ['ads.test'],
    excludedKeywords: ['UTM_SOURCE=']
  });

  assert.deepEqual(result.kept.map((link) => link.host), ['kept.test']);
  assert.deepEqual(result.excluded.map((item) => item.reason), ['domain', 'keyword']);
});
