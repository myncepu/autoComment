(function installCommentHistoryCapture(root) {
  function normalizeSpace(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function readEditorHtml(editor) {
    const real = editor && editor._realElement;
    if (real) return real.innerHTML || real.textContent || '';
    if (editor && editor.getAttribute && editor.getAttribute('contenteditable') === 'true') {
      return editor.innerHTML || editor.textContent || '';
    }
    return editor && typeof editor.value === 'string' ? editor.value : '';
  }

  function parseHtml(documentImpl, html, pageUrl) {
    const template = documentImpl.createElement('template');
    template.innerHTML = String(html || '');
    const anchors = Array.from(template.content.querySelectorAll('a')).map((link, position) => {
      const hrefRaw = link.getAttribute('href') || '';
      let hrefResolved = '';
      let hrefDomain = '';
      try {
        const parsed = new URL(hrefRaw, pageUrl);
        hrefResolved = parsed.href;
        hrefDomain = parsed.hostname.toLowerCase();
      } catch (_) {}
      return {
        position,
        anchorText: normalizeSpace(link.textContent),
        hrefRaw,
        hrefResolved,
        hrefDomain
      };
    });
    return {
      commentText: normalizeSpace(template.content.textContent),
      anchors
    };
  }

  function captureSubmission({ editor, pageUrl, promotedWebsiteUrl, now = Date.now() }) {
    const commentHtml = readEditorHtml(editor);
    const parsed = parseHtml(root.document, commentHtml, pageUrl);
    return {
      submittedAt: now,
      targetPageUrl: String(pageUrl || ''),
      promotedWebsiteUrl: String(promotedWebsiteUrl || ''),
      commentHtml,
      commentText: parsed.commentText,
      anchors: parsed.anchors
    };
  }

  root.AutoCommentHistoryCapture = { captureSubmission, readEditorHtml };
})(globalThis);
