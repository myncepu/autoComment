import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_QUOTAS,
  DOMAIN_CONFIG_KEY,
  DOMAIN_CONFIG_VERSION,
  assertNoSensitiveFields,
  createDefaultDomainConfig,
  normalizeDomainConfig,
  validateDomainConfig
} from '../lib/domain-config-schema.mjs';

function validConfig() {
  return {
    version: 2,
    revision: 4,
    profiles: [{
      id: ' profile-a ',
      displayName: ' 运营身份 A ',
      name: ' Alice ',
      email: ' Alice@Example.test ',
      createdAt: 10,
      updatedAt: 20
    }],
    promotionSites: [{
      id: ' site-a ',
      name: ' 产品官网 A ',
      url: 'HTTPS://Product.Example/path',
      content: ' 面向开发者的网站 ',
      enabled: true,
      createdAt: 10,
      updatedAt: 20
    }],
    assignmentPolicy: {
      defaultPairId: ' pair-a ',
      pairs: [{
        id: ' pair-a ',
        profileId: ' profile-a ',
        promotionSiteId: ' site-a ',
        weight: 3,
        enabled: true
      }],
      quotas: {}
    }
  };
}

function validationError(mutator) {
  const value = validConfig();
  mutator(value);
  return validateDomainConfig(value).error;
}

test('exports stable storage and version identifiers', () => {
  assert.equal(DOMAIN_CONFIG_KEY, 'autoCommentDomainConfig');
  assert.equal(DOMAIN_CONFIG_VERSION, 2);
  assert.deepEqual(DEFAULT_QUOTAS, {
    batch: 100,
    perProfile: 50,
    perPromotionSite: 50,
    perTargetDomain: 3
  });
});

test('creates an empty valid default config without sharing quota state', () => {
  const first = createDefaultDomainConfig(undefined, { now: () => 123 });
  const second = createDefaultDomainConfig(undefined, { now: () => 456 });

  assert.deepEqual(first, {
    version: 2,
    revision: 0,
    profiles: [],
    promotionSites: [],
    assignmentPolicy: {
      defaultPairId: null,
      pairs: [],
      quotas: {
        batch: 100,
        perProfile: 50,
        perPromotionSite: 50,
        perTargetDomain: 3
      }
    }
  });
  first.assignmentPolicy.quotas.batch = 1;
  assert.equal(second.assignmentPolicy.quotas.batch, 100);
  assert.equal(validateDomainConfig(second).ok, true);
});

test('creates deterministic default entities from legacy non-sensitive settings', () => {
  const config = createDefaultDomainConfig({
    auto_fill_user_name: ' Alice ',
    auto_fill_user_email: ' Alice@Example.test ',
    promotion_website_url: 'HTTPS://Product.Example',
    promotion_website_content: ' Product summary '
  }, { now: () => 123 });

  assert.deepEqual(config, {
    version: 2,
    revision: 0,
    profiles: [{
      id: 'default-profile',
      displayName: '默认身份',
      name: 'Alice',
      email: 'Alice@Example.test',
      createdAt: 123,
      updatedAt: 123
    }],
    promotionSites: [{
      id: 'default-promotion-site',
      name: '默认推广网站',
      url: 'https://product.example/',
      content: 'Product summary',
      enabled: true,
      createdAt: 123,
      updatedAt: 123
    }],
    assignmentPolicy: {
      defaultPairId: 'default-assignment-pair',
      pairs: [{
        id: 'default-assignment-pair',
        profileId: 'default-profile',
        promotionSiteId: 'default-promotion-site',
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
  });
});

test('normalizes valid profiles, sites, pairs, default pair, and quotas', () => {
  const config = normalizeDomainConfig(validConfig());

  assert.equal(config.version, 2);
  assert.equal(config.profiles[0].id, 'profile-a');
  assert.equal(config.profiles[0].displayName, '运营身份 A');
  assert.equal(config.profiles[0].email, 'Alice@Example.test');
  assert.equal(config.promotionSites[0].url, 'https://product.example/path');
  assert.equal(config.assignmentPolicy.defaultPairId, 'pair-a');
  assert.deepEqual(config.assignmentPolicy.quotas, {
    batch: 100,
    perProfile: 50,
    perPromotionSite: 50,
    perTargetDomain: 3
  });
});

test('validates a normalized deep clone rather than caller-owned state', () => {
  const input = validConfig();
  const result = validateDomainConfig(input);

  assert.equal(result.ok, true);
  assert.notEqual(result.value, input);
  assert.notEqual(result.value.profiles, input.profiles);
  input.profiles[0].name = 'Changed';
  assert.equal(result.value.profiles[0].name, 'Alice');
});

test('rejects unknown keys at every schema level', () => {
  assert.equal(validationError((value) => { value.password = 'x'; }), 'invalid_domain_config');
  assert.equal(validationError((value) => { value.profiles[0].nickname = 'x'; }), 'invalid_profile');
  assert.equal(validationError((value) => { value.promotionSites[0].description = 'x'; }), 'invalid_promotion_site');
  assert.equal(validationError((value) => { value.assignmentPolicy.mode = 'round-robin'; }), 'invalid_assignment_policy');
  assert.equal(validationError((value) => { value.assignmentPolicy.pairs[0].password = 'x'; }), 'invalid_assignment_pair');
  assert.equal(validationError((value) => { value.assignmentPolicy.quotas.daily = 1; }), 'invalid_quotas');
});

test('rejects malformed versions, revisions, entity fields, and timestamps', () => {
  assert.equal(validationError((value) => { value.version = 1; }), 'unsupported_domain_config_version');
  assert.equal(validationError((value) => { value.revision = -1; }), 'invalid_domain_config_revision');
  assert.equal(validationError((value) => { value.profiles[0].id = ' '; }), 'invalid_profile');
  assert.equal(validationError((value) => { value.profiles[0].email = 'not-an-email'; }), 'invalid_profile_email');
  assert.equal(validationError((value) => { value.profiles[0].updatedAt = -1; }), 'invalid_profile');
  assert.equal(validationError((value) => { value.promotionSites[0].enabled = 'yes'; }), 'invalid_promotion_site');
  assert.equal(validationError((value) => { value.promotionSites[0].content = ' '; }), 'invalid_promotion_site');
});

test('rejects duplicate profile display names while allowing the same product name on different pages', () => {
  assert.equal(validationError((value) => {
    value.profiles.push({
      ...value.profiles[0],
      id: 'profile-b',
      displayName: '运营身份 a'
    });
  }), 'duplicate_profile_display_name');

  assert.equal(validationError((value) => {
    value.promotionSites.push({
      ...value.promotionSites[0],
      id: 'site-b',
      name: '产品官网 a',
      url: 'https://product.example/another-page'
    });
  }), undefined);
});

test('rejects duplicate entity IDs', () => {
  assert.equal(validationError((value) => {
    value.profiles.push({ ...value.profiles[0], displayName: '运营身份 B' });
  }), 'duplicate_profile_id');

  assert.equal(validationError((value) => {
    value.promotionSites.push({ ...value.promotionSites[0], name: '产品官网 B' });
  }), 'duplicate_promotion_site_id');
});

test('rejects duplicate URLs across legacy sites and every modern promotion page', () => {
  assert.equal(validationError((value) => {
    value.promotionSites.push({
      ...value.promotionSites[0],
      id: 'site-b',
      name: '产品官网 B'
    });
  }), 'duplicate_promotion_page_url');

  const value = validConfig();
  value.profiles[0].email = '';
  value.promotionSites[0] = {
    ...value.promotionSites[0],
    email: 'support@product.example',
    pages: [{
      id: 'page-a',
      url: 'https://product.example/repeated',
      keywords: ['Page A'],
      content: 'Page A instructions',
      enabled: true,
      createdAt: 1,
      updatedAt: 1
    }, {
      id: 'page-b',
      url: 'https://product.example/repeated',
      keywords: ['Page B'],
      content: 'Page B instructions',
      enabled: true,
      createdAt: 1,
      updatedAt: 1
    }]
  };
  assert.equal(validateDomainConfig(value).error, 'duplicate_promotion_page_url');
});

test('rejects non-http promotion URLs', () => {
  assert.equal(validationError((value) => { value.promotionSites[0].url = 'javascript:alert(1)'; }),
    'invalid_promotion_site_url');
  assert.equal(validationError((value) => { value.promotionSites[0].url = 'not a url'; }),
    'invalid_promotion_site_url');
});

test('rejects dangling pairs, duplicate pair IDs, and duplicate atomic combinations', () => {
  assert.equal(validationError((value) => {
    value.assignmentPolicy.pairs[0].profileId = 'missing';
  }), 'invalid_assignment_pair');

  assert.equal(validationError((value) => {
    value.assignmentPolicy.pairs.push({
      ...value.assignmentPolicy.pairs[0],
      promotionSiteId: 'missing'
    });
  }), 'duplicate_assignment_pair_id');

  assert.equal(validationError((value) => {
    value.assignmentPolicy.pairs.push({
      ...value.assignmentPolicy.pairs[0],
      id: 'pair-b'
    });
  }), 'duplicate_assignment_combination');
});

test('rejects invalid pair weight and enabled state', () => {
  for (const weight of [0, 101, 1.5]) {
    assert.equal(validationError((value) => {
      value.assignmentPolicy.pairs[0].weight = weight;
    }), 'invalid_assignment_pair_weight');
  }
  assert.equal(validationError((value) => {
    value.assignmentPolicy.pairs[0].enabled = 1;
  }), 'invalid_assignment_pair');
});

test('rejects missing, disabled, or unusable default pairs', () => {
  assert.equal(validationError((value) => {
    value.assignmentPolicy.defaultPairId = 'missing';
  }), 'invalid_default_assignment_pair');
  assert.equal(validationError((value) => {
    value.assignmentPolicy.pairs[0].enabled = false;
  }), 'invalid_default_assignment_pair');
  assert.equal(validationError((value) => {
    value.promotionSites[0].enabled = false;
  }), 'invalid_default_assignment_pair');
  assert.equal(validationError((value) => {
    value.assignmentPolicy.defaultPairId = null;
  }), 'invalid_default_assignment_pair');
});

test('allows a null default only when there are no assignment pairs', () => {
  const value = createDefaultDomainConfig();
  assert.equal(validateDomainConfig(value).ok, true);
});

test('rejects zero, negative, fractional, missing, or non-numeric quotas', () => {
  for (const quota of ['batch', 'perProfile', 'perPromotionSite', 'perTargetDomain']) {
    for (const invalid of [0, -1, 1.5, '3']) {
      assert.equal(validationError((value) => {
        value.assignmentPolicy.quotas[quota] = invalid;
      }), 'invalid_quotas');
    }
  }
});

test('recursively rejects sensitive field names without exposing their values', () => {
  for (const key of ['password', 'hasPassword', 'secret', 'apiKey', 'cookie', 'accessToken']) {
    assert.throws(
      () => assertNoSensitiveFields({ nested: [{ [key]: 'DO_NOT_ECHO' }] }),
      (error) => error.code === 'sensitive_field_forbidden'
        && !error.message.includes('DO_NOT_ECHO')
    );
  }
  assert.doesNotThrow(() => assertNoSensitiveFields({
    content: 'A sentence can mention a password without being a password field.'
  }));
});

test('accepts identities without email and normalizes old multi-page websites into page records', () => {
  const value = validConfig();
  value.profiles[0].email = '';
  value.promotionSites[0] = {
    ...value.promotionSites[0],
    email: 'support@product.example',
    pages: [{
      id: 'page-home',
      url: 'https://product.example/',
      keywords: ['Product', 'browser tool'],
      content: 'Use at most one relevant link to the exact promoted page.',
      enabled: true,
      createdAt: 1,
      updatedAt: 1
    }, {
      id: 'page-video',
      url: 'https://product.example/video',
      keywords: ['AI video'],
      content: 'Describe the AI video page when it is contextually relevant.',
      enabled: true,
      createdAt: 1,
      updatedAt: 1
    }]
  };

  const result = validateDomainConfig(value);
  assert.equal(result.ok, true);
  assert.equal(result.value.profiles[0].email, '');
  assert.equal(result.value.promotionSites.length, 2);
  assert.equal(result.value.promotionSites[0].pages.length, 1);
  assert.equal(result.value.promotionSites[1].pages.length, 1);
  assert.equal(result.value.promotionSites[0].id, 'site-a');
  assert.equal(result.value.promotionSites[1].id, 'site-a--page-video');
  assert.equal(result.value.promotionSites[1].url, 'https://product.example/video');
  assert.equal(result.value.promotionSites[0].email, 'support@product.example');
  assert.equal(result.value.promotionSites[1].email, 'support@product.example');
});
