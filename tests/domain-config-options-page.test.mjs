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
    'exportConfigBtn',
    'importConfigBtn',
    'importConfigFileInput',
    'applyImportConfigBtn',
    'importExportStatus',
    'importPreviewSummary'
  ];

  for (const id of requiredIds) {
    assert.ok(document.getElementById(id), `missing #${id}`);
  }
  assert.equal(document.getElementById('userPassword').value, '');
  assert.equal(document.getElementById('applyImportConfigBtn').hidden, true);
  assert.doesNotMatch(
    document.getElementById('settingsStatus').textContent,
    /已保存/
  );
});

test('options composition uses restricted domain, secret, and portable-settings adapters', () => {
  const source = fs.readFileSync(new URL('options.js', root), 'utf8');

  assert.match(source, /createDomainConfigOptionsController/);
  assert.match(source, /createProfileSecretClient\(chrome\.runtime\)/);
  assert.match(source, /createOptionsConfigBundleController/);
  assert.match(source, /createOptionsConfigBundleView/);
  assert.match(
    source,
    /createSafeOptionsSettingsAdapter\(\s*chrome\.storage\.sync,\s*\{\s*permissions:\s*chrome\.permissions\s*\}\s*\)/
  );
  assert.doesNotMatch(source, /createProfileSecretRepository/);
  assert.doesNotMatch(source, /PROFILE_SECRETS_KEY/);
  assert.doesNotMatch(source, /auto_fill_user_password/);
  assert.doesNotMatch(source, /userPassword[\s\S]{0,160}chrome\.storage\.sync\.set/);
  assert.doesNotMatch(source, /JSON\.parse\(await file\.text\(\)\)/);
  assert.doesNotMatch(source, /pendingImportPreview/);
  assert.match(source, /installOptionsPageBoot/);
  assert.match(source, /bindStoredBooleanToggle/);
});

test('production composition routes options domain writes to the background repository', () => {
  const optionsSource = fs.readFileSync(new URL('options.js', root), 'utf8');
  const backgroundSource = fs.readFileSync(new URL('background.js', root), 'utf8');

  assert.match(
    optionsSource,
    /createDomainConfigRepositoryClient\(chrome\.runtime\)/
  );
  assert.doesNotMatch(optionsSource, /createDomainConfigRepository\(/);
  assert.match(
    backgroundSource,
    /installDomainConfigRepositoryMessageListener\([\s\S]*domainConfigRepository[\s\S]*ready:\s*domainConfigReady/
  );
});
