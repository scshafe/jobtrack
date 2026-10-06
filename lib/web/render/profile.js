'use strict';

// The profile page: sixteen sections over one operator-curated corpus.
//
// The tab strip IS the page header. There is no hero: a title saying "Profile"
// above a nav saying "Contact / Work / Skills" restates the URL at the cost of
// a third of the first screen.
//
// Tabbing works two ways on purpose. On the default view every section is
// already in the document, so a tab is a :target hash — instant, no round
// trip, still a real shareable URL. ?section= stays supported for deep links
// and as the fallback where :has() is unavailable, in which case every section
// simply stays visible. Neither path needs a byte of client JavaScript.
//
// Ordering is curation first, then chronology (lib/web/profile-order.js):
// jobtrack profile set-display is a deliberate statement about importance, and
// the date an entry describes only breaks the remaining ties.

const { escapeHtml, formatToken, formatDate, renderSourceUrl } = require('../html');
const { baseStyles } = require('../styles');
const { appHeader } = require('../nav');
const {
  renderBadge,
  renderEmptyPanel,
  renderInlineTags,
  renderKeyValues
} = require('../vocabulary');
const { renderFilterForm, buildQueryUrl } = require('../toolbar');
const { sortProfileRecordsDesc, sortProfileEntriesDesc } = require('../profile-order');
const { compareCuration } = require('../../profile-presentation');

const PROFILE_STRUCTURED_KEYS = ['work', 'education', 'link', 'skill', 'project', 'credential', 'recognition', 'publication', 'language', 'volunteer', 'answer'];
const PROFILE_SECTION_DEFS = [
  { key: 'contact', nav: 'Contact', title: 'Contact + Summary' },
  { key: 'work', nav: 'Work', title: 'Experience' },
  { key: 'education', nav: 'Education', title: 'Education' },
  { key: 'links', nav: 'Links', title: 'Links' },
  { key: 'skills', nav: 'Skills', title: 'Skills', deck: 'Expand a skill for proficiency, notes, and supporting evidence.' },
  { key: 'projects', nav: 'Projects', title: 'Projects' },
  { key: 'credentials', nav: 'Credentials', title: 'Certifications + Licenses' },
  { key: 'recognitions', nav: 'Awards', title: 'Awards + Honors' },
  { key: 'publications', nav: 'Publications', title: 'Publications + Talks + Patents' },
  { key: 'languages', nav: 'Languages', title: 'Languages' },
  { key: 'volunteer', nav: 'Volunteer', title: 'Volunteer Experience' },
  { key: 'stories', nav: 'Stories', title: 'Stories', deck: 'Permission-aware experience stories, polished revisions, and evidence-safe reuse readiness.' },
  { key: 'answers', nav: 'Answers', title: 'Reusable Application Answers', deck: 'Reusable answers for forms and recurring application prompts.' },
  { key: 'references', nav: 'References', title: 'References', deck: 'Internal-only reference records. Use externally only after explicit approval.' },
  { key: 'eeo', nav: 'EEO', title: 'Optional EEO + Self-ID', deck: 'Optional protected-class/self-ID fields for operator autofill only.' },
  { key: 'flat', nav: 'Other', title: 'Other Profile Evidence', deck: 'Evidence, preferences, resume seeds, and older claims that do not yet have a dedicated structured section.' }
];

function renderProfilePage(context) {
  const { corpus } = context;
  const activeSection = context.activeSection || 'all';
  const sections = buildProfileSections(corpus, context);
  const totalItems = sections.reduce((sum, section) => sum + section.count, 0);
  // Tab strip: 'All' restores the classic stacked view; any other tab renders
  // exactly one section. Links preserve the active filters via buildQueryUrl.
  const tabFilters = { ...context.filters, sort: context.sort, dir: context.dir };
  // On the default ('all') view every section is already in the document, so a
  // tab is a `:target` hash — instant, no round trip, still a real URL you can
  // share. `?section=` stays supported for deep links and as the fallback when
  // `:has()` is unavailable, in which case all sections simply remain visible.
  const cssTabs = activeSection === 'all';
  const tab = (key, label, count) => {
    const href = cssTabs
      ? (key === 'all' ? '#profile-sections' : `#${key}`)
      : buildQueryUrl('/profile', tabFilters, { section: key === 'all' ? null : key });
    const active = !cssTabs && key === activeSection ? ' class="active" aria-current="page"' : '';
    return `<a href="${escapeHtml(href)}"${active}><span>${escapeHtml(label)}</span>${count === null ? '' : `<code>${count}</code>`}</a>`;
  };
  const nav = [tab('all', 'All', null), ...sections.map((section) => tab(section.key, section.nav, section.count))].join('');
  const visibleSections = activeSection === 'all' ? sections : sections.filter((section) => section.key === activeSection);

  // No hero. The tab strip IS the page header: it names every section, carries
  // the counts, and sits directly under the app header as a second pinned bar.
  // A title that says "Profile" above a nav that says "Contact / Work / Skills"
  // was restating the URL at the cost of a third of the first screen.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>JobTrack Profile</title><style>${baseStyles()}</style></head><body class="app-viewport">${appHeader()}
    <a class="skip-link" href="#profile-sections">Skip to profile sections</a>
    <main class="app-main profile-shell"${cssTabs ? ' data-jt-tabs="css"' : ''} data-jt-page="profile" data-jt-count="${escapeHtml(totalItems)}">
      <nav class="jump-nav section-index profile-tabs" aria-label="Profile section tabs" data-jt-tabbar>${nav}</nav>
      <div class="results-region" data-jt-scroll>
        <div class="profile-sections" id="profile-sections">${visibleSections.map(renderProfileSection).join('')}</div>
      </div>
    </main></body></html>`;
}

function buildProfileSections(corpus, context = {}) {
  const sectionData = profileSectionData(corpus, context);
  return PROFILE_SECTION_DEFS.map((definition) => {
    const data = sectionData[definition.key];
    return { ...definition, count: data.count, body: data.body };
  });
}

function profileSectionData(corpus, context = {}) {
  const entries = corpus.entries || [];
  const flatEntries = sortProfileEntriesDesc(entries.filter((entry) => entry.category !== 'story' && !PROFILE_STRUCTURED_KEYS.some((key) => entry[key])));
  const entriesWith = (key) => sortProfileEntriesDesc(entries.filter((entry) => entry[key]));

  return {
    contact: { count: corpus.contact ? 1 : 0, body: renderContactSection(corpus.contact) },
    work: renderEntrySection(entriesWith('work'), renderProfileWorkEntry, "No structured work entries yet.", "jobtrack profile add-work --company NAME --role TITLE"),
    education: renderEntrySection(entriesWith('education'), renderProfileEducationEntry, "No structured education entries yet.", "jobtrack profile add-education --school NAME --degree DEGREE"),
    links: renderEntrySection(entriesWith('link'), renderProfileLinkEntry, "No profile links yet.", "jobtrack profile add-link --kind website --url URL"),
    skills: renderProfileSkillsSection(entriesWith('skill')),
    projects: renderEntrySection(entriesWith('project'), renderProfileProjectEntry, "No projects yet.", "jobtrack profile add-project --name NAME"),
    credentials: renderEntrySection(entriesWith('credential'), renderProfileCredentialEntry, "No certifications or licenses yet.", "jobtrack profile add-certification --name NAME"),
    recognitions: renderEntrySection(entriesWith('recognition'), renderProfileRecognitionEntry, "No awards or honors yet.", "jobtrack profile add-award --title TITLE"),
    publications: renderEntrySection(entriesWith('publication'), renderProfilePublicationEntry, "No publications, talks, or patents yet.", "jobtrack profile add-publication --title TITLE"),
    languages: renderEntrySection(entriesWith('language'), renderProfileLanguageEntry, "No language records yet.", "jobtrack profile add-language --name NAME"),
    volunteer: renderEntrySection(entriesWith('volunteer'), renderProfileVolunteerEntry, "No volunteer experience yet.", "jobtrack profile add-volunteer --organization NAME"),
    stories: renderProfileStoriesSection(sortProfileRecordsDesc(corpus.stories || [], (story) => story.occurred_end || story.occurred_start || story.updated_at || story.created_at), context),
    answers: renderEntrySection(entriesWith('answer'), renderProfileAnswerEntry, "No reusable application answers yet.", "jobtrack profile add-answer --question TEXT --answer TEXT"),
    references: renderEntrySection(sortProfileRecordsDesc(corpus.references || [], (row) => row.updated_at || row.created_at), renderReferenceRow, "No references stored yet.", "jobtrack profile add-reference --name NAME"),
    eeo: { count: corpus.eeo ? 1 : 0, body: renderEeoSection(corpus.eeo) },
    flat: renderEntrySection(flatEntries, renderFlatProfileEntry, "No remaining flat profile entries.", "jobtrack profile add --category CATEGORY --title TITLE")
  };
}

/** One profile section: ordered records, or an empty state with its CLI command. */
function renderEntrySection(records, renderer, emptyMessage, emptyCommand = null) {
  return {
    count: records.length,
    body: records.length ? `<div class="entry-grid">${records.map(renderer).join('')}</div>` : renderEmptyPanel(emptyMessage, emptyCommand)
  };
}

function renderProfileStoriesSection(stories, context) {
  const cards = stories.map((story) => `<article class="entry story-entry">
    <div class="entry-title"><h3><a href="/stories/${story.id}">${escapeHtml(story.title)}</a></h3>${renderBadge(story.status)}</div>
    <p class="entry-subtitle">${escapeHtml(formatToken(story.sensitivity))} · ${escapeHtml(story.default_use_decision)}</p>
    <p class="content">${escapeHtml(story.one_line_summary || story.takeaway || 'Captured story awaiting a polished canonical revision.')}</p>
    ${story.why_it_matters ? `<p class="content"><strong>Why it matters:</strong> ${escapeHtml(story.why_it_matters)}</p>` : ''}
    <p class="activity">${story.capture_count} capture(s) · ${story.variant_count} current variant(s) · ${story.open_question_count} open question(s).</p>
    ${renderInlineTags(story.tags)}
  </article>`).join('');
  const filter = context.filters
    ? renderFilterForm({ action: '/profile', ...context })
    : '';
  return {
    count: stories.length,
    body: `${filter}<div class="entry-grid">${cards || renderEmptyPanel("No stories match these filters.", "jobtrack story capture --title TITLE")}</div>`
  };
}

function renderProfileSection(section) {
  const heading = `
    <div class="section-head">
      <div>
        <h2 id="${escapeHtml(section.key)}-title">${escapeHtml(section.title)}</h2>
        ${section.deck ? `<p>${escapeHtml(section.deck)}</p>` : ''}
      </div>
      <span class="section-count mono">${section.count}</span>
    </div>`;
  const body = ['references', 'eeo'].includes(section.key) && section.count
    ? `<details class="profile-private"><summary>Show private ${section.key === 'eeo' ? 'self-ID information' : 'references'}</summary>${section.body}</details>`
    : section.body;
  return `<section class="profile-section" data-jt-section="${escapeHtml(section.key)}" id="${escapeHtml(section.key)}" aria-labelledby="${escapeHtml(section.key)}-title">${heading}<div class="section-body">${body}</div></section>`;
}

function renderContactSection(contact) {
  if (!contact) return renderEmptyPanel("No contact, headline, summary, or autofill preferences stored yet.", "jobtrack profile set-contact --name NAME --email EMAIL");
  const privateFields = renderKeyValues([
      ['Email', contact.email],
      ['Phone', contact.phone],
      ['Date of birth', contact.date_of_birth],
      ['Work authorization', contact.work_authorization],
      ['Visa sponsorship', contact.visa_sponsorship],
      ['Relocation', contact.relocation_willingness],
      ['Remote preference', contact.remote_preference],
      ['Compensation', contact.compensation_expectations],
      ['Notice period', contact.notice_period],
      ['Earliest start', contact.earliest_start_date]
    ]);
  return `<article class="entry resume-entry profile-contact">
    <div class="resume-heading">
      <h3>${escapeHtml(contact.name || 'Contact profile')}</h3>
      ${contact.headline ? `<p class="profile-headline">${escapeHtml(contact.headline)}</p>` : ''}
      ${renderResumeMeta([contact.location])}
    </div>
    ${renderResumeText(contact.professional_summary)}
    ${renderProfileBadges([{ label: 'Tags', values: contact.tags }])}
    ${privateFields ? `<details class="profile-private"><summary>Contact details &amp; application preferences</summary>${privateFields}</details>` : ''}
    ${renderProfileMetadata(contact)}
  </article>`;
}

function renderFlatProfileEntry(entry) {
  return renderProfileCard(entry, {
    title: entry.title,
    chips: [formatToken(entry.category)],
    chipLabel: 'Category',
    body: renderResumeText(entry.content),
    fields: []
  });
}

function formatProjectRelations(project) {
  const parts = [];
  for (const link of project.relationsOut || []) {
    parts.push(`${link.relation.replace(/_/g, ' ')}: ${link.name}`);
  }
  for (const link of project.relationsIn || []) {
    const inverse = link.relation === 'uses' ? 'used by'
      : link.relation === 'extracted_from' ? 'source of'
        : link.relation === 'part_of' ? 'contains'
          : 'preceded';
    parts.push(`${inverse}: ${link.name}`);
  }
  return parts.length ? parts.join('; ') : null;
}

function formatRepoLinks(links) {
  if (!links?.length) return null;
  return links
    .map((link) => {
      const marks = [link.isPrimary ? 'primary' : link.role, link.visibility === 'private' ? 'private' : null]
        .filter(Boolean).join(', ');
      return `${link.name} (${marks})`;
    })
    .join('; ');
}

function formatSkillLinks(links) {
  if (!links?.length) return null;
  return links
    .map((link) => (link.source && link.source !== 'manual' ? `${link.name} (${link.source})` : link.name))
    .join(', ');
}

function renderProfileWorkEntry(entry) {
  const work = entry.work;
  const company = work.normalizedCompany || work.company;
  return renderProfileCard(entry, {
    title: work.role_title,
    organization: company,
    dates: profileDateRange(work.start_date, work.is_present ? 'Present' : work.end_date),
    subtitle: work.location,
    skills: work.skillLinks,
    body: renderResumeText(work.description) + renderResumeHighlights(work.highlights, [work.description]) + renderWorkDetailOutline(work.detailOutline)
  });
}

/** Nested detail outline under a work entry (collapsed by default). */
function renderWorkDetailOutline(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) return '';
  const count = (items) => items.reduce((sum, item) => sum + 1 + count(item.children || []), 0);
  const list = (items) => `<ul class="detail-outline">${items.map((item) =>
    `<li><span class="mono outline-id">#${escapeHtml(item.id)}</span> ${escapeHtml(item.detail)}${item.children?.length ? list(item.children) : ''}</li>`
  ).join('')}</ul>`;
  return `<details class="work-outline"><summary>Detail outline <span class="pill">${count(nodes)} node(s)</span></summary>${list(nodes)}</details>`;
}

function renderProfileEducationEntry(entry) {
  const education = entry.education;
  const endYear = String(education.end_date || '').match(/\b\d{4}\b/)?.[0];
  return renderProfileCard(entry, {
    title: education.institution,
    subtitle: [education.degree, education.field_of_study].filter(Boolean).join(' in '),
    dates: profileDateRange(education.start_date, education.end_date || education.graduation_year),
    fields: [['Graduated', education.end_date && education.graduation_year && String(education.graduation_year) !== endYear ? education.graduation_year : null]],
    skills: education.skillLinks,
    body: renderResumeText(education.honors) + renderResumeText(education.notes, [education.honors])
  });
}

function renderProfileLinkEntry(entry) {
  const link = entry.link;
  return renderProfileCard(entry, {
    title: link.label || link.kind || entry.title,
    subtitle: link.username,
    chips: [link.kind],
    links: [link.url]
  });
}

function renderProfileSkillsSection(entries) {
  if (!entries.length) return { count: 0, body: renderEmptyPanel('No structured skills yet.', 'jobtrack profile add-skill --name SKILL') };
  // Group only records with equal curation priority. A category must never pull
  // an unpinned/hidden skill ahead of a pinned skill or override explicit order.
  const bands = [];
  let band;
  for (const entry of entries) {
    if (!band || compareCuration(band.first, entry) !== 0) {
      band = { first: entry, groups: new Map() };
      bands.push(band);
    }
    const label = entry.skill.skill_group?.trim() || 'Other skills';
    const key = profileTextKey(label);
    if (!band.groups.has(key)) band.groups.set(key, { label, entries: [] });
    band.groups.get(key).entries.push(entry);
  }
  return {
    count: entries.length,
    body: `<div class="profile-skill-groups">${bands.flatMap((item) => [...item.groups.values()]).map((group) => `<div class="profile-skill-group">
      <h3>${escapeHtml(group.label)}</h3>
      <div class="profile-skill-list">${group.entries.map((entry) => {
        const skill = entry.skill;
        const display = entry.display_status && entry.display_status !== 'visible' ? entry.display_status : null;
        return `<details class="profile-skill">
          <summary><span class="badge profile-badge profile-badge-skill">${escapeHtml(skill.name)}</span>${display ? renderBadge(display) : ''}</summary>
          <div class="profile-skill-detail">
            ${renderResumeMeta([skill.proficiency, skill.years !== null && skill.years !== undefined && skill.years !== '' ? `${skill.years} ${Number(skill.years) === 1 ? 'year' : 'years'}` : null])}
            ${renderResumeText(skill.notes)}
            ${renderProfileBadges([{ label: 'Tags', values: entry.tags }], [skill.name, skill.skill_group, skill.proficiency])}
            ${renderProfileMetadata(entry)}
          </div>
        </details>`;
      }).join('')}</div>
    </div>`).join('')}</div>`
  };
}

function renderProfileProjectEntry(entry) {
  const project = entry.project;
  // Exact linked raw values can be aliases (e.g. TS -> TypeScript). Unresolved
  // stack strings remain stack badges; neither they nor tags become skill claims.
  const linkedValues = new Set((project.skillLinks || []).flatMap((link) => [link.name, link.rawValue]).filter(Boolean).map(profileTextKey));
  const stack = uniqueProfileValues([...(project.normalizedSkills || []), ...(project.stack || [])])
    .filter((value) => !linkedValues.has(profileTextKey(value)));
  return renderProfileCard(entry, {
    title: project.name,
    subtitle: project.role,
    dates: profileDateRange(project.start_date, project.end_date),
    chips: [project.project_kind],
    skills: project.skillLinks,
    stack,
    links: [project.url, ...(project.links || [])],
    evidenceFields: [['Repos', formatRepoLinks(project.repoLinks)], ['Relations', formatProjectRelations(project)]],
    body: renderResumeText(project.description) + renderResumeHighlights(project.highlights, [project.description])
  });
}

function renderProfileCredentialEntry(entry) {
  const credential = entry.credential;
  return renderProfileCard(entry, {
    title: credential.name,
    organization: credential.issuer,
    dates: credential.issued_at,
    chips: [credential.kind],
    fields: [['Credential ID', credential.credential_id], ['License #', credential.license_number], ['Expires', credential.expires_at]],
    links: [credential.url],
    body: renderResumeText(credential.notes)
  });
}

function renderProfileRecognitionEntry(entry) {
  const recognition = entry.recognition;
  return renderProfileCard(entry, {
    title: recognition.title,
    organization: recognition.issuer,
    dates: recognition.awarded_at,
    chips: [recognition.kind],
    links: [recognition.url],
    body: renderResumeText(recognition.description)
  });
}

function renderProfilePublicationEntry(entry) {
  const publication = entry.publication;
  return renderProfileCard(entry, {
    title: publication.title,
    organization: publication.publisher,
    dates: publication.published_at,
    chips: [publication.kind],
    links: [publication.url],
    body: renderResumeText(publication.description)
  });
}

function renderProfileLanguageEntry(entry) {
  const language = entry.language;
  return renderProfileCard(entry, {
    title: language.language,
    chips: [language.proficiency],
    chipLabel: 'Proficiency',
    body: renderResumeText(language.notes)
  });
}

function renderProfileVolunteerEntry(entry) {
  const volunteer = entry.volunteer;
  return renderProfileCard(entry, {
    title: volunteer.role || volunteer.organization,
    organization: volunteer.role ? volunteer.organization : null,
    dates: profileDateRange(volunteer.start_date, volunteer.is_present ? 'Present' : volunteer.end_date),
    subtitle: volunteer.location,
    chips: [volunteer.cause],
    body: renderResumeText(volunteer.description) + renderResumeHighlights(volunteer.highlights, [volunteer.description])
  });
}

function renderProfileAnswerEntry(entry) {
  const answer = entry.answer;
  return renderProfileCard(entry, {
    title: answer.question,
    chips: [answer.answer_category],
    chipLabel: 'Category',
    body: renderResumeText(answer.answer)
  });
}

function renderReferenceRow(reference) {
  return renderProfileCard(reference, {
    title: reference.name,
    subtitle: uniqueProfileValues([reference.title, reference.company, reference.relationship]).join(' · '),
    chips: ['internal-only'],
    fields: [['Contact', reference.contact]],
    body: renderResumeText(reference.notes)
  });
}

function renderEeoSection(eeo) {
  if (!eeo) return renderEmptyPanel("No optional EEO or self-ID values stored.", "jobtrack profile set-eeo --gender VALUE");
  return renderProfileCard(eeo, {
    title: 'Optional self-ID',
    chips: ['internal autofill only'],
    fields: [['Gender', eeo.gender], ['Pronouns', eeo.pronouns], ['Race/ethnicity', eeo.race_ethnicity], ['Veteran', eeo.veteran], ['Disability', eeo.disability]],
    body: renderResumeText(eeo.notes)
  });
}

function renderProfileCard(entry, { title, organization, subtitle, dates, chips = [], chipLabel = 'Type', skills = [], stack = [], links = [], fields = [], evidenceFields = [], body = '' }) {
  const heading = title || entry.title || 'Profile entry';
  const display = entry.display_status && entry.display_status !== 'visible' ? entry.display_status : null;
  return `<article class="entry resume-entry">
    <div class="resume-header">
      <div class="resume-heading">
        <div class="entry-title"><h3>${escapeHtml(heading)}</h3>${display ? renderBadge(display) : ''}</div>
        ${organization && profileTextKey(organization) !== profileTextKey(heading) ? `<p class="resume-organization">${escapeHtml(organization)}</p>` : ''}
        ${renderResumeMeta([subtitle])}
      </div>
      ${dates ? `<p class="resume-dates">${escapeHtml(dates)}</p>` : ''}
    </div>
    ${body}
    ${renderProfileBadges([
      { label: chipLabel, values: chips, kind: 'kind' },
      { label: 'Skills', values: skills.map((link) => link.name), kind: 'skill' },
      { label: 'Stack', values: stack, kind: 'stack' },
      { label: 'Tags', values: entry.tags, kind: 'tag' }
    ], [heading, organization, subtitle])}
    ${renderResumeFacts(fields)}
    ${renderResumeLinks(links)}
    ${renderProfileMetadata(entry, [['Linked skills', formatSkillLinks(skills)], ...evidenceFields])}
  </article>`;
}

function renderProfileMetadata(entry, extraFields = []) {
  const updated = entry.updated_at || entry.created_at;
  return `<details class="profile-evidence"><summary>Source &amp; evidence</summary>${renderKeyValues([
    ['Source', entry.source],
    ['Source link', entry.source_url],
    ['Evidence', entry.evidence],
    ['Recency', entry.recency],
    ['Confidence', formatToken(entry.confidence || 'unverified')],
    ['Attachment', entry.attachment_path],
    ['Updated', updated ? formatDate(updated) : null],
    ...extraFields
  ])}</details>`;
}

// Presentation-only deduplication: never combine records or change evidence.
// Matching ignores case and whitespace, but keeps meaningful punctuation (C++,
// C#, .NET) and only resolves aliases when the linked skill supplies rawValue.
function profileTextKey(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function uniqueProfileValues(values, exclude = []) {
  const seen = new Set(exclude.filter((value) => value !== null && value !== undefined).map(profileTextKey));
  return (values || []).filter((value) => {
    const key = profileTextKey(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function profileDateRange(start, end) {
  return uniqueProfileValues([start, end]).join(' – ');
}

function renderResumeMeta(values) {
  const parts = uniqueProfileValues(values);
  return parts.length ? `<p class="entry-subtitle">${parts.map(escapeHtml).join(' · ')}</p>` : '';
}

function renderProfileBadges(groups, exclude = []) {
  const seen = [...exclude];
  const rows = groups.map(({ label, values, kind = 'tag' }) => {
    const unique = uniqueProfileValues(values, seen);
    seen.push(...unique);
    if (!unique.length) return '';
    return `<div class="profile-badge-group" aria-label="${escapeHtml(label)}"><span class="profile-badge-label">${escapeHtml(label)}</span>${unique.map((value) => `<span class="badge profile-badge profile-badge-${escapeHtml(kind)}">${escapeHtml(value)}</span>`).join('')}</div>`;
  }).join('');
  return rows ? `<div class="profile-badges">${rows}</div>` : '';
}

function renderResumeText(value, exclude = []) {
  if (!value) return '';
  return uniqueProfileValues(String(value).trim().split(/\r?\n\s*\r?\n/), exclude).map((paragraph) => {
    const lines = paragraph.split(/\r?\n/).filter((line) => line.trim());
    if (lines.length && lines.every((line) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(line))) return renderResumeHighlights(paragraph);
    return `<p class="content">${escapeHtml(paragraph.trim())}</p>`;
  }).join('');
}

function renderResumeHighlights(value, exclude = []) {
  if (!value) return '';
  const stripMarker = (text) => String(text).trim().replace(/^(?:[-*•]|\d+[.)])\s+/, '');
  const omit = exclude.filter(Boolean).flatMap((text) => [text, ...String(text).split(/\r?\n/)]).map(stripMarker);
  const items = uniqueProfileValues(String(value).split(/\r?\n/).map(stripMarker), omit);
  return items.length ? `<ul class="resume-highlights">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : '';
}

function renderResumeFacts(pairs) {
  const fields = pairs.filter(([, value]) => value !== undefined && value !== null && value !== '');
  return fields.length ? `<dl class="resume-facts">${fields.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>` : '';
}

function renderResumeLinks(links) {
  // URLs are case-sensitive outside the hostname. Dedupe only exact URLs.
  const unique = [...new Set(links.filter(Boolean).map((link) => String(link).trim()).filter(Boolean))];
  return unique.length ? `<div class="resume-links">${unique.map((link) => `<span>${renderSourceUrl(link)}</span>`).join('')}</div>` : '';
}

module.exports = { PROFILE_SECTION_DEFS, renderProfilePage };
