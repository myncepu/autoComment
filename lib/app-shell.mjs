const NAVIGATION_ITEMS = [
  { id: 'batch', label: '批次', href: 'batch.html' },
  { id: 'history', label: '评论历史', href: 'history.html' },
  { id: 'outlinks', label: '外链数据', href: 'records.html' },
  { id: 'settings', label: '设置', href: 'options.html' }
];

function currentNavigationId(currentUrl) {
  const url = new URL(currentUrl || 'batch.html', 'http://localhost/');
  const page = url.pathname.split('/').pop();
  if (page === 'options.html') return 'settings';
  if (page === 'history.html') return 'history';
  if (page === 'records.html') return 'outlinks';
  return 'batch';
}

export function getAppNavigation(currentUrl) {
  const activeId = currentNavigationId(currentUrl);
  return NAVIGATION_ITEMS.map((item) => ({ ...item, active: item.id === activeId }));
}

function isPlainNavigationClick(event) {
  return event.button === 0
    && !event.defaultPrevented
    && !event.metaKey
    && !event.ctrlKey
    && !event.shiftKey
    && !event.altKey;
}

export function bootAppShell(documentRef, { currentUrl, onNavigate } = {}) {
  const mount = documentRef?.querySelector?.('[data-app-shell]');
  if (!mount) return null;

  const navigation = getAppNavigation(currentUrl || documentRef.location?.href);
  mount.textContent = '';
  mount.className = 'app-shell';
  const routeNavigation = (link, item) => {
    if (typeof onNavigate !== 'function') return;
    link.addEventListener('click', (event) => {
      if (!isPlainNavigationClick(event)) return;
      event.preventDefault();
      onNavigate(item.href, item);
    });
  };

  const bar = documentRef.createElement('div');
  bar.className = 'app-shell__bar';
  const brand = documentRef.createElement('a');
  brand.className = 'app-shell__brand';
  brand.href = 'batch.html';
  brand.textContent = 'Auto Comment';
  routeNavigation(brand, NAVIGATION_ITEMS[0]);
  bar.appendChild(brand);

  const status = documentRef.createElement('p');
  status.className = 'app-shell__status';
  status.textContent = '本地运行';
  bar.appendChild(status);

  const menu = documentRef.createElement('details');
  menu.className = 'app-shell__menu';
  menu.open = !documentRef.defaultView?.matchMedia?.('(max-width: 899px)').matches;
  const summary = documentRef.createElement('summary');
  summary.textContent = '导航';
  menu.appendChild(summary);

  const nav = documentRef.createElement('nav');
  nav.className = 'app-shell__nav';
  nav.setAttribute('aria-label', '插件主导航');
  for (const item of navigation) {
    const link = documentRef.createElement('a');
    link.className = 'app-shell__link';
    link.href = item.href;
    link.textContent = item.label;
    if (item.active) {
      link.setAttribute('aria-current', 'page');
    }
    routeNavigation(link, item);
    nav.appendChild(link);
  }
  menu.appendChild(nav);
  bar.appendChild(menu);
  mount.appendChild(bar);
  return mount;
}
