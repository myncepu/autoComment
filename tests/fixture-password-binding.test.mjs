import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

test('local submission records whether the password matches its assigned Profile', async () => {
  const [adapterSource, submitSource] = await Promise.all([
    fs.readFile(
      new URL('./fixtures/fake-chrome-adapter.js', import.meta.url),
      'utf8'
    ),
    fs.readFile(
      new URL('./fixtures/comment-page-submit.js', import.meta.url),
      'utf8'
    )
  ]);
  let submitHandler;
  const submissions = [];
  const fields = {
    author: { value: 'Bob Load Fixture' },
    email: { value: 'bob-load@fixture.test' },
    password: { value: 'profile-b-secret' },
    url: { value: 'http://127.0.0.1:4100/promotion/b' },
    comment: { value: 'Local bound password comment' }
  };
  const form = {
    addEventListener(type, handler) {
      assert.equal(type, 'submit');
      submitHandler = handler;
    }
  };
  const document = {
    body: { dataset: { fixtureTarget: '1' } },
    getElementById(id) {
      return {
        commentform: form,
        'submit-result': { textContent: '' },
        ...fields
      }[id];
    }
  };
  const sessionValues = new Map();
  const context = vm.createContext({
    document,
    structuredClone,
    setTimeout,
    clearTimeout,
    sessionStorage: {
      getItem(key) {
        return sessionValues.get(key) ?? null;
      },
      setItem(key, value) {
        sessionValues.set(key, value);
      },
      removeItem(key) {
        sessionValues.delete(key);
      }
    },
    fetch(_url, options) {
      submissions.push(JSON.parse(options.body));
      return Promise.resolve({ ok: true });
    }
  });
  vm.runInContext(adapterSource, context);
  vm.runInContext(submitSource, context);
  vm.runInContext(`
    LocalFixtureChrome.configurePasswords({
      'profile-a': 'profile-a-secret',
      'profile-b': 'profile-b-secret'
    });
    LocalFixtureChrome.dispatchHandle({
      type: 'BATCH_HANDLE',
      taskId: 'password-binding:1',
      profileId: 'profile-b',
      promotionSiteId: 'site-b'
    });
    LocalFixtureSubmit.installLocalSubmitHandler(document);
  `, context);

  submitHandler({ preventDefault() {} });
  await context.__fixtureSubmissionPromise;
  assert.equal(submissions[0].passwordPresent, true);
  assert.equal(submissions[0].passwordMatchesProfile, true);
  assert.equal(Object.hasOwn(submissions[0], 'password'), false);

  fields.password.value = 'profile-a-secret';
  fields.comment.value = 'Wrong password fixture comment';
  submitHandler({ preventDefault() {} });
  await context.__fixtureSubmissionPromise;
  assert.equal(submissions[1].passwordPresent, true);
  assert.equal(submissions[1].passwordMatchesProfile, false);
  assert.equal(Object.hasOwn(submissions[1], 'password'), false);
});

