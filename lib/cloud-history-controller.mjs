function setText(element, value) {
  if (element) element.textContent = value == null ? '' : String(value);
  return element;
}

function safeHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function textCell(documentRef, value, className = '') {
  const cell = documentRef.createElement('td');
  if (className) cell.className = className;
  return setText(cell, value);
}

function urlCell(documentRef, value) {
  const cell = documentRef.createElement('td');
  cell.className = 'url-cell';
  const safeUrl = safeHttpUrl(value);
  if (!safeUrl) return setText(cell, value || '—');
  const link = documentRef.createElement('a');
  link.href = safeUrl;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  setText(link, value);
  cell.appendChild(link);
  return cell;
}

function formatDateTime(timestamp) {
  if (!Number.isFinite(timestamp)) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(timestamp));
}

function bundleComment(bundle) {
  return bundle?.comment && typeof bundle.comment === 'object'
    ? bundle.comment
    : {};
}

function sourceLabel(source) {
  return source === 'cloud' ? '云端' : '本机';
}

function renderAnchorList(documentRef, container, anchors) {
  const title = documentRef.createElement('strong');
  setText(title, `锚链接（${Array.isArray(anchors) ? anchors.length : 0}）`);
  container.appendChild(title);
  const list = documentRef.createElement('div');
  list.className = 'anchor-list';
  if (!Array.isArray(anchors) || anchors.length === 0) {
    setText(list, '无锚链接');
  } else {
    for (const anchor of anchors) {
      const item = documentRef.createElement('div');
      item.className = 'anchor-item';
      const label = anchor?.anchorText || '（无锚文本）';
      const destination = anchor?.hrefResolved || anchor?.hrefRaw || '无链接';
      setText(item, `${label} → ${destination}`);
      list.appendChild(item);
    }
  }
  container.appendChild(list);
}

export function createCloudHistoryController({
  document: documentRef,
  dataSource,
  confirmDelete = async (message) => globalThis.confirm(message),
  loadLocalAnchors
} = {}) {
  if (!documentRef || typeof dataSource?.deleteEverywhere !== 'function') {
    throw new TypeError('document and dataSource are required');
  }
  const tableBody = documentRef.getElementById('historyTableBody');
  const cloudStatus = documentRef.getElementById('cloudHistoryStatus');
  const pageStatus = documentRef.getElementById('pageStatus');
  const pendingDeletes = new Map();
  const deletedRecordIds = new Set();
  let syncStatus = Object.freeze({ enabled: false });
  let online = true;

  function renderStatus(status = {}, isOnline = true) {
    syncStatus = Object.freeze({ ...status });
    online = isOnline !== false;
    if (syncStatus.state === 'unavailable') {
      setText(
        cloudStatus,
        '云同步状态暂时无法读取；当前仅显示可用的本机评论历史。'
      );
      cloudStatus?.classList.add('offline');
      return;
    }
    if (!syncStatus.enabled) {
      setText(cloudStatus, '云同步未启用；当前显示本机评论历史。');
      cloudStatus?.classList.remove('offline');
      return;
    }
    if (!online) {
      setText(cloudStatus, '当前离线；云端筛选和旧记录暂不可用。');
      cloudStatus?.classList.add('offline');
      return;
    }
    const pending = Number.isInteger(syncStatus.pendingCount)
      ? `，${syncStatus.pendingCount} 条等待同步`
      : '';
    setText(cloudStatus, `云同步已启用${pending}。`);
    cloudStatus?.classList.remove('offline');
  }

  function setDeleteButtonState(recordId, busy) {
    const row = Array.from(
      tableBody?.querySelectorAll('[data-record-id]') ?? []
    ).find((candidate) => candidate.dataset.recordId === recordId);
    const button = row?.querySelector('[data-action="delete-everywhere"]');
    if (!button) return;
    button.disabled = busy;
    if (busy) {
      button.setAttribute('aria-busy', 'true');
      setText(button, '正在永久删除…');
    } else {
      button.removeAttribute('aria-busy');
      setText(button, '从所有设备永久删除');
    }
  }

  function removeRenderedRecord(recordId) {
    for (const row of tableBody?.querySelectorAll('[data-record-id]') ?? []) {
      if (row.dataset.recordId === recordId) {
        const detail = row.nextElementSibling;
        row.remove();
        if (detail?.dataset.detailFor === recordId) detail.remove();
      }
    }
  }

  function renderRecords(records) {
    if (!tableBody) return;
    tableBody.textContent = '';
    const visibleRecords = Array.isArray(records)
      ? records.filter((bundle) => {
          const id = bundleComment(bundle).id;
          return typeof id === 'string' && !deletedRecordIds.has(id);
        })
      : [];
    if (visibleRecords.length === 0) {
      const row = documentRef.createElement('tr');
      const cell = textCell(
        documentRef,
        '没有符合条件的评论历史。',
        'empty-cell'
      );
      cell.colSpan = 7;
      row.appendChild(cell);
      tableBody.appendChild(row);
      return;
    }

    for (const bundle of visibleRecords) {
      const comment = bundleComment(bundle);
      const recordId = comment.id;
      const row = documentRef.createElement('tr');
      row.dataset.recordId = recordId;

      const expandCell = documentRef.createElement('td');
      const expandButton = documentRef.createElement('button');
      expandButton.type = 'button';
      expandButton.className = 'expand-button';
      expandButton.dataset.action = 'expand';
      expandButton.setAttribute('aria-expanded', 'false');
      expandButton.setAttribute('aria-label', '展开评论详情');
      setText(expandButton, '展开');
      expandCell.appendChild(expandButton);
      row.appendChild(expandCell);
      row.appendChild(textCell(
        documentRef,
        formatDateTime(comment.submittedAt),
        'time-cell'
      ));
      row.appendChild(urlCell(documentRef, comment.targetPageUrl));
      row.appendChild(urlCell(documentRef, comment.promotedWebsiteUrl));
      row.appendChild(textCell(
        documentRef,
        comment.commentText || comment.commentHtml,
        'comment-cell'
      ));

      const sourceCell = documentRef.createElement('td');
      const badge = documentRef.createElement('span');
      badge.className = `source-badge source-${bundle.storageSource}`;
      badge.dataset.storageSource = bundle.storageSource;
      setText(badge, sourceLabel(bundle.storageSource));
      sourceCell.appendChild(badge);
      row.appendChild(sourceCell);

      const actionCell = documentRef.createElement('td');
      if (bundle.storageSource === 'cloud' && syncStatus.enabled === true) {
        const deleteButton = documentRef.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'btn-danger permanent-delete-button';
        deleteButton.dataset.action = 'delete-everywhere';
        deleteButton.dataset.recordId = recordId;
        deleteButton.setAttribute(
          'aria-label',
          '从所有设备永久删除这条评论历史'
        );
        setText(deleteButton, '从所有设备永久删除');
        deleteButton.addEventListener('click', () => {
          void deleteEverywhere(recordId);
        });
        actionCell.appendChild(deleteButton);
      }
      row.appendChild(actionCell);

      const detailRow = documentRef.createElement('tr');
      detailRow.className = 'detail-row';
      detailRow.dataset.detailFor = recordId;
      detailRow.hidden = true;
      const detailCell = documentRef.createElement('td');
      detailCell.colSpan = 7;
      const detailContent = documentRef.createElement('div');
      detailContent.className = 'detail-content';

      const storedTitle = documentRef.createElement('strong');
      setText(storedTitle, '完整评论 HTML（按文本显示）');
      detailContent.appendChild(storedTitle);
      const storedHtml = documentRef.createElement('pre');
      storedHtml.className = 'stored-html';
      storedHtml.textContent = comment.commentHtml || comment.commentText || '';
      detailContent.appendChild(storedHtml);
      if (Array.isArray(bundle.anchors)) {
        renderAnchorList(documentRef, detailContent, bundle.anchors);
        detailContent.dataset.loaded = 'true';
      }
      detailCell.appendChild(detailContent);
      detailRow.appendChild(detailCell);

      expandButton.addEventListener('click', () => {
        const expanded = expandButton.getAttribute('aria-expanded') === 'true';
        expandButton.setAttribute('aria-expanded', String(!expanded));
        expandButton.setAttribute(
          'aria-label',
          expanded ? '展开评论详情' : '收起评论详情'
        );
        setText(expandButton, expanded ? '展开' : '收起');
        detailRow.hidden = expanded;
        if (
          !expanded
          && !detailContent.dataset.loaded
          && typeof loadLocalAnchors === 'function'
        ) {
          detailContent.dataset.loaded = 'loading';
          Promise.resolve(loadLocalAnchors(recordId)).then(
            (anchors) => {
              renderAnchorList(documentRef, detailContent, anchors);
              detailContent.dataset.loaded = 'true';
            },
            () => {
              const error = documentRef.createElement('div');
              error.className = 'detail-error';
              setText(error, '锚链接加载失败，请稍后重试。');
              detailContent.appendChild(error);
              detailContent.dataset.loaded = 'error';
            }
          );
        }
      });

      tableBody.append(row, detailRow);
      setDeleteButtonState(recordId, pendingDeletes.has(recordId));
    }
  }

  function deleteEverywhere(recordId) {
    if (pendingDeletes.has(recordId)) return pendingDeletes.get(recordId);
    const operation = (async () => {
      let deleteStarted = false;
      try {
        const confirmed = await confirmDelete(
          '确认从所有已连接设备永久删除这条评论历史？'
        );
        if (!confirmed) return false;
        deleteStarted = true;
        setDeleteButtonState(recordId, true);
        const result = await dataSource.deleteEverywhere(recordId);
        if (!['applied', 'duplicate', 'stale'].includes(result?.status)) {
          throw new Error('unexpected deletion response');
        }
        deletedRecordIds.add(recordId);
        removeRenderedRecord(recordId);
        setText(pageStatus, '已从所有设备永久删除该条评论历史。');
        pageStatus?.classList.remove('error');
        return true;
      } catch {
        setText(
          pageStatus,
          deleteStarted
            ? '永久删除失败，请稍后重试。'
            : '删除确认失败，请稍后重试。'
        );
        pageStatus?.classList.add('error');
        return false;
      } finally {
        pendingDeletes.delete(recordId);
        setDeleteButtonState(recordId, false);
      }
    })();
    pendingDeletes.set(recordId, operation);
    return operation;
  }

  return Object.freeze({
    renderStatus,
    renderRecords,
    deleteEverywhere
  });
}
