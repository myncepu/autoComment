import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { bootAppShell, getAppNavigation } from '../lib/app-shell.mjs';

function shellDocument(url = 'https://localhost/history.html') {
  return new JSDOM(
    '<!doctype html><html><body><header data-app-shell></header></body></html>',
    { url }
  ).window.document;
}

test('maps options hashes to distinct active navigation items for extension and web URLs', () => {
  assert.equal(
    getAppNavigation('chrome-extension://id/options.html#identity')
      .find((item) => item.active).id,
    'identity'
  );
  assert.equal(
    getAppNavigation('http://localhost/options.html#promotion')
      .find((item) => item.active).id,
    'promotion'
  );
  assert.equal(
    getAppNavigation('http://localhost/options.html#settings')
      .find((item) => item.active).id,
    'settings'
  );
});

test('renders one labelled navigation landmark with relative links and an active item', () => {
  const document = shellDocument();
  bootAppShell(document, {
    currentUrl: 'chrome-extension://id/history.html'
  });

  assert.equal(document.querySelectorAll('nav[aria-label="插件主导航"]').length, 1);
  assert.equal(document.querySelector('[aria-current="page"]').textContent, '评论历史');
  assert.deepEqual(
    [...document.querySelectorAll('nav a')].map((link) => link.getAttribute('href')),
    ['batch.html', 'options.html#identity', 'options.html#promotion', 'history.html', 'options.html#settings']
  );
});

test('delegates a plain navigation click only when an onNavigate callback is supplied', () => {
  const document = shellDocument('http://localhost/options.html#identity');
  const navigated = [];
  bootAppShell(document, {
    currentUrl: document.location.href,
    onNavigate(href) {
      navigated.push(href);
    }
  });

  const link = document.querySelector('a[href="history.html"]');
  const event = new document.defaultView.MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    button: 0
  });
  link.dispatchEvent(event);

  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(navigated, ['history.html']);
});

test('starts with a collapsed accessible menu on narrow screens', () => {
  const document = shellDocument();
  document.defaultView.matchMedia = () => ({ matches: true });

  bootAppShell(document, { currentUrl: document.location.href });

  assert.equal(document.querySelector('.app-shell__menu').open, false);
  assert.equal(document.querySelector('.app-shell__menu > summary').textContent, '导航');
});
