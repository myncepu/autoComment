import assert from 'node:assert/strict';
import test from 'node:test';
import Papa from 'papaparse';

import { createDefaultDomainConfig } from '../lib/domain-config-schema.mjs';
import {
  buildBatchCsvTemplate,
  decodeBatchCsv,
  inferBatchColumnMapping,
  parseBatchCsv,
  resolveBatchRows
} from '../lib/batch-csv-import.mjs';

function configFixture() {
  const config = createDefaultDomainConfig();
  config.profiles = [
    {
      id: 'profile-a',
      displayName: '运营身份 A',
      name: 'Alice',
      email: 'alice@example.test',
      createdAt: 1,
      updatedAt: 1
    },
    {
      id: 'profile-b',
      displayName: '运营身份 B',
      name: 'Bob',
      email: 'bob@example.test',
      createdAt: 1,
      updatedAt: 1
    }
  ];
  config.promotionSites = [
    {
      id: 'site-a',
      name: '产品官网 A',
      url: 'https://product-a.example/',
      content: 'site description A',
      enabled: true,
      createdAt: 1,
      updatedAt: 1
    },
    {
      id: 'site-b',
      name: '产品官网 B',
      url: 'https://product-b.example/path',
      content: 'site description B',
      enabled: true,
      createdAt: 1,
      updatedAt: 1
    },
    {
      id: 'site-disabled',
      name: '禁用官网',
      url: 'https://disabled.example/',
      content: 'disabled description',
      enabled: false,
      createdAt: 1,
      updatedAt: 1
    }
  ];
  config.assignmentPolicy = {
    defaultPairId: 'pair-a',
    pairs: [
      {
        id: 'pair-a',
        profileId: 'profile-a',
        promotionSiteId: 'site-a',
        weight: 3,
        enabled: true
      },
      {
        id: 'pair-b',
        profileId: 'profile-b',
        promotionSiteId: 'site-b',
        weight: 1,
        enabled: true
      },
      {
        id: 'pair-disabled-site',
        profileId: 'profile-a',
        promotionSiteId: 'site-disabled',
        weight: 1,
        enabled: false
      }
    ],
    quotas: {
      batch: 100,
      perProfile: 50,
      perPromotionSite: 50,
      perTargetDomain: 3
    }
  };
  return config;
}

function parse(text) {
  return parseBatchCsv(text, Papa.parse);
}

const explicitMapping = {
  targetUrl: 0,
  sourceDomain: 1,
  profileRef: 2,
  promotionSiteRef: 3
};

test('decodes UTF-8 and UTF-16 byte order marks', () => {
  const utf8 = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('原URL\nhttps://a.test')]);
  const utf16 = new Uint8Array([
    0xff, 0xfe,
    ...Array.from('URL\nhttps://a.test').flatMap((character) => {
      const code = character.charCodeAt(0);
      return [code & 0xff, code >> 8];
    })
  ]);

  assert.equal(decodeBatchCsv(utf8.buffer), '原URL\nhttps://a.test');
  assert.equal(decodeBatchCsv(utf16.buffer), 'URL\nhttps://a.test');
});

test('parses quoted newlines and maps an old CSV without assignments', () => {
  const parsed = parse(
    '原URL,来源域名,备注\r\n"https://a.test/p",a.test,"line 1\nline 2"'
  );

  assert.deepEqual(parsed, {
    headers: ['原URL', '来源域名', '备注'],
    rows: [{
      rowNumber: 2,
      originalRow: ['https://a.test/p', 'a.test', 'line 1\nline 2']
    }]
  });
  assert.deepEqual(inferBatchColumnMapping(parsed.headers), {
    targetUrl: 0,
    sourceDomain: 1,
    profileRef: null,
    promotionSiteRef: null
  });
});

test('accepts a valid single-column URL CSV despite Papa delimiter warning', () => {
  const parsed = parse([
    '原URL',
    'https://a.test/post',
    'https://b.test/post'
  ].join('\n'));

  assert.deepEqual(parsed, {
    headers: ['原URL'],
    rows: [{
      rowNumber: 2,
      originalRow: ['https://a.test/post']
    }, {
      rowNumber: 3,
      originalRow: ['https://b.test/post']
    }]
  });
});

test('recognizes canonical assignment headers and legacy URL/domain aliases', () => {
  assert.deepEqual(inferBatchColumnMapping([
    '\ufeffurl',
    'URL对应域名',
    'Profile ID',
    'promotionSiteId'
  ]), explicitMapping);
  assert.deepEqual(inferBatchColumnMapping(['URL', 'sourceDomain']), {
    targetUrl: 0,
    sourceDomain: 1,
    profileRef: null,
    promotionSiteRef: null
  });
});

test('rejects malformed CSV and missing or ambiguous target columns', () => {
  assert.throws(() => parse('URL\n"unterminated'), (error) => error.code === 'csv_parse_failed');
  assert.throws(() => inferBatchColumnMapping(['来源域名']),
    (error) => error.code === 'target_url_column_required');
  assert.throws(() => inferBatchColumnMapping(['URL', '原URL']),
    (error) => error.code === 'ambiguous_target_url_column');
});

test('resolves IDs before unique exact display names, site names, and canonical URLs', () => {
  const parsed = parse([
    'URL,来源域名,identity,site',
    'https://target-a.test/post,target-a.test,profile-a,site-a',
    'https://target-b.test/post,target-b.test,运营身份 B,产品官网 B',
    'https://target-c.test/post,,运营身份 B,HTTPS://PRODUCT-B.EXAMPLE:443/path'
  ].join('\n'));
  const rows = resolveBatchRows(parsed, explicitMapping, configFixture());

  assert.deepEqual(rows.map((row) => ({
    profileId: row.profileId,
    promotionSiteId: row.promotionSiteId,
    assignmentPairId: row.assignmentPairId,
    assignmentSource: row.assignmentSource
  })), [
    {
      profileId: 'profile-a',
      promotionSiteId: 'site-a',
      assignmentPairId: 'pair-a',
      assignmentSource: 'explicit'
    },
    {
      profileId: 'profile-b',
      promotionSiteId: 'site-b',
      assignmentPairId: 'pair-b',
      assignmentSource: 'explicit'
    },
    {
      profileId: 'profile-b',
      promotionSiteId: 'site-b',
      assignmentPairId: 'pair-b',
      assignmentSource: 'explicit'
    }
  ]);
  assert.equal(rows[0].rowNumber, 2);
  assert.equal(rows[0].targetUrlRaw, 'https://target-a.test/post');
  assert.deepEqual(rows[0].originalRow, parsed.rows[0].originalRow);
});

test('keeps an old CSV row unassigned for deterministic weighted allocation', () => {
  const parsed = parse('原URL,来源域名\nhttps://target.test/post,target.test');
  const rows = resolveBatchRows(
    parsed,
    inferBatchColumnMapping(parsed.headers),
    configFixture()
  );

  assert.deepEqual(rows[0], {
    rowNumber: 2,
    originalRow: ['https://target.test/post', 'target.test'],
    targetUrlRaw: 'https://target.test/post',
    sourceDomainRaw: 'target.test',
    profileRefRaw: '',
    promotionSiteRefRaw: '',
    profileId: null,
    promotionSiteId: null,
    assignmentPairId: null,
    assignmentSource: 'weighted'
  });
});

test('rejects half-mapped and half-filled assignment columns', () => {
  const parsed = parse('URL,profileId,site\nhttps://target.test,profile-a,');
  assert.throws(() => resolveBatchRows(parsed, {
    targetUrl: 0,
    sourceDomain: null,
    profileRef: 1,
    promotionSiteRef: null
  }, configFixture()), (error) => error.code === 'assignment_columns_must_both_be_mapped');

  assert.throws(() => resolveBatchRows(parsed, {
    targetUrl: 0,
    sourceDomain: null,
    profileRef: 1,
    promotionSiteRef: 2
  }, configFixture()), (error) => (
    error.code === 'assignment_columns_must_both_be_filled' && error.rowNumber === 2
  ));
});

test('rejects missing references, disabled sites, and unapproved atomic pairs', () => {
  const cases = [
    ['profile_not_found', 'missing', 'site-a'],
    ['promotion_site_not_found', 'profile-a', 'missing'],
    ['promotion_site_disabled', 'profile-a', 'site-disabled'],
    ['assignment_pair_not_approved', 'profile-a', 'site-b']
  ];

  for (const [code, profileRef, siteRef] of cases) {
    const parsed = parse(
      `URL,source,profile,site\nhttps://target.test,,${profileRef},${siteRef}`
    );
    assert.throws(() => resolveBatchRows(parsed, explicitMapping, configFixture()),
      (error) => error.code === code && error.rowNumber === 2);
  }
});

test('rejects duplicate mapping indices and rows without a target URL', () => {
  const parsed = parse('URL,source\n,source.test');
  assert.throws(() => resolveBatchRows(parsed, {
    targetUrl: 0,
    sourceDomain: 0,
    profileRef: null,
    promotionSiteRef: null
  }, configFixture()), (error) => error.code === 'duplicate_column_mapping');
  assert.throws(() => resolveBatchRows(parsed, {
    targetUrl: 0,
    sourceDomain: 1,
    profileRef: null,
    promotionSiteRef: null
  }, configFixture()), (error) => (
    error.code === 'target_url_required' && error.rowNumber === 2
  ));
});

test('template contains usable IDs but no PII, password state, or site description', () => {
  const template = buildBatchCsvTemplate(configFixture());
  const serialized = JSON.stringify(template);

  assert.equal(template.csv, '\ufeff原URL,来源域名,profileId,promotionSiteId\r\n');
  assert.deepEqual(template.references.profiles, [
    { id: 'profile-a', displayName: '运营身份 A' },
    { id: 'profile-b', displayName: '运营身份 B' }
  ]);
  assert.deepEqual(template.references.promotionSites, [
    { id: 'site-a', name: '产品官网 A', url: 'https://product-a.example/' },
    { id: 'site-b', name: '产品官网 B', url: 'https://product-b.example/path' }
  ]);
  assert.doesNotMatch(serialized, /alice@example|bob@example|site description|disabled description|password/i);
});
