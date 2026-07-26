import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { focusOptionsSection } from '../lib/options-section-navigation.mjs';

test('scrolls the requested options section and focuses its heading', () => {
  const document = new JSDOM(`<!doctype html><body>
    <section id="identity"><h2 data-section-heading tabindex="-1">身份配置</h2></section>
    <section id="promotion"><h2 data-section-heading tabindex="-1">推广网站</h2></section>
  </body>`).window.document;
  const section = document.getElementById('promotion');
  const heading = section.querySelector('h2');
  let scrollOptions;
  section.scrollIntoView = (options) => { scrollOptions = options; };

  assert.equal(focusOptionsSection(document, '#promotion'), true);
  assert.deepEqual(scrollOptions, { block: 'start' });
  assert.equal(document.activeElement, heading);
});

test('leaves the current focus unchanged for an unknown options hash', () => {
  const document = new JSDOM('<!doctype html><body><button>Keep focus</button></body>').window.document;
  const button = document.querySelector('button');
  button.focus();

  assert.equal(focusOptionsSection(document, '#unknown'), false);
  assert.equal(document.activeElement, button);
});
