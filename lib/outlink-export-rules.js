(function installOutlinkExportRules(root) {
  function normalizeRuleLines(value) {
    const values = Array.isArray(value)
      ? value
      : String(value || '').split(/\r?\n|,/u);
    const seen = new Set();
    return values
      .map((item) => String(item || '').trim().toLowerCase())
      .filter((item) => {
        if (!item || seen.has(item)) return false;
        seen.add(item);
        return true;
      });
  }

  function normalizeDomainRule(value) {
    const text = String(value || '')
      .trim()
      .toLowerCase()
      .replace(/^[*.]+/u, '');
    if (!text) return '';
    try {
      const parsed = new URL(
        /^[a-z][a-z\d+.-]*:\/\//iu.test(text) ? text : `https://${text}`
      );
      return parsed.hostname.replace(/^www\./u, '').replace(/\.$/u, '');
    } catch (_) {
      return text
        .replace(/^[*.]+/u, '')
        .split('/')[0]
        .replace(/^www\./u, '')
        .replace(/\.$/u, '');
    }
  }

  function normalizeRules(value = {}) {
    const domains = new Set(
      normalizeRuleLines(value.excludedDomains)
        .map(normalizeDomainRule)
        .filter(Boolean)
    );
    return {
      excludedDomains: [...domains],
      excludedKeywords: normalizeRuleLines(value.excludedKeywords)
    };
  }

  function hostnameMatchesRule(hostname, rule) {
    const host = normalizeDomainRule(hostname);
    const domain = normalizeDomainRule(rule);
    return Boolean(
      host
      && domain
      && (host === domain || host.endsWith(`.${domain}`))
    );
  }

  function filterOutlinks(outlinks, rawRules = {}) {
    const rules = normalizeRules(rawRules);
    const kept = [];
    const excluded = [];
    for (const link of Array.isArray(outlinks) ? outlinks : []) {
      const host = String(link?.host || '').toLowerCase();
      const searchable = [
        link?.url,
        link?.host,
        link?.text
      ].map((item) => String(item || '').toLowerCase()).join('\n');
      const domainRule = rules.excludedDomains.find((rule) => (
        hostnameMatchesRule(host, rule)
      ));
      const keywordRule = rules.excludedKeywords.find((rule) => (
        searchable.includes(rule)
      ));
      if (domainRule || keywordRule) {
        excluded.push({
          link,
          reason: domainRule ? 'domain' : 'keyword',
          rule: domainRule || keywordRule
        });
      } else {
        kept.push(link);
      }
    }
    return { kept, excluded, rules };
  }

  root.AutoCommentOutlinkRules = Object.freeze({
    normalizeRuleLines,
    normalizeDomainRule,
    normalizeRules,
    hostnameMatchesRule,
    filterOutlinks
  });
})(globalThis);
