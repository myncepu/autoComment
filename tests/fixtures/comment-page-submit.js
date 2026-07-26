(function registerLocalSubmitHandler(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.LocalFixtureSubmit = api;
  }
}(typeof globalThis === 'undefined' ? this : globalThis, (globalObject) => {
  function installLocalSubmitHandler(document) {
    const form = document.getElementById('commentform');
    const result = document.getElementById('submit-result');

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      result.textContent = 'LOCAL_SUBMIT_OK';
      const handle = globalObject.LocalFixtureChrome?.currentHandle || null;
      const targetId = Number(document.body?.dataset?.fixtureTarget);
      if (!handle || !Number.isInteger(targetId) || targetId < 1) return;
      const field = (id) => document.getElementById(id)?.value || '';
      const payload = {
        targetId,
        taskId: handle.taskId,
        profileId: handle.profileId,
        promotionSiteId: handle.promotionSiteId,
        name: field('author'),
        email: field('email'),
        passwordPresent: Boolean(field('password')),
        websiteUrl: field('url'),
        comment: field('comment')
      };
      document.getElementById('comment').value = '';
      globalObject.__fixtureSubmissionPromise = globalObject.fetch(
        '/__fixture/submissions',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload)
        }
      );
    });
  }

  return { installLocalSubmitHandler };
}));
