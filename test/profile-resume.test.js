'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');
const { renderProfilePage } = require('../lib/web/render/profile');

function profileDocument(entries, corpus = {}, context = {}) {
  return new JSDOM(renderProfilePage({
    corpus: { entries, ...corpus }, facets: { tags: [] },
    statusOptions: [], stateOptions: [], workflowOptions: [], ...context
  })).window.document;
}

function primaryText(element) {
  const copy = element.cloneNode(true);
  copy.querySelectorAll('details').forEach((details) => details.remove());
  return copy.textContent;
}

test('resume entries show each fact once while keeping source evidence and detail outlines available', () => {
  const document = profileDocument([{
    id: 1, category: 'work', title: 'Engineer at Example', source: 'operator',
    evidence: 'Verified against the original record.', confidence: 'high',
    tags: ['Leadership', 'leadership', 'C++', 'C#'],
    work: {
      role_title: 'Systems Engineer', company: 'Example', location: 'Remote',
      start_date: 'Jan 2024', is_present: true, end_date: 'Dec 2024',
      description: 'Built reliable systems.',
      highlights: '- Built reliable systems.\n• Reduced incidents by 30%.\n- Reduced incidents by 30%.',
      detailOutline: [{ id: 10, detail: 'Original supporting detail.', children: [] }]
    }
  }]);
  const entry = document.querySelector('#work article');
  const text = primaryText(entry);
  for (const fact of ['Systems Engineer', 'Example', 'Remote', 'Jan 2024', 'Present', 'Built reliable systems.', 'Reduced incidents by 30%.', 'Leadership']) {
    assert.equal(text.split(fact).length - 1, 1, fact);
  }
  assert.doesNotMatch(text, /Dec 2024|id:1|No tags|No evidence note|No attachment/);
  assert.deepEqual([...entry.querySelectorAll('.resume-highlights li')].map((item) => item.textContent), ['Reduced incidents by 30%.']);
  assert.match(entry.querySelector('.profile-evidence').textContent, /Verified against the original record/);
  assert.match(entry.querySelector('.work-outline').textContent, /Original supporting detail/);
  assert.equal(entry.querySelectorAll('details[open]').length, 0);
  assert.deepEqual([...entry.querySelectorAll('.profile-badge')].map((badge) => badge.textContent), ['Leadership', 'C++', 'C#']);
});

test('skill badges honor exact linked aliases without promoting unresolved stack values or tags', () => {
  const document = profileDocument([{
    id: 1, title: 'Toolbox', tags: ['TypeScript', 'Mentoring', 'mentoring'],
    project: {
      name: 'Toolbox', role: 'Builder', start_date: '2025', end_date: '2026', project_kind: 'library',
      description: '<img src=x onerror=alert(1)>', highlights: '- Kept <script> inert.',
      normalizedSkills: ['TypeScript'], stack: ['TS', 'TypeScript', 'UncataloguedTool', 'C++', 'C#'],
      skillLinks: [{ name: 'TypeScript', rawValue: 'TS', source: 'legacy_stack_exact' }],
      url: 'https://example.test/Tool', links: ['https://example.test/Tool', 'https://example.test/tool', 'javascript:alert(1)'],
      repoLinks: [{ name: 'tool', role: 'primary', isPrimary: true }],
      relationsOut: [{ relation: 'uses', name: 'Runtime' }]
    }
  }, {
    id: 2, education: { institution: 'University', degree: 'BS', field_of_study: 'CS', start_date: '2015', end_date: 'Dec 2019', graduation_year: '2020' }
  }]);
  const project = document.querySelector('#projects article');
  const badges = (kind) => [...project.querySelectorAll(`.profile-badge-${kind}`)].map((badge) => badge.textContent);
  assert.deepEqual(badges('skill'), ['TypeScript']);
  assert.deepEqual(badges('stack'), ['UncataloguedTool', 'C++', 'C#']);
  assert.deepEqual(badges('tag'), ['Mentoring']);
  assert.match(project.querySelector('.profile-evidence').textContent, /TypeScript \(legacy_stack_exact\)/);
  assert.match(project.querySelector('.profile-evidence').textContent, /tool \(primary\).*uses: Runtime/s);
  assert.deepEqual([...project.querySelectorAll('.resume-links a')].map((link) => link.getAttribute('href')), ['https://example.test/Tool', 'https://example.test/tool']);
  assert.equal(project.querySelectorAll('img,script,[onerror]').length, 0);
  assert.match(project.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.match(document.querySelector('#education .resume-dates').textContent, /2015 – Dec 2019/);
  assert.match(document.querySelector('#education .resume-facts').textContent, /Graduated2020/);
});

test('grouped skill disclosures retain proficiency, zero years, notes and curation without repeating the group', () => {
  const document = profileDocument([
    { id: 1, display_status: 'visible', skill: { name: 'C++', skill_group: 'Languages', proficiency: 'advanced', years: 1, notes: 'Embedded systems.' } },
    { id: 2, display_status: 'visible', skill: { name: 'TypeScript', skill_group: 'languages', proficiency: 'learning', years: 0 } },
    { id: 3, display_status: 'visible', skill: { name: 'SQLite', skill_group: 'Data', notes: 'Store migrations.' } }
  ]);
  const groups = document.querySelectorAll('.profile-skill-group');
  assert.equal(groups.length, 2);
  const languages = [...groups].find((group) => group.querySelector('h3').textContent.toLowerCase() === 'languages');
  assert.deepEqual([...languages.querySelectorAll('.profile-skill > summary .profile-badge')].map((badge) => badge.textContent), ['TypeScript', 'C++']);
  assert.match(languages.textContent, /0 years/);
  assert.match(languages.textContent, /1 year/);
  assert.match(languages.textContent, /Embedded systems/);
  assert.equal(document.querySelectorAll('.profile-skill[open]').length, 0);
});

test('skill groups cannot move hidden or lower-priority entries ahead of curated entries in other groups', () => {
  const document = profileDocument([
    { id: 1, display_status: 'pinned', display_order: 1, skill: { name: 'A pinned', skill_group: 'A' } },
    { id: 2, display_status: 'pinned', display_order: 2, skill: { name: 'B pinned', skill_group: 'B' } },
    { id: 3, display_status: 'visible', display_order: 1, skill: { name: 'B ordered', skill_group: 'B' } },
    { id: 4, display_status: 'visible', display_order: 2, skill: { name: 'A ordered', skill_group: 'A' } },
    { id: 5, display_status: 'hidden', skill: { name: 'A hidden', skill_group: 'A' } }
  ]);
  assert.deepEqual([...document.querySelectorAll('.profile-skill > summary .profile-badge')].map((badge) => badge.textContent), ['A pinned', 'B pinned', 'B ordered', 'A ordered', 'A hidden']);
  assert.match(document.querySelector('#skills').textContent, /hidden/);
});

test('resume layout preserves hash and query navigation and keeps private information collapsed', () => {
  const corpus = {
    contact: { name: 'Sample Person', headline: 'Systems builder', email: 'sample@example.test', location: 'Remote', compensation_expectations: 'Private compensation' },
    references: [{ name: 'Private Reference', contact: 'reference@example.test' }],
    eeo: { gender: 'Private self-ID' }
  };
  const document = profileDocument([], corpus);
  for (const key of ['contact', 'references', 'eeo']) {
    const section = document.querySelector(`#${key}`);
    assert.ok(section);
    assert.ok(section.querySelector('details.profile-private:not([open])'));
    assert.equal(document.querySelector(`.profile-tabs a[href="#${key}"]`).textContent.startsWith(key === 'eeo' ? 'EEO' : key === 'references' ? 'References' : 'Contact'), true);
  }
  assert.doesNotMatch(primaryText(document.querySelector('#contact')), /sample@example|Private compensation/);
  assert.equal(document.querySelectorAll('script').length, 0);
  const workTab = profileDocument([], {}, { activeSection: 'work', filters: { q: 'Builder' } });
  assert.deepEqual([...workTab.querySelectorAll('[data-jt-section]')].map((section) => section.id), ['work']);
  const educationLink = [...workTab.querySelectorAll('.profile-tabs a')].find((link) => link.textContent.startsWith('Education'));
  const query = new URL(educationLink.getAttribute('href'), 'http://example.test').searchParams;
  assert.equal(query.get('section'), 'education');
  assert.equal(query.get('q'), 'Builder');
});
