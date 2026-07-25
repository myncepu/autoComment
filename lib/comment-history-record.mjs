function normalizeSpace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function assertRequired(condition, field) {
  if (!condition) throw new TypeError(`Invalid required field: ${field}`);
}

function resolveHref(hrefRaw, pageUrl) {
  try {
    const parsed = new URL(hrefRaw, pageUrl);
    return {
      hrefResolved: parsed.href,
      hrefDomain: parsed.hostname.toLowerCase()
    };
  } catch (_) {
    return { hrefResolved: '', hrefDomain: '' };
  }
}

function localArchiveMonth(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function stripHtml(html) {
  const source = String(html || '');
  let text = '';
  let index = 0;

  while (index < source.length) {
    if (source[index] !== '<') {
      text += source[index];
      index += 1;
      continue;
    }

    const tagEnd = findTagEnd(source, index + 1);
    if (tagEnd < 0) {
      text += source.slice(index);
      break;
    }
    text += ' ';
    index = tagEnd + 1;
  }

  return normalizeSpace(text);
}

function findHrefAttribute(attributes) {
  const source = String(attributes || '');
  let index = 0;

  while (index < source.length) {
    while (index < source.length && /\s/.test(source[index])) index += 1;
    if (index >= source.length) break;

    const nameStart = index;
    while (index < source.length && !/[\s=]/.test(source[index])) index += 1;
    const name = source.slice(nameStart, index).toLowerCase();
    while (index < source.length && /\s/.test(source[index])) index += 1;

    let value = '';
    if (source[index] === '=') {
      index += 1;
      while (index < source.length && /\s/.test(source[index])) index += 1;
      const quote = source[index];
      if (quote === '"' || quote === "'") {
        index += 1;
        const valueStart = index;
        while (index < source.length && source[index] !== quote) index += 1;
        value = source.slice(valueStart, index);
        if (source[index] === quote) index += 1;
      } else {
        const valueStart = index;
        while (index < source.length && !/\s/.test(source[index])) index += 1;
        value = source.slice(valueStart, index);
      }
    }

    if (name === 'href') return { found: true, value };
  }

  return { found: false, value: '' };
}

function findTagEnd(source, start) {
  let quote = '';
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return -1;
}

function buildAnchorRecord(anchor, commentId, index, pageUrl) {
  const position = index;
  const hrefRaw = typeof (anchor && anchor.hrefRaw) === 'string' ? anchor.hrefRaw : '';
  const resolved = resolveHref(hrefRaw, pageUrl);
  const anchorText = normalizeSpace(anchor && anchor.anchorText);
  const hrefResolved = typeof (anchor && anchor.hrefResolved) === 'string'
    ? anchor.hrefResolved
    : resolved.hrefResolved;
  const hrefDomain = typeof (anchor && anchor.hrefDomain) === 'string'
    ? anchor.hrefDomain
    : (hrefResolved ? normalizeDomain(hrefResolved) : resolved.hrefDomain);
  return {
    id: `${commentId}:${position}`,
    commentId,
    position,
    anchorText,
    anchorTextNormalized: anchorText.toLowerCase(),
    hrefRaw,
    hrefResolved,
    hrefDomain: normalizeDomain(hrefDomain ? `https://${hrefDomain}` : '')
  };
}

export function makeCommentHistoryId(batchId, urlIndex) {
  return `${batchId}:${urlIndex}`;
}

export function normalizeDomain(value) {
  try {
    return new URL(String(value || '')).hostname.toLowerCase();
  } catch (_) {
    return '';
  }
}

export function buildCommentHistoryRecord(payload, { now = Date.now() } = {}) {
  const { batchId, urlIndex, history } = payload || {};
  assertRequired(typeof batchId === 'string' && batchId.trim() !== '', 'batchId');
  assertRequired(Number.isInteger(urlIndex), 'urlIndex');
  assertRequired(history && typeof history.targetPageUrl === 'string' && history.targetPageUrl !== '', 'targetPageUrl');
  assertRequired(history && typeof history.submittedAt === 'number' && Number.isFinite(history.submittedAt), 'submittedAt');
  assertRequired(history && typeof history.commentHtml === 'string', 'commentHtml');

  const id = makeCommentHistoryId(batchId, urlIndex);
  const commentText = typeof history.commentText === 'string'
    ? history.commentText
    : stripHtml(history.commentHtml);
  const promotedWebsiteUrl = typeof history.promotedWebsiteUrl === 'string'
    ? history.promotedWebsiteUrl
    : '';
  const anchors = Array.isArray(history.anchors)
    ? history.anchors.map((anchor, index) => buildAnchorRecord(anchor, id, index, history.targetPageUrl))
    : [];
  const assignment = {};
  const assignmentFields = [
    'profileId',
    'profileDisplayName',
    'promotionSiteId',
    'promotionSiteName',
    'promotionSiteUrl',
    'assignmentPairId',
    'assignmentSource',
    'configRevision',
    'attemptCount',
    'errorCode',
    'skipReason'
  ];
  if (assignmentFields.some((field) => Object.hasOwn(history, field))) {
    for (const field of assignmentFields) assignment[field] = history[field] ?? null;
  }

  return {
    comment: {
      id,
      batchId,
      urlIndex,
      submittedAt: history.submittedAt,
      archiveMonth: localArchiveMonth(history.submittedAt),
      targetPageUrl: history.targetPageUrl,
      targetDomain: normalizeDomain(history.targetPageUrl),
      promotedWebsiteUrl,
      promotedDomain: normalizeDomain(promotedWebsiteUrl),
      commentHtml: history.commentHtml,
      commentText: normalizeSpace(commentText),
      submitStatus: 'submitted',
      source: history.source === 'legacy' ? 'legacy' : 'live',
      ...assignment,
      createdAt: now,
      updatedAt: now
    },
    anchors
  };
}

function parseLegacyAnchors(html, pageUrl) {
  const anchors = [];
  const source = String(html || '');
  const openingAnchorPattern = /<a\b/gi;
  const closingAnchorPattern = /<\/a\s*>/gi;
  let openingMatch;
  while ((openingMatch = openingAnchorPattern.exec(source))) {
    const attributesStart = openingAnchorPattern.lastIndex;
    const openingEnd = findTagEnd(source, attributesStart);
    if (openingEnd < 0) break;
    closingAnchorPattern.lastIndex = openingEnd + 1;
    const closingMatch = closingAnchorPattern.exec(source);
    if (!closingMatch) break;

    const href = findHrefAttribute(source.slice(attributesStart, openingEnd));
    const hrefRaw = href.value;
    const resolved = href.found ? resolveHref(hrefRaw, pageUrl) : { hrefResolved: '', hrefDomain: '' };
    anchors.push({
      position: anchors.length,
      anchorText: stripHtml(source.slice(openingEnd + 1, closingMatch.index)),
      hrefRaw,
      hrefResolved: resolved.hrefResolved,
      hrefDomain: resolved.hrefDomain
    });
    openingAnchorPattern.lastIndex = closingAnchorPattern.lastIndex;
  }
  return anchors;
}

export function buildLegacyCommentHistoryRecord(entry, batchId) {
  if (!entry || entry.result !== 'success') return null;

  const submittedAt = typeof entry.timestamp === 'number' && Number.isFinite(entry.timestamp)
    ? entry.timestamp
    : Date.now();
  const commentHtml = typeof entry.aiContent === 'string' ? entry.aiContent : '';
  const history = {
    submittedAt,
    targetPageUrl: typeof entry.url === 'string' ? entry.url : '',
    promotedWebsiteUrl: '',
    commentHtml,
    commentText: stripHtml(commentHtml),
    anchors: parseLegacyAnchors(commentHtml, entry.url),
    source: 'legacy'
  };

  return buildCommentHistoryRecord({
    batchId,
    urlIndex: entry.urlIndex,
    history
  }, { now: submittedAt });
}
