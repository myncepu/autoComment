const SECTION_IDS = new Set(['identity', 'promotion', 'settings']);

export function focusOptionsSection(documentRef, hash) {
  const sectionId = String(hash || '').replace(/^#/, '');
  if (!SECTION_IDS.has(sectionId)) return false;
  const section = documentRef?.getElementById?.(sectionId);
  const heading = section?.querySelector?.('[data-section-heading]');
  if (!section || !heading) return false;

  section.scrollIntoView({ block: 'start' });
  heading.focus({ preventScroll: true });
  return true;
}
