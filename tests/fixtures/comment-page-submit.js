(function registerLocalSubmitHandler(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.LocalFixtureSubmit = api;
  }
}(typeof globalThis === 'undefined' ? this : globalThis, () => {
  function installLocalSubmitHandler(document) {
    const form = document.getElementById('commentform');
    const result = document.getElementById('submit-result');

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      result.textContent = 'LOCAL_SUBMIT_OK';
    });
  }

  return { installLocalSubmitHandler };
}));
