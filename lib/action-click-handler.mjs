const PROMOTE_PANEL_MESSAGE = { type: 'TOGGLE_PROMOTE_PANEL' };

function openOptionsPage({ tabs, runtime }) {
  return tabs.create({ url: runtime.getURL('options.html') });
}

export async function handleActionClick(tab, { tabs, runtime }) {
  if (!Number.isInteger(tab?.id) || tab.id < 0) {
    return openOptionsPage({ tabs, runtime });
  }

  try {
    await tabs.sendMessage(tab.id, PROMOTE_PANEL_MESSAGE);
  } catch {
    return openOptionsPage({ tabs, runtime });
  }
}

export function installActionClickHandler(chromeApi) {
  chromeApi.action.onClicked.addListener((tab) => {
    void handleActionClick(tab, chromeApi).catch(() => {
      console.warn('[action] Promotion panel unavailable');
    });
  });
}
