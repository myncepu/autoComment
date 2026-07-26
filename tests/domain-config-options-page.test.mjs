import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const root = new URL('../', import.meta.url);

test('options page exposes Profile, Site, Pair, default, quota, and explicit import controls', () => {
  const html = fs.readFileSync(new URL('options.html', root), 'utf8');
  const document = new JSDOM(html).window.document;
  const requiredIds = [
    'profileSelect',
    'profileDisplayName',
    'userName',
    'userEmail',
    'userPassword',
    'passwordConfiguredStatus',
    'promotionSiteSelect',
    'promotionSiteName',
    'websiteUrl',
    'websiteContent',
    'promotionSiteEnabled',
    'pairSelect',
    'pairProfileSelect',
    'pairPromotionSiteSelect',
    'pairWeight',
    'defaultPairSelect',
    'quotaBatch',
    'quotaProfile',
    'quotaPromotionSite',
    'quotaTargetDomain',
    'applyImportConfigBtn'
  ];

  for (const id of requiredIds) {
    assert.ok(document.getElementById(id), `missing #${id}`);
  }
  assert.equal(document.getElementById('userPassword').value, '');
  assert.equal(document.getElementById('applyImportConfigBtn').hidden, true);
});

test('options composition uses local domain repositories and never writes a Profile password to sync', () => {
  const source = fs.readFileSync(new URL('options.js', root), 'utf8');

  assert.match(source, /createDomainConfigOptionsController/);
  assert.match(source, /createProfileSecretRepository\(chrome\.storage\.local\)/);
  assert.doesNotMatch(source, /auto_fill_user_password/);
  assert.doesNotMatch(source, /userPassword[\s\S]{0,160}chrome\.storage\.sync\.set/);
  assert.match(source, /controller\.previewImport/);
  assert.match(source, /controller\.applyImport/);
});
