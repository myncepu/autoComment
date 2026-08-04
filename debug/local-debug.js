(() => {
  'use strict';

  const params = new URLSearchParams(location.hash.slice(1));
  const extensionId = params.get('extensionId') || '';
  const token = params.get('token') || '';
  const logEntries = [];
  let polling = null;
  let inFlight = false;
  let currentBatchId = null;
  let stopArmedUntil = 0;

  const elements = Object.fromEntries([
    'connection',
    'refresh',
    'open',
    'start',
    'pause',
    'resume',
    'reconcile',
    'stop',
    'backgroundStatus',
    'pageStatus',
    'eventLog',
    'exportLog'
  ].map((id) => [id, document.getElementById(id)]));

  history.replaceState(null, '', `${location.pathname}${location.search}`);

  function addLog(kind, payload) {
    logEntries.push({
      timestamp: new Date().toISOString(),
      kind,
      payload
    });
    if (logEntries.length > 500) logEntries.shift();
    elements.eventLog.textContent = logEntries
      .map((entry) => `${entry.timestamp} ${entry.kind} ${JSON.stringify(entry.payload)}`)
      .join('\n');
    elements.eventLog.scrollTop = elements.eventLog.scrollHeight;
  }

  function renderDefinitionList(target, value) {
    const rows = value
      ? Object.entries(value)
      : [['状态', '批次页面未连接']];
    target.replaceChildren(...rows.flatMap(([key, rawValue]) => {
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = key;
      dd.textContent = rawValue && typeof rawValue === 'object'
        ? JSON.stringify(rawValue)
        : String(rawValue ?? '—');
      return [dt, dd];
    }));
  }

  function setConnection(state, label) {
    elements.connection.className = `badge ${state}`;
    elements.connection.textContent = label;
  }

  function setBusy(busy) {
    inFlight = busy;
    for (const id of [
      'refresh',
      'open',
      'start',
      'pause',
      'resume',
      'reconcile',
      'stop'
    ]) {
      elements[id].disabled = busy;
    }
  }

  function send(command, payload = {}) {
    if (!extensionId || !token || !globalThis.chrome?.runtime?.sendMessage) {
      return Promise.resolve({
        ok: false,
        error: 'local_debug_pairing_missing'
      });
    }
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        extensionId,
        {
          type: 'LOCAL_DEBUG_BRIDGE_REQUEST',
          command,
          requestId,
          token,
          ...payload
        },
        (response) => {
          if (chrome.runtime.lastError) {
            resolve({
              ok: false,
              error: chrome.runtime.lastError.message ||
                'local_debug_extension_unreachable'
            });
            return;
          }
          resolve(response || {
            ok: false,
            error: 'local_debug_empty_response'
          });
        }
      );
    });
  }

  async function run(command, { quiet = false, payload = {} } = {}) {
    if (inFlight) return;
    setBusy(true);
    const response = await send(command, payload);
    setBusy(false);
    if (response.ok) {
      setConnection('ok', response.page ? '扩展与批次页已连接' : '扩展已连接');
      renderDefinitionList(elements.backgroundStatus, response.background);
      renderDefinitionList(elements.pageStatus, response.page);
      currentBatchId = response.background?.batchId || null;
      if (!quiet || response.pageError) {
        addLog(command, {
          ok: true,
          pageError: response.pageError || null,
          background: response.background,
          page: response.page
        });
      }
    } else {
      setConnection('error', '连接或命令失败');
      addLog(command, response);
    }
  }

  elements.refresh.addEventListener('click', () => void run('status'));
  elements.open.addEventListener('click', () => void run('open'));
  elements.start.addEventListener('click', () => void run('start'));
  elements.pause.addEventListener('click', () => void run('pause'));
  elements.resume.addEventListener('click', () => void run('resume'));
  elements.reconcile.addEventListener('click', () => void run('reconcile'));
  elements.stop.addEventListener('click', () => {
    if (Date.now() > stopArmedUntil) {
      stopArmedUntil = Date.now() + 5000;
      elements.stop.textContent = '再次点击确认永久停止';
      setTimeout(() => {
        if (Date.now() >= stopArmedUntil) {
          elements.stop.textContent = '永久停止…';
        }
      }, 5100);
      return;
    }
    stopArmedUntil = 0;
    elements.stop.textContent = '永久停止…';
    if (!currentBatchId) {
      addLog('stop', {
        ok: false,
        error: 'batch_not_initialized'
      });
      return;
    }
    void run('stop', {
      payload: {
        batchId: currentBatchId,
        confirmPermanent: true
      }
    });
  });
  elements.exportLog.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({
      exportedAt: new Date().toISOString(),
      extensionId,
      entries: logEntries
    }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `auto-comment-local-debug-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  });

  void run('status');
  polling = setInterval(() => void run('status', { quiet: true }), 3000);
  addEventListener('beforeunload', () => clearInterval(polling), { once: true });
})();
