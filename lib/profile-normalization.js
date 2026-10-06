'use strict';

const crypto = require('node:crypto');
const { normalizeCatalogText } = require('./catalog');

const PROFILE_NORMALIZATION_SCHEMA_VERSION = 2026071714;
const PROFILE_NORMALIZATION_MIGRATION_NAME = 'normalized_profile_facets_and_information_gaps';
const PROFILE_NORMALIZATION_USER_VERSION = 9;

const SECTION_SEEDS = [
  ['work', 'Work', 10], ['education', 'Education', 20], ['skill', 'Skills', 30],
  ['project', 'Projects', 40], ['accomplishment', 'Accomplishments', 50],
  ['story', 'Stories', 60], ['preference', 'Preferences', 70], ['link', 'Links', 80],
  ['evidence', 'Evidence', 90], ['resume', 'Resumes', 100], ['other', 'Other', 999]
];
const CONFIDENCE_SEEDS = [
  ['unverified', 'Unverified', 0], ['low', 'Low', 10], ['medium', 'Medium', 20], ['high', 'High', 30]
];
const PROFICIENCY_SEEDS = [
  ['unassessed', 'Unassessed', 0], ['novice', 'Novice', 10], ['beginner', 'Beginner', 20],
  ['elementary', 'Elementary', 25], ['intermediate', 'Intermediate', 30],
  ['conversational', 'Conversational', 35], ['advanced', 'Advanced', 40],
  ['professional', 'Professional', 45], ['fluent', 'Fluent', 50],
  ['expert', 'Expert', 60], ['native', 'Native / bilingual', 70]
];
const LINK_KIND_SEEDS = [
  ['github', 'GitHub'], ['linkedin', 'LinkedIn'], ['portfolio', 'Portfolio'],
  ['personal-website', 'Personal website'], ['other', 'Other']
];
const CREDENTIAL_KIND_SEEDS = [['certification', 'Certification'], ['license', 'License'], ['other', 'Other']];
const RECOGNITION_KIND_SEEDS = [['award', 'Award'], ['honor', 'Honor'], ['other', 'Other']];
const PUBLICATION_KIND_SEEDS = [['publication', 'Publication'], ['talk', 'Talk'], ['patent', 'Patent'], ['other', 'Other']];

const INFORMATION_FIELD_SEEDS = [
  ['name', 'Legal or preferred name', 'text', 'personal', 'contact', 'name'],
  ['email', 'Email address', 'email', 'personal', 'contact', 'email'],
  ['phone', 'Phone number', 'phone', 'personal', 'contact', 'phone'],
  ['location', 'Current location', 'text', 'personal', 'contact', 'location'],
  ['address-street', 'Street address', 'text', 'personal', 'contact', 'address_street'],
  ['address-city', 'Address city', 'text', 'personal', 'contact', 'address_city'],
  ['address-state', 'Address state or region', 'text', 'personal', 'contact', 'address_state'],
  ['address-postal', 'Postal code', 'text', 'personal', 'contact', 'address_postal'],
  ['address-country', 'Address country', 'text', 'personal', 'contact', 'address_country'],
  ['work-authorization', 'Work authorization', 'choice', 'sensitive', 'contact', 'work_authorization'],
  ['visa-sponsorship', 'Visa sponsorship requirement', 'choice', 'sensitive', 'contact', 'visa_sponsorship'],
  ['relocation-willingness', 'Relocation willingness', 'choice', 'personal', 'contact', 'relocation_willingness'],
  ['remote-preference', 'Remote-work preference', 'choice', 'standard', 'contact', 'remote_preference'],
  ['compensation-expectations', 'Compensation expectations', 'money', 'sensitive', 'contact', 'compensation_expectations'],
  ['notice-period', 'Notice period', 'text', 'standard', 'contact', 'notice_period'],
  ['earliest-start-date', 'Earliest start date', 'date', 'standard', 'contact', 'earliest_start_date'],
  ['professional-summary', 'Professional summary', 'long-text', 'standard', 'contact', 'professional_summary'],
  ['resume', 'Resume', 'document', 'standard', 'section', 'resume'],
  ['cover-letter', 'Cover letter', 'document', 'standard', null, null],
  ['portfolio-url', 'Portfolio URL', 'url', 'standard', 'link', 'portfolio'],
  ['linkedin-url', 'LinkedIn URL', 'url', 'standard', 'link', 'linkedin'],
  ['github-url', 'GitHub URL', 'url', 'standard', 'link', 'github'],
  ['references', 'Professional references', 'record-set', 'sensitive', 'record', 'references'],
  ['education-history', 'Education history', 'record-set', 'standard', 'section', 'education'],
  ['employment-history', 'Employment history', 'record-set', 'standard', 'section', 'work'],
  ['skill-evidence', 'Skill evidence', 'record-set', 'standard', 'section', 'skill'],
  ['demographic-information', 'Voluntary demographic information', 'record-set', 'highly-sensitive', 'record', 'eeo'],
  ['background-check-consent', 'Background-check consent', 'boolean', 'highly-sensitive', null, null],
  ['security-clearance', 'Security clearance', 'choice', 'sensitive', null, null],
  // Per-question voluntary self-identification fields (2026-08-04). Real
  // application forms ask these as SEPARATE questions, so form observations
  // need per-question registry slugs to map onto — the aggregate
  // 'demographic-information' record above remains for whole-record use.
  // Every one of these is voluntary on a real form: "Decline to self-identify"
  // is always a legitimate answer, and the protected-field safety rules keep
  // the ANSWERS human-authored.
  ['english-fluency', 'English fluency', 'choice', 'personal', 'record', 'languages'],
  ['gender', 'Gender (voluntary self-identification)', 'choice', 'highly-sensitive', 'record', 'eeo'],
  ['pronouns', 'Pronouns', 'text', 'personal', 'record', 'eeo'],
  ['race-ethnicity', 'Race or ethnicity (voluntary self-identification)', 'choice', 'highly-sensitive', 'record', 'eeo'],
  ['veteran-status', 'Protected veteran status (voluntary self-identification)', 'choice', 'highly-sensitive', 'record', 'eeo'],
  ['disability-status', 'Disability status (voluntary self-identification, CC-305)', 'choice', 'highly-sensitive', 'record', 'eeo'],
  ['date-of-birth', 'Date of birth', 'date', 'highly-sensitive', 'contact', 'date_of_birth']
];

class ProfileNormalizationError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'ProfileNormalizationError';
    this.code = code;
    this.details = details;
  }
}

function migrateProfileNormalization(db) {
  const apply = () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS jobtrack_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS profile_section_types (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        sort_rank INTEGER NOT NULL,
        CHECK (trim(slug)<>''), CHECK (trim(label)<>'')
      );
      CREATE TABLE IF NOT EXISTS profile_confidence_levels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        sort_rank INTEGER NOT NULL,
        CHECK (trim(slug)<>''), CHECK (trim(label)<>'')
      );
      CREATE TABLE IF NOT EXISTS profile_proficiency_levels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        sort_rank INTEGER NOT NULL,
        CHECK (trim(slug)<>''), CHECK (trim(label)<>'')
      );
      CREATE TABLE IF NOT EXISTS profile_proficiency_domains (
        id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, label TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS profile_proficiency_level_domains (
        profile_proficiency_level_id INTEGER NOT NULL REFERENCES profile_proficiency_levels(id) ON DELETE CASCADE,
        profile_proficiency_domain_id INTEGER NOT NULL REFERENCES profile_proficiency_domains(id) ON DELETE RESTRICT,
        PRIMARY KEY(profile_proficiency_level_id,profile_proficiency_domain_id)
      );
      CREATE TABLE IF NOT EXISTS profile_link_kinds (
        id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, label TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS profile_credential_kinds (
        id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, label TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS profile_recognition_kinds (
        id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, label TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS profile_publication_kinds (
        id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, label TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS organization_types (
        id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, label TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS organizations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        canonical_name TEXT NOT NULL,
        normalized_name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (trim(canonical_name)<>''), CHECK (trim(normalized_name)<>'')
      );
      CREATE TABLE IF NOT EXISTS organization_aliases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        alias TEXT NOT NULL,
        normalized_alias TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (trim(alias)<>''), CHECK (trim(normalized_alias)<>'')
      );
      CREATE TABLE IF NOT EXISTS organization_type_links (
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        organization_type_id INTEGER NOT NULL REFERENCES organization_types(id) ON DELETE RESTRICT,
        source TEXT NOT NULL DEFAULT 'exact_profile_field',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(organization_id,organization_type_id)
      );
      CREATE TABLE IF NOT EXISTS organization_company_links (
        organization_id INTEGER PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
        company_id INTEGER NOT NULL UNIQUE REFERENCES companies(id) ON DELETE RESTRICT,
        match_kind TEXT NOT NULL DEFAULT 'exact_normalized' CHECK (match_kind='exact_normalized'),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS profile_work_authorization_types (
        id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, label TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS profile_sponsorship_requirement_types (
        id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, label TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS profile_relocation_preference_types (
        id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, label TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS profile_work_arrangement_types (
        id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, label TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS profile_answer_categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, label TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tag_cardinalities (
        id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, label TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tag_value_kinds (
        id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, label TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tag_lifecycle_statuses (
        id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, label TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tag_namespace_sensitivity_levels (
        id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, label TEXT NOT NULL, sort_rank INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tag_entity_kinds (
        id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, label TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tag_namespaces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        description TEXT,
        cardinality_id INTEGER NOT NULL REFERENCES tag_cardinalities(id) ON DELETE RESTRICT,
        value_kind_id INTEGER NOT NULL REFERENCES tag_value_kinds(id) ON DELETE RESTRICT,
        status_id INTEGER NOT NULL REFERENCES tag_lifecycle_statuses(id) ON DELETE RESTRICT,
        sensitivity_level_id INTEGER NOT NULL REFERENCES tag_namespace_sensitivity_levels(id) ON DELETE RESTRICT,
        allows_new_values INTEGER NOT NULL DEFAULT 0 CHECK (allows_new_values IN (0,1)),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (trim(slug)<>''), CHECK (trim(label)<>'')
      );
      CREATE TABLE IF NOT EXISTS tag_namespace_entity_kinds (
        tag_namespace_id INTEGER NOT NULL REFERENCES tag_namespaces(id) ON DELETE CASCADE,
        tag_entity_kind_id INTEGER NOT NULL REFERENCES tag_entity_kinds(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(tag_namespace_id,tag_entity_kind_id)
      );
      CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tag_namespace_id INTEGER NOT NULL REFERENCES tag_namespaces(id) ON DELETE RESTRICT,
        slug TEXT NOT NULL,
        label TEXT NOT NULL,
        normalized_label TEXT NOT NULL,
        status_id INTEGER NOT NULL REFERENCES tag_lifecycle_statuses(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (trim(slug)<>''), CHECK (length(slug)<=250),
        CHECK (trim(label)<>''), CHECK (length(label)<=200),
        CHECK (trim(normalized_label)<>''), CHECK (length(normalized_label)<=250),
        UNIQUE(tag_namespace_id,slug), UNIQUE(tag_namespace_id,normalized_label)
      );

      CREATE TABLE IF NOT EXISTS profile_entry_tags (
        profile_entry_id INTEGER NOT NULL REFERENCES profile_entries(id) ON DELETE CASCADE,
        tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE RESTRICT,
        source TEXT NOT NULL,
        confidence REAL CHECK (confidence IS NULL OR (confidence>=0 AND confidence<=1)),
        evidence TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(profile_entry_id,tag_id), CHECK (trim(source)<>''), CHECK (length(source)<=200), CHECK (evidence IS NULL OR length(evidence)<=20000)
      );
      CREATE TABLE IF NOT EXISTS profile_contact_tags (
        profile_contact_id INTEGER NOT NULL REFERENCES profile_contact(id) ON DELETE CASCADE,
        tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE RESTRICT,
        source TEXT NOT NULL,
        confidence REAL CHECK (confidence IS NULL OR (confidence>=0 AND confidence<=1)),
        evidence TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(profile_contact_id,tag_id), CHECK (trim(source)<>''), CHECK (length(source)<=200), CHECK (evidence IS NULL OR length(evidence)<=20000)
      );
      CREATE TABLE IF NOT EXISTS profile_reference_tags (
        profile_reference_id INTEGER NOT NULL REFERENCES profile_references(id) ON DELETE CASCADE,
        tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE RESTRICT,
        source TEXT NOT NULL,
        confidence REAL CHECK (confidence IS NULL OR (confidence>=0 AND confidence<=1)),
        evidence TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(profile_reference_id,tag_id), CHECK (trim(source)<>''), CHECK (length(source)<=200), CHECK (evidence IS NULL OR length(evidence)<=20000)
      );
      CREATE TABLE IF NOT EXISTS profile_eeo_tags (
        profile_eeo_id INTEGER NOT NULL REFERENCES profile_eeo(id) ON DELETE CASCADE,
        tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE RESTRICT,
        source TEXT NOT NULL,
        confidence REAL CHECK (confidence IS NULL OR (confidence>=0 AND confidence<=1)),
        evidence TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(profile_eeo_id,tag_id), CHECK (trim(source)<>''), CHECK (length(source)<=200), CHECK (evidence IS NULL OR length(evidence)<=20000)
      );
      CREATE TABLE IF NOT EXISTS application_tags (
        application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE RESTRICT,
        source TEXT NOT NULL,
        confidence REAL CHECK (confidence IS NULL OR (confidence>=0 AND confidence<=1)),
        evidence TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(application_id,tag_id), CHECK (trim(source)<>''), CHECK (length(source)<=200), CHECK (evidence IS NULL OR length(evidence)<=20000)
      );
      CREATE TABLE IF NOT EXISTS opening_tags (
        job_opening_id INTEGER NOT NULL REFERENCES job_openings(id) ON DELETE CASCADE,
        tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE RESTRICT,
        source TEXT NOT NULL,
        confidence REAL CHECK (confidence IS NULL OR (confidence>=0 AND confidence<=1)),
        evidence TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(job_opening_id,tag_id), CHECK (trim(source)<>''), CHECK (length(source)<=200), CHECK (evidence IS NULL OR length(evidence)<=20000)
      );
      CREATE TABLE IF NOT EXISTS opportunity_tag_links (
        opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
        tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE RESTRICT,
        source TEXT NOT NULL,
        confidence REAL CHECK (confidence IS NULL OR (confidence>=0 AND confidence<=1)),
        evidence TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(opportunity_id,tag_id), CHECK (trim(source)<>''), CHECK (length(source)<=200), CHECK (evidence IS NULL OR length(evidence)<=20000)
      );
      CREATE TABLE IF NOT EXISTS discovery_proposal_tags (
        discovery_proposal_id INTEGER NOT NULL REFERENCES discovery_import_proposals(id) ON DELETE RESTRICT,
        tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE RESTRICT,
        source TEXT NOT NULL,
        confidence REAL CHECK (confidence IS NULL OR (confidence>=0 AND confidence<=1)),
        evidence TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(discovery_proposal_id,tag_id), CHECK (trim(source)<>''), CHECK (length(source)<=200), CHECK (evidence IS NULL OR length(evidence)<=20000)
      );

      CREATE TABLE IF NOT EXISTS profile_project_skills (
        profile_project_id INTEGER NOT NULL REFERENCES profile_projects(id) ON DELETE CASCADE,
        skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
        raw_value TEXT NOT NULL,
        position INTEGER NOT NULL CHECK (position>=0),
        source TEXT NOT NULL DEFAULT 'legacy_stack_exact',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(profile_project_id,skill_id), CHECK (trim(raw_value)<>'')
      );

      CREATE TABLE IF NOT EXISTS information_value_kinds (
        id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, label TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS information_sensitivity_levels (
        id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, label TEXT NOT NULL, sort_rank INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS information_assessment_states (
        id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, label TEXT NOT NULL, is_gap INTEGER NOT NULL CHECK (is_gap IN (0,1))
      );
      CREATE TABLE IF NOT EXISTS information_requiredness_levels (
        id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, label TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS information_resolution_kinds (
        id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, label TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS profile_information_fields (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        value_kind_id INTEGER NOT NULL REFERENCES information_value_kinds(id) ON DELETE RESTRICT,
        sensitivity_level_id INTEGER NOT NULL REFERENCES information_sensitivity_levels(id) ON DELETE RESTRICT,
        profile_source_kind TEXT CHECK (profile_source_kind IS NULL OR profile_source_kind IN ('contact','section','link','record')),
        profile_source_key TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (trim(slug)<>''), CHECK (trim(label)<>'')
      );

      CREATE TABLE IF NOT EXISTS application_information_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
        information_field_id INTEGER NOT NULL REFERENCES profile_information_fields(id) ON DELETE RESTRICT,
        requiredness_id INTEGER NOT NULL REFERENCES information_requiredness_levels(id) ON DELETE RESTRICT,
        requested_label TEXT,
        raw_prompt TEXT,
        source TEXT NOT NULL,
        source_url TEXT,
        opportunity_snapshot_id INTEGER REFERENCES opportunity_snapshots(id) ON DELETE RESTRICT,
        job_posting_id INTEGER REFERENCES job_postings(id) ON DELETE RESTRICT,
        request_sha256 TEXT NOT NULL CHECK (length(request_sha256)=64),
        intent_sha256 TEXT NOT NULL CHECK (length(intent_sha256)=64),
        idempotency_key TEXT NOT NULL UNIQUE,
        observed_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (trim(source)<>''), CHECK (length(source)<=200), CHECK (length(idempotency_key)<=200),
        CHECK (requested_label IS NOT NULL OR raw_prompt IS NOT NULL),
        CHECK (requested_label IS NULL OR length(requested_label)<=500), CHECK (raw_prompt IS NULL OR length(raw_prompt)<=20000),
        CHECK (source_url IS NULL OR length(source_url)<=2048),
        UNIQUE(application_id,request_sha256)
      );
      CREATE TABLE IF NOT EXISTS opportunity_information_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE RESTRICT,
        information_field_id INTEGER NOT NULL REFERENCES profile_information_fields(id) ON DELETE RESTRICT,
        requiredness_id INTEGER NOT NULL REFERENCES information_requiredness_levels(id) ON DELETE RESTRICT,
        requested_label TEXT,
        raw_prompt TEXT,
        source TEXT NOT NULL,
        source_url TEXT,
        opportunity_snapshot_id INTEGER REFERENCES opportunity_snapshots(id) ON DELETE RESTRICT,
        job_posting_id INTEGER REFERENCES job_postings(id) ON DELETE RESTRICT,
        request_sha256 TEXT NOT NULL CHECK (length(request_sha256)=64),
        intent_sha256 TEXT NOT NULL CHECK (length(intent_sha256)=64),
        idempotency_key TEXT NOT NULL UNIQUE,
        observed_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (trim(source)<>''), CHECK (length(source)<=200), CHECK (length(idempotency_key)<=200),
        CHECK (requested_label IS NOT NULL OR raw_prompt IS NOT NULL),
        CHECK (requested_label IS NULL OR length(requested_label)<=500), CHECK (raw_prompt IS NULL OR length(raw_prompt)<=20000),
        CHECK (source_url IS NULL OR length(source_url)<=2048),
        UNIQUE(opportunity_id,request_sha256)
      );
      CREATE TABLE IF NOT EXISTS application_information_assessments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id INTEGER NOT NULL REFERENCES application_information_requests(id) ON DELETE RESTRICT,
        assessment_state_id INTEGER NOT NULL REFERENCES information_assessment_states(id) ON DELETE RESTRICT,
        resolved_profile_entry_id INTEGER REFERENCES profile_entries(id) ON DELETE RESTRICT,
        resolution_kind_id INTEGER NOT NULL REFERENCES information_resolution_kinds(id) ON DELETE RESTRICT,
        resolution_key TEXT NOT NULL,
        resolution_sha256 TEXT NOT NULL CHECK (length(resolution_sha256)=64),
        assessed_by TEXT NOT NULL,
        rationale TEXT,
        evidence TEXT,
        assessment_sha256 TEXT NOT NULL CHECK (length(assessment_sha256)=64),
        intent_sha256 TEXT NOT NULL CHECK (length(intent_sha256)=64),
        idempotency_key TEXT NOT NULL UNIQUE,
        assessed_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (trim(assessed_by)<>''), CHECK (length(assessed_by)<=200), CHECK (length(resolution_key)<=500),
        CHECK (rationale IS NULL OR length(rationale)<=20000), CHECK (evidence IS NULL OR length(evidence)<=20000),
        CHECK (length(idempotency_key)<=200), UNIQUE(request_id,assessment_sha256)
      );
      CREATE TABLE IF NOT EXISTS opportunity_information_assessments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id INTEGER NOT NULL REFERENCES opportunity_information_requests(id) ON DELETE RESTRICT,
        assessment_state_id INTEGER NOT NULL REFERENCES information_assessment_states(id) ON DELETE RESTRICT,
        resolved_profile_entry_id INTEGER REFERENCES profile_entries(id) ON DELETE RESTRICT,
        resolution_kind_id INTEGER NOT NULL REFERENCES information_resolution_kinds(id) ON DELETE RESTRICT,
        resolution_key TEXT NOT NULL,
        resolution_sha256 TEXT NOT NULL CHECK (length(resolution_sha256)=64),
        assessed_by TEXT NOT NULL,
        rationale TEXT,
        evidence TEXT,
        assessment_sha256 TEXT NOT NULL CHECK (length(assessment_sha256)=64),
        intent_sha256 TEXT NOT NULL CHECK (length(intent_sha256)=64),
        idempotency_key TEXT NOT NULL UNIQUE,
        assessed_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (trim(assessed_by)<>''), CHECK (length(assessed_by)<=200), CHECK (length(resolution_key)<=500),
        CHECK (rationale IS NULL OR length(rationale)<=20000), CHECK (evidence IS NULL OR length(evidence)<=20000),
        CHECK (length(idempotency_key)<=200), UNIQUE(request_id,assessment_sha256)
      );

      CREATE INDEX IF NOT EXISTS idx_tags_namespace_label ON tags(tag_namespace_id,normalized_label);
      CREATE INDEX IF NOT EXISTS idx_profile_entry_tags_tag ON profile_entry_tags(tag_id,profile_entry_id);
      CREATE INDEX IF NOT EXISTS idx_application_tags_tag ON application_tags(tag_id,application_id);
      CREATE INDEX IF NOT EXISTS idx_opening_tags_tag ON opening_tags(tag_id,job_opening_id);
      CREATE INDEX IF NOT EXISTS idx_opportunity_tag_links_tag ON opportunity_tag_links(tag_id,opportunity_id);
      CREATE INDEX IF NOT EXISTS idx_discovery_proposal_tags_tag ON discovery_proposal_tags(tag_id,discovery_proposal_id);
      CREATE INDEX IF NOT EXISTS idx_profile_project_skills_skill ON profile_project_skills(skill_id,profile_project_id);
      CREATE INDEX IF NOT EXISTS idx_application_info_requests_target ON application_information_requests(application_id,information_field_id,observed_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS idx_opportunity_info_requests_target ON opportunity_information_requests(opportunity_id,information_field_id,observed_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS idx_application_info_assessments_request ON application_information_assessments(request_id,id DESC);
      CREATE INDEX IF NOT EXISTS idx_opportunity_info_assessments_request ON opportunity_information_assessments(request_id,id DESC);
      CREATE INDEX IF NOT EXISTS idx_application_info_assessments_state ON application_information_assessments(assessment_state_id,request_id);
      CREATE INDEX IF NOT EXISTS idx_opportunity_info_assessments_state ON opportunity_information_assessments(assessment_state_id,request_id);
    `);

    ensureColumn(db, 'profile_entries', 'profile_section_type_id', 'INTEGER REFERENCES profile_section_types(id)');
    ensureColumn(db, 'profile_entries', 'profile_confidence_level_id', 'INTEGER REFERENCES profile_confidence_levels(id)');
    ensureColumn(db, 'profile_contact', 'profile_confidence_level_id', 'INTEGER REFERENCES profile_confidence_levels(id)');
    ensureColumn(db, 'profile_contact', 'date_of_birth', 'TEXT');
    ensureColumn(db, 'profile_contact', 'work_authorization_type_id', 'INTEGER REFERENCES profile_work_authorization_types(id)');
    ensureColumn(db, 'profile_contact', 'sponsorship_requirement_type_id', 'INTEGER REFERENCES profile_sponsorship_requirement_types(id)');
    ensureColumn(db, 'profile_contact', 'relocation_preference_type_id', 'INTEGER REFERENCES profile_relocation_preference_types(id)');
    ensureColumn(db, 'profile_contact', 'work_arrangement_type_id', 'INTEGER REFERENCES profile_work_arrangement_types(id)');
    // Postal address (2026-08-21): application review surfaces require it as
    // discrete fields, and an honest apply worker must read it rather than
    // invent it. Personal-sensitivity contact data like phone/location.
    ensureColumn(db, 'profile_contact', 'address_street', 'TEXT');
    ensureColumn(db, 'profile_contact', 'address_city', 'TEXT');
    ensureColumn(db, 'profile_contact', 'address_state', 'TEXT');
    ensureColumn(db, 'profile_contact', 'address_postal', 'TEXT');
    ensureColumn(db, 'profile_contact', 'address_country', 'TEXT');
    ensureColumn(db, 'profile_references', 'profile_confidence_level_id', 'INTEGER REFERENCES profile_confidence_levels(id)');
    ensureColumn(db, 'profile_references', 'company_id', 'INTEGER REFERENCES companies(id)');
    ensureColumn(db, 'profile_eeo', 'profile_confidence_level_id', 'INTEGER REFERENCES profile_confidence_levels(id)');
    ensureColumn(db, 'profile_work_entries', 'company_id', 'INTEGER REFERENCES companies(id)');
    ensureColumn(db, 'profile_work_entries', 'organization_id', 'INTEGER REFERENCES organizations(id)');
    // Work-experience detail outlines (2026-08-05): arbitrarily nested bullet
    // outlines per work entry — comprehensive specifics beside the curated
    // highlights, addressable per node so later generations can pull EXACT
    // details matched to a posting's requirements.
    db.exec(`
      CREATE TABLE IF NOT EXISTS profile_work_entry_details (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_entry_id INTEGER NOT NULL REFERENCES profile_work_entries(id) ON DELETE RESTRICT,
        parent_detail_id INTEGER REFERENCES profile_work_entry_details(id) ON DELETE RESTRICT,
        position INTEGER NOT NULL CHECK (position>=1),
        detail TEXT NOT NULL CHECK (trim(detail)<>'' AND length(detail)<=4000),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        uuid TEXT,
        UNIQUE(work_entry_id, parent_detail_id, position)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_work_entry_details_root_position
        ON profile_work_entry_details(work_entry_id, position) WHERE parent_detail_id IS NULL;
      CREATE INDEX IF NOT EXISTS idx_work_entry_details_parent
        ON profile_work_entry_details(work_entry_id, parent_detail_id, position);
    `);
    // Generation visibility (Cole's directive, 2026-08-19): an entry the
    // operator hides is never provided as material to a material-generation
    // context — it disappears from the source catalog and selecting its id
    // fails closed. Distinct from profile_entries.display_status, which
    // curates the PUBLIC EXPORT; this flag curates what the drafting model
    // may see. When Phase 4 makes ledger nodes citable, hiding an entry must
    // cascade to its work entry's detail nodes.
    ensureColumn(db, 'profile_entries', 'generation_hidden',
      'INTEGER NOT NULL DEFAULT 0 CHECK (generation_hidden IN (0,1))');
    // Fact-ledger columns (RESUME_QUALITY_PLAN.md §4, 2026-08-19): a detail
    // node can carry a typed fact — its kind, the measured before/after, the
    // honest ownership verb, and, load-bearing, WHO authored it. Only
    // human-authored nodes will be citable as bullet evidence; authorship
    // recorded at write time is what stops provenance laundering invention.
    ensureColumn(db, 'profile_work_entry_details', 'kind',
      "TEXT CHECK (kind IS NULL OR kind IN ('context','action','decision','outcome','scale','constraint'))");
    ensureColumn(db, 'profile_work_entry_details', 'baseline', 'TEXT CHECK (baseline IS NULL OR length(baseline)<=2000)');
    ensureColumn(db, 'profile_work_entry_details', 'result', 'TEXT CHECK (result IS NULL OR length(result)<=2000)');
    ensureColumn(db, 'profile_work_entry_details', 'my_role',
      "TEXT CHECK (my_role IS NULL OR my_role IN ('led','owned','designed','co-designed','implemented','contributed'))");
    ensureColumn(db, 'profile_work_entry_details', 'confidential', 'INTEGER NOT NULL DEFAULT 0 CHECK (confidential IN (0,1))');
    ensureColumn(db, 'profile_work_entry_details', 'evidence_url', 'TEXT CHECK (evidence_url IS NULL OR length(evidence_url)<=2000)');
    ensureColumn(db, 'profile_work_entry_details', 'authorship_kind',
      "TEXT CHECK (authorship_kind IS NULL OR authorship_kind IN ('human','agent','imported'))");
    ensureColumn(db, 'profile_work_entry_details', 'authored_by', 'TEXT CHECK (authored_by IS NULL OR length(authored_by)<=200)');
    ensureColumn(db, 'profile_education_entries', 'institution_organization_id', 'INTEGER REFERENCES organizations(id)');
    ensureColumn(db, 'profile_skills', 'profile_proficiency_level_id', 'INTEGER REFERENCES profile_proficiency_levels(id)');
    ensureColumn(db, 'profile_languages', 'profile_proficiency_level_id', 'INTEGER REFERENCES profile_proficiency_levels(id)');
    ensureColumn(db, 'profile_links', 'profile_link_kind_id', 'INTEGER REFERENCES profile_link_kinds(id)');
    ensureColumn(db, 'profile_credentials', 'profile_credential_kind_id', 'INTEGER REFERENCES profile_credential_kinds(id)');
    ensureColumn(db, 'profile_credentials', 'issuer_organization_id', 'INTEGER REFERENCES organizations(id)');
    ensureColumn(db, 'profile_recognitions', 'profile_recognition_kind_id', 'INTEGER REFERENCES profile_recognition_kinds(id)');
    ensureColumn(db, 'profile_recognitions', 'issuer_organization_id', 'INTEGER REFERENCES organizations(id)');
    ensureColumn(db, 'profile_publications', 'profile_publication_kind_id', 'INTEGER REFERENCES profile_publication_kinds(id)');
    ensureColumn(db, 'profile_publications', 'publisher_organization_id', 'INTEGER REFERENCES organizations(id)');
    ensureColumn(db, 'profile_volunteer_entries', 'organization_id', 'INTEGER REFERENCES organizations(id)');
    ensureColumn(db, 'profile_answers', 'profile_answer_category_id', 'INTEGER REFERENCES profile_answer_categories(id)');
    ensureColumn(db, 'profile_references', 'organization_id', 'INTEGER REFERENCES organizations(id)');

    seedVocabularies(db);
    createTagScopeGuards(db);
    createProfileEnumGuards(db);
    syncAllProfileNormalization(db);
    syncAllOpportunityTags(db);
    createInformationViewsAndGuards(db);

    const migration = db.prepare('SELECT name FROM jobtrack_schema_migrations WHERE version=?').get(PROFILE_NORMALIZATION_SCHEMA_VERSION);
    if (migration && migration.name !== PROFILE_NORMALIZATION_MIGRATION_NAME) {
      throw new ProfileNormalizationError('MIGRATION_CONFLICT', `Schema version ${PROFILE_NORMALIZATION_SCHEMA_VERSION} is already named ${migration.name}`);
    }
    const namedMigration = db.prepare('SELECT version FROM jobtrack_schema_migrations WHERE name=?').get(PROFILE_NORMALIZATION_MIGRATION_NAME);
    if (namedMigration && namedMigration.version !== PROFILE_NORMALIZATION_SCHEMA_VERSION) {
      throw new ProfileNormalizationError('MIGRATION_CONFLICT', `Migration ${PROFILE_NORMALIZATION_MIGRATION_NAME} is already registered as version ${namedMigration.version}`);
    }
    if (!migration) {
      db.prepare('INSERT INTO jobtrack_schema_migrations(version,name) VALUES (?,?)')
        .run(PROFILE_NORMALIZATION_SCHEMA_VERSION, PROFILE_NORMALIZATION_MIGRATION_NAME);
    }
    if (db.pragma('user_version', { simple: true }) < PROFILE_NORMALIZATION_USER_VERSION) {
      db.pragma(`user_version = ${PROFILE_NORMALIZATION_USER_VERSION}`);
    }
  };
  if (db.inTransaction) apply();
  else db.transaction(apply).immediate();
}

function seedVocabularies(db) {
  seedRows(db, 'profile_section_types', ['slug', 'label', 'sort_rank'], SECTION_SEEDS);
  seedRows(db, 'profile_confidence_levels', ['slug', 'label', 'sort_rank'], CONFIDENCE_SEEDS);
  seedRows(db, 'profile_proficiency_levels', ['slug', 'label', 'sort_rank'], PROFICIENCY_SEEDS);
  seedRows(db, 'profile_proficiency_domains', ['slug', 'label'], [['skill', 'Skill'], ['language', 'Language']]);
  for (const [domain, levels] of [
    ['skill', ['unassessed', 'novice', 'beginner', 'intermediate', 'advanced', 'expert']],
    ['language', ['unassessed', 'elementary', 'conversational', 'professional', 'fluent', 'native']]
  ]) {
    const domainId = db.prepare('SELECT id FROM profile_proficiency_domains WHERE slug=?').get(domain).id;
    for (const level of levels) {
      const levelId = db.prepare('SELECT id FROM profile_proficiency_levels WHERE slug=?').get(level).id;
      db.prepare(`
        INSERT INTO profile_proficiency_level_domains(profile_proficiency_level_id,profile_proficiency_domain_id)
        VALUES (?,?) ON CONFLICT DO NOTHING
      `).run(levelId, domainId);
    }
  }
  seedRows(db, 'profile_link_kinds', ['slug', 'label'], LINK_KIND_SEEDS);
  seedRows(db, 'profile_credential_kinds', ['slug', 'label'], CREDENTIAL_KIND_SEEDS);
  seedRows(db, 'profile_recognition_kinds', ['slug', 'label'], RECOGNITION_KIND_SEEDS);
  seedRows(db, 'profile_publication_kinds', ['slug', 'label'], PUBLICATION_KIND_SEEDS);
  seedRows(db, 'organization_types', ['slug', 'label'], [
    ['company', 'Company'], ['educational-institution', 'Educational institution'],
    ['nonprofit', 'Nonprofit'], ['government', 'Government'], ['research-organization', 'Research organization'],
    ['publisher', 'Publisher'], ['other', 'Other']
  ]);
  seedRows(db, 'profile_work_authorization_types', ['slug', 'label'], [
    ['unknown', 'Unknown'], ['authorized', 'Authorized'], ['limited', 'Limited authorization'], ['not-authorized', 'Not authorized']
  ]);
  seedRows(db, 'profile_sponsorship_requirement_types', ['slug', 'label'], [
    ['unknown', 'Unknown'], ['required', 'Sponsorship required'], ['not-required', 'Sponsorship not required'], ['conditional', 'Conditional']
  ]);
  seedRows(db, 'profile_relocation_preference_types', ['slug', 'label'], [
    ['unknown', 'Unknown'], ['willing', 'Willing'], ['unwilling', 'Unwilling'], ['conditional', 'Conditional']
  ]);
  seedRows(db, 'profile_work_arrangement_types', ['slug', 'label'], [
    ['unknown', 'Unknown'], ['remote', 'Remote'], ['hybrid', 'Hybrid'], ['onsite', 'On-site'], ['flexible', 'Flexible']
  ]);
  seedRows(db, 'profile_answer_categories', ['slug', 'label'], [
    ['general', 'General'], ['eligibility', 'Eligibility'], ['motivation', 'Motivation'],
    ['experience', 'Experience'], ['compensation', 'Compensation'], ['logistics', 'Logistics'],
    ['diversity', 'Diversity'], ['other', 'Other']
  ]);
  seedRows(db, 'tag_cardinalities', ['slug', 'label'], [['one', 'One value'], ['many', 'Multiple values']]);
  seedRows(db, 'tag_value_kinds', ['slug', 'label'], [['enum', 'Controlled term'], ['boolean', 'Boolean'], ['number', 'Number'], ['text', 'Text']]);
  seedRows(db, 'tag_lifecycle_statuses', ['slug', 'label'], [['active', 'Active'], ['pending-review', 'Pending review'], ['deprecated', 'Deprecated']]);
  seedRows(db, 'tag_namespace_sensitivity_levels', ['slug', 'label', 'sort_rank'], [
    ['public', 'Public facet', 10], ['private', 'Private profile facet', 20], ['sensitive', 'Sensitive facet', 30]
  ]);
  seedRows(db, 'tag_entity_kinds', ['slug', 'label'], [
    ['profile-entry', 'Profile entry'], ['profile-contact', 'Profile contact'],
    ['profile-reference', 'Profile reference'], ['profile-eeo', 'Profile EEO'],
    ['application', 'Application'], ['opening', 'Opening'], ['opportunity', 'Opportunity'],
    ['discovery-proposal', 'Discovery proposal']
  ]);
  db.prepare(`
    INSERT INTO tag_namespaces(slug,label,description,cardinality_id,value_kind_id,status_id,sensitivity_level_id,allows_new_values)
    SELECT 'general','General','Open operator-authored categorical facets',c.id,v.id,s.id,z.id,1
    FROM tag_cardinalities c,tag_value_kinds v,tag_lifecycle_statuses s,tag_namespace_sensitivity_levels z
    WHERE c.slug='many' AND v.slug='enum' AND s.slug='active' AND z.slug='public'
    ON CONFLICT(slug) DO NOTHING
  `).run();
  db.prepare(`
    INSERT INTO tag_namespaces(slug,label,description,cardinality_id,value_kind_id,status_id,sensitivity_level_id,allows_new_values)
    SELECT 'profile-private','Private profile tags','Private tags excluded from cross-entity facets',c.id,v.id,s.id,z.id,1
    FROM tag_cardinalities c,tag_value_kinds v,tag_lifecycle_statuses s,tag_namespace_sensitivity_levels z
    WHERE c.slug='many' AND v.slug='enum' AND s.slug='active' AND z.slug='private'
    ON CONFLICT(slug) DO NOTHING
  `).run();
  db.prepare(`
    INSERT INTO tag_namespace_entity_kinds(tag_namespace_id,tag_entity_kind_id)
    SELECT n.id,k.id FROM tag_namespaces n CROSS JOIN tag_entity_kinds k
    WHERE n.slug='general' AND k.slug IN ('profile-entry','application','opening','opportunity','discovery-proposal')
    ON CONFLICT(tag_namespace_id,tag_entity_kind_id) DO NOTHING
  `).run();
  db.prepare(`
    INSERT INTO tag_namespace_entity_kinds(tag_namespace_id,tag_entity_kind_id)
    SELECT n.id,k.id FROM tag_namespaces n CROSS JOIN tag_entity_kinds k
    WHERE n.slug='profile-private' AND k.slug IN ('profile-contact','profile-reference','profile-eeo')
    ON CONFLICT(tag_namespace_id,tag_entity_kind_id) DO NOTHING
  `).run();
  seedRows(db, 'information_value_kinds', ['slug', 'label'], [
    ['text', 'Short text'], ['long-text', 'Long text'], ['boolean', 'Boolean'], ['date', 'Date'],
    ['url', 'URL'], ['email', 'Email'], ['phone', 'Phone'], ['money', 'Money'],
    ['choice', 'Choice'], ['document', 'Document'], ['record-set', 'Record set']
  ]);
  seedRows(db, 'information_sensitivity_levels', ['slug', 'label', 'sort_rank'], [
    ['standard', 'Standard', 10], ['personal', 'Personal', 20], ['sensitive', 'Sensitive', 30], ['highly-sensitive', 'Highly sensitive', 40]
  ]);
  seedRows(db, 'information_assessment_states', ['slug', 'label', 'is_gap'], [
    ['unassessed', 'Unassessed', 0], ['available', 'Available', 0],
    ['confirmed_missing', 'Confirmed missing', 1], ['needs_review', 'Needs review', 0],
    ['not_applicable', 'Not applicable', 0]
  ]);
  seedRows(db, 'information_requiredness_levels', ['slug', 'label'], [
    ['unknown', 'Unknown'], ['required', 'Required'], ['preferred', 'Preferred'], ['optional', 'Optional'], ['conditional', 'Conditional']
  ]);
  seedRows(db, 'information_resolution_kinds', ['slug', 'label'], [
    ['none', 'No available value'], ['profile-entry', 'Profile entry'], ['contact-field', 'Contact field'],
    ['link', 'Profile link'], ['record-set', 'Profile record set'], ['evidence', 'Pinned external evidence']
  ]);
  const insertField = db.prepare(`
    INSERT INTO profile_information_fields(
      slug,label,value_kind_id,sensitivity_level_id,profile_source_kind,profile_source_key
    ) SELECT ?,?,v.id,s.id,?,? FROM information_value_kinds v,information_sensitivity_levels s
      WHERE v.slug=? AND s.slug=?
    ON CONFLICT(slug) DO NOTHING
  `);
  for (const [slug, label, valueKind, sensitivity, sourceKind, sourceKey] of INFORMATION_FIELD_SEEDS) {
    insertField.run(slug, label, sourceKind, sourceKey, valueKind, sensitivity);
  }
}

function seedRows(db, table, columns, rows) {
  const placeholders = columns.map(() => '?').join(',');
  const insert = db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES (${placeholders})`);
  const existing = db.prepare(`SELECT ${columns.join(',')} FROM ${table} WHERE slug=?`);
  for (const row of rows) {
    const stored = existing.get(row[0]);
    if (!stored) {
      insert.run(...row);
      continue;
    }
    for (let index = 0; index < columns.length; index += 1) {
      if (stored[columns[index]] !== row[index]) {
        throw new ProfileNormalizationError('MIGRATION_CONFLICT', `${table}.${row[0]} has unexpected ${columns[index]}`);
      }
    }
  }
}

function createInformationViewsAndGuards(db) {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_application_information_request_scope
    BEFORE INSERT ON application_information_requests
    WHEN (NEW.job_posting_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM applications a LEFT JOIN application_postings ap
        ON ap.application_id=a.id AND ap.job_posting_id=NEW.job_posting_id
      WHERE a.id=NEW.application_id AND (a.primary_job_posting_id=NEW.job_posting_id OR ap.job_posting_id IS NOT NULL)
    )) OR (NEW.opportunity_snapshot_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM applications a JOIN opportunity_snapshots s ON s.id=NEW.opportunity_snapshot_id
      LEFT JOIN application_postings ap ON ap.application_id=a.id AND ap.job_posting_id=s.job_posting_id
      WHERE a.id=NEW.application_id AND (
        (s.opportunity_id=a.source_opportunity_id AND s.job_posting_id IS NULL)
        OR s.job_posting_id=a.primary_job_posting_id OR ap.job_posting_id IS NOT NULL
      )
    )) OR (NEW.opportunity_snapshot_id IS NOT NULL AND NEW.job_posting_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM opportunity_snapshots s WHERE s.id=NEW.opportunity_snapshot_id AND s.job_posting_id=NEW.job_posting_id
    ))
    BEGIN SELECT RAISE(ABORT,'application information evidence scope mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS trg_opportunity_information_request_scope
    BEFORE INSERT ON opportunity_information_requests
    WHEN (NEW.job_posting_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM opportunities o WHERE o.id=NEW.opportunity_id AND (
        o.primary_job_posting_id=NEW.job_posting_id OR EXISTS (
          SELECT 1 FROM opportunity_snapshots s WHERE s.opportunity_id=o.id AND s.job_posting_id=NEW.job_posting_id
        )
      )
    )) OR (NEW.opportunity_snapshot_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM opportunity_snapshots s WHERE s.id=NEW.opportunity_snapshot_id AND s.opportunity_id=NEW.opportunity_id
    )) OR (NEW.opportunity_snapshot_id IS NOT NULL AND NEW.job_posting_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM opportunity_snapshots s WHERE s.id=NEW.opportunity_snapshot_id AND s.job_posting_id=NEW.job_posting_id
    ))
    BEGIN SELECT RAISE(ABORT,'opportunity information evidence scope mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS trg_application_information_assessment_resolution
    BEFORE INSERT ON application_information_assessments
    WHEN EXISTS (
      SELECT 1 FROM information_assessment_states s,information_resolution_kinds k
      WHERE s.id=NEW.assessment_state_id AND k.id=NEW.resolution_kind_id AND (
        (s.slug='available' AND k.slug='none') OR
        (s.slug<>'available' AND (k.slug<>'none' OR NEW.resolved_profile_entry_id IS NOT NULL)) OR
        (s.slug='available' AND k.slug IN ('profile-entry','link') AND NEW.resolved_profile_entry_id IS NULL) OR
        (s.slug='available' AND k.slug IN ('contact-field','record-set','evidence') AND NEW.resolved_profile_entry_id IS NOT NULL)
      )
    ) BEGIN SELECT RAISE(ABORT,'assessment state and pinned resolution are inconsistent'); END;
    CREATE TRIGGER IF NOT EXISTS trg_opportunity_information_assessment_resolution
    BEFORE INSERT ON opportunity_information_assessments
    WHEN EXISTS (
      SELECT 1 FROM information_assessment_states s,information_resolution_kinds k
      WHERE s.id=NEW.assessment_state_id AND k.id=NEW.resolution_kind_id AND (
        (s.slug='available' AND k.slug='none') OR
        (s.slug<>'available' AND (k.slug<>'none' OR NEW.resolved_profile_entry_id IS NOT NULL)) OR
        (s.slug='available' AND k.slug IN ('profile-entry','link') AND NEW.resolved_profile_entry_id IS NULL) OR
        (s.slug='available' AND k.slug IN ('contact-field','record-set','evidence') AND NEW.resolved_profile_entry_id IS NOT NULL)
      )
    ) BEGIN SELECT RAISE(ABORT,'assessment state and pinned resolution are inconsistent'); END;
    CREATE TRIGGER IF NOT EXISTS trg_application_information_requests_immutable_update
    BEFORE UPDATE ON application_information_requests BEGIN SELECT RAISE(ABORT,'application information requests are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_application_information_requests_immutable_delete
    BEFORE DELETE ON application_information_requests BEGIN SELECT RAISE(ABORT,'application information requests are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_opportunity_information_requests_immutable_update
    BEFORE UPDATE ON opportunity_information_requests BEGIN SELECT RAISE(ABORT,'opportunity information requests are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_opportunity_information_requests_immutable_delete
    BEFORE DELETE ON opportunity_information_requests BEGIN SELECT RAISE(ABORT,'opportunity information requests are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_application_information_assessments_immutable_update
    BEFORE UPDATE ON application_information_assessments BEGIN SELECT RAISE(ABORT,'application information assessments are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_application_information_assessments_immutable_delete
    BEFORE DELETE ON application_information_assessments BEGIN SELECT RAISE(ABORT,'application information assessments are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_opportunity_information_assessments_immutable_update
    BEFORE UPDATE ON opportunity_information_assessments BEGIN SELECT RAISE(ABORT,'opportunity information assessments are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_opportunity_information_assessments_immutable_delete
    BEFORE DELETE ON opportunity_information_assessments BEGIN SELECT RAISE(ABORT,'opportunity information assessments are immutable'); END;

    DROP VIEW IF EXISTS application_information_request_current;
    CREATE VIEW application_information_request_current AS
      SELECT r.*,f.slug AS information_field_slug,f.label AS information_field_label,q.slug AS requiredness,
        COALESCE(s.slug,'unassessed') AS assessment_state,COALESCE(s.is_gap,0) AS is_gap,
        a.id AS latest_assessment_id,a.resolved_profile_entry_id,rk.slug AS resolution_kind,
        a.resolution_key,a.resolution_sha256,a.assessed_by,a.rationale,a.evidence,a.assessment_sha256,a.assessed_at
      FROM application_information_requests r
      JOIN profile_information_fields f ON f.id=r.information_field_id
      JOIN information_requiredness_levels q ON q.id=r.requiredness_id
      LEFT JOIN application_information_assessments a ON a.id=(
        SELECT a2.id FROM application_information_assessments a2 WHERE a2.request_id=r.id ORDER BY a2.assessed_at DESC,a2.id DESC LIMIT 1
      )
      LEFT JOIN information_assessment_states s ON s.id=a.assessment_state_id
      LEFT JOIN information_resolution_kinds rk ON rk.id=a.resolution_kind_id;

    DROP VIEW IF EXISTS opportunity_information_request_current;
    CREATE VIEW opportunity_information_request_current AS
      SELECT r.*,f.slug AS information_field_slug,f.label AS information_field_label,q.slug AS requiredness,
        COALESCE(s.slug,'unassessed') AS assessment_state,COALESCE(s.is_gap,0) AS is_gap,
        a.id AS latest_assessment_id,a.resolved_profile_entry_id,rk.slug AS resolution_kind,
        a.resolution_key,a.resolution_sha256,a.assessed_by,a.rationale,a.evidence,a.assessment_sha256,a.assessed_at
      FROM opportunity_information_requests r
      JOIN profile_information_fields f ON f.id=r.information_field_id
      JOIN information_requiredness_levels q ON q.id=r.requiredness_id
      LEFT JOIN opportunity_information_assessments a ON a.id=(
        SELECT a2.id FROM opportunity_information_assessments a2 WHERE a2.request_id=r.id ORDER BY a2.assessed_at DESC,a2.id DESC LIMIT 1
      )
      LEFT JOIN information_assessment_states s ON s.id=a.assessment_state_id
      LEFT JOIN information_resolution_kinds rk ON rk.id=a.resolution_kind_id;

    DROP VIEW IF EXISTS application_profile_gap_summary;
    CREATE VIEW application_profile_gap_summary AS
      SELECT a.id AS application_id,COUNT(c.id) AS request_count,
        COALESCE(SUM(c.assessment_state='unassessed'),0) AS unassessed_count,
        COALESCE(SUM(c.assessment_state='available'),0) AS available_count,
        COALESCE(SUM(c.is_gap),0) AS confirmed_missing_count,
        COALESCE(SUM(c.is_gap AND c.requiredness IN ('required','conditional')),0) AS blocking_missing_count,
        COALESCE(SUM(c.is_gap AND c.requiredness IN ('optional','preferred')),0) AS optional_missing_count,
        COALESCE(SUM(c.assessment_state='needs_review'),0) AS needs_review_count,
        COALESCE(SUM(c.assessment_state='not_applicable'),0) AS not_applicable_count,
        CASE WHEN COALESCE(SUM(c.is_gap),0)>0 THEN 1 ELSE 0 END AS has_confirmed_missing,
        CASE WHEN COALESCE(SUM(c.is_gap AND c.requiredness IN ('required','conditional')),0)>0 THEN 1 ELSE 0 END AS has_blocking_gap
      FROM applications a LEFT JOIN application_information_request_current c ON c.application_id=a.id GROUP BY a.id;

    DROP VIEW IF EXISTS opportunity_profile_gap_summary;
    CREATE VIEW opportunity_profile_gap_summary AS
      SELECT o.id AS opportunity_id,COUNT(c.id) AS request_count,
        COALESCE(SUM(c.assessment_state='unassessed'),0) AS unassessed_count,
        COALESCE(SUM(c.assessment_state='available'),0) AS available_count,
        COALESCE(SUM(c.is_gap),0) AS confirmed_missing_count,
        COALESCE(SUM(c.is_gap AND c.requiredness IN ('required','conditional')),0) AS blocking_missing_count,
        COALESCE(SUM(c.is_gap AND c.requiredness IN ('optional','preferred')),0) AS optional_missing_count,
        COALESCE(SUM(c.assessment_state='needs_review'),0) AS needs_review_count,
        COALESCE(SUM(c.assessment_state='not_applicable'),0) AS not_applicable_count,
        CASE WHEN COALESCE(SUM(c.is_gap),0)>0 THEN 1 ELSE 0 END AS has_confirmed_missing,
        CASE WHEN COALESCE(SUM(c.is_gap AND c.requiredness IN ('required','conditional')),0)>0 THEN 1 ELSE 0 END AS has_blocking_gap
      FROM opportunities o LEFT JOIN opportunity_information_request_current c ON c.opportunity_id=o.id GROUP BY o.id;
  `);
}

function createTagScopeGuards(db) {
  const joins = [
    ['profile_entry_tags', 'profile_entry_id', 'profile-entry'], ['profile_contact_tags', 'profile_contact_id', 'profile-contact'],
    ['profile_reference_tags', 'profile_reference_id', 'profile-reference'], ['profile_eeo_tags', 'profile_eeo_id', 'profile-eeo'],
    ['application_tags', 'application_id', 'application'], ['opening_tags', 'job_opening_id', 'opening'],
    ['opportunity_tag_links', 'opportunity_id', 'opportunity'], ['discovery_proposal_tags', 'discovery_proposal_id', 'discovery-proposal']
  ];
  for (const [table, idColumn, entityKind] of joins) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_${table}_namespace_scope
      BEFORE INSERT ON ${table}
      WHEN NOT EXISTS (
        SELECT 1 FROM tags t
        JOIN tag_namespace_entity_kinds nk ON nk.tag_namespace_id=t.tag_namespace_id
        JOIN tag_entity_kinds ek ON ek.id=nk.tag_entity_kind_id
        JOIN tag_lifecycle_statuses ts ON ts.id=t.status_id
        JOIN tag_namespaces n ON n.id=t.tag_namespace_id
        JOIN tag_lifecycle_statuses ns ON ns.id=n.status_id
        WHERE t.id=NEW.tag_id AND ek.slug='${entityKind}' AND ts.slug='active' AND ns.slug='active'
      )
      BEGIN SELECT RAISE(ABORT,'tag namespace is not allowed for this entity kind'); END;
      CREATE TRIGGER IF NOT EXISTS trg_${table}_namespace_scope_update
      BEFORE UPDATE OF tag_id ON ${table}
      WHEN NOT EXISTS (
        SELECT 1 FROM tags t
        JOIN tag_namespace_entity_kinds nk ON nk.tag_namespace_id=t.tag_namespace_id
        JOIN tag_entity_kinds ek ON ek.id=nk.tag_entity_kind_id
        JOIN tag_lifecycle_statuses ts ON ts.id=t.status_id
        JOIN tag_namespaces n ON n.id=t.tag_namespace_id
        JOIN tag_lifecycle_statuses ns ON ns.id=n.status_id
        WHERE t.id=NEW.tag_id AND ek.slug='${entityKind}' AND ts.slug='active' AND ns.slug='active'
      )
      BEGIN SELECT RAISE(ABORT,'tag namespace is not allowed for this entity kind'); END;
      CREATE TRIGGER IF NOT EXISTS trg_${table}_cardinality_insert
      BEFORE INSERT ON ${table}
      WHEN EXISTS (
        SELECT 1 FROM tags nt JOIN tag_namespaces n ON n.id=nt.tag_namespace_id
        JOIN tag_cardinalities c ON c.id=n.cardinality_id
        WHERE nt.id=NEW.tag_id AND c.slug='one' AND EXISTS (
          SELECT 1 FROM ${table} j JOIN tags et ON et.id=j.tag_id
          WHERE j.${idColumn}=NEW.${idColumn} AND et.tag_namespace_id=nt.tag_namespace_id AND j.tag_id<>NEW.tag_id
        )
      ) BEGIN SELECT RAISE(ABORT,'tag namespace permits only one value for this entity'); END;
      CREATE TRIGGER IF NOT EXISTS trg_${table}_cardinality_update
      BEFORE UPDATE OF tag_id ON ${table}
      WHEN EXISTS (
        SELECT 1 FROM tags nt JOIN tag_namespaces n ON n.id=nt.tag_namespace_id
        JOIN tag_cardinalities c ON c.id=n.cardinality_id
        WHERE nt.id=NEW.tag_id AND c.slug='one' AND EXISTS (
          SELECT 1 FROM ${table} j JOIN tags et ON et.id=j.tag_id
          WHERE j.${idColumn}=NEW.${idColumn} AND et.tag_namespace_id=nt.tag_namespace_id AND j.tag_id<>OLD.tag_id
        )
      ) BEGIN SELECT RAISE(ABORT,'tag namespace permits only one value for this entity'); END;
    `);
  }
}

function createProfileEnumGuards(db) {
  for (const [table, domain] of [['profile_skills', 'skill'], ['profile_languages', 'language']]) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_${table}_proficiency_domain_insert
      BEFORE INSERT ON ${table}
      WHEN NEW.profile_proficiency_level_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM profile_proficiency_level_domains ld
        JOIN profile_proficiency_domains d ON d.id=ld.profile_proficiency_domain_id
        WHERE ld.profile_proficiency_level_id=NEW.profile_proficiency_level_id AND d.slug='${domain}'
      ) BEGIN SELECT RAISE(ABORT,'proficiency level is invalid for ${domain}'); END;
      CREATE TRIGGER IF NOT EXISTS trg_${table}_proficiency_domain_update
      BEFORE UPDATE OF profile_proficiency_level_id ON ${table}
      WHEN NEW.profile_proficiency_level_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM profile_proficiency_level_domains ld
        JOIN profile_proficiency_domains d ON d.id=ld.profile_proficiency_domain_id
        WHERE ld.profile_proficiency_level_id=NEW.profile_proficiency_level_id AND d.slug='${domain}'
      ) BEGIN SELECT RAISE(ABORT,'proficiency level is invalid for ${domain}'); END;
    `);
  }
}

function syncAllProfileNormalization(db) {
  const section = db.prepare('SELECT id FROM profile_section_types WHERE slug=?');
  const confidence = db.prepare('SELECT id FROM profile_confidence_levels WHERE slug=?');
  const updateEntry = db.prepare('UPDATE profile_entries SET profile_section_type_id=?,profile_confidence_level_id=? WHERE id=?');
  for (const row of db.prepare('SELECT id,category,confidence,tags FROM profile_entries ORDER BY id').all()) {
    updateEntry.run(section.get(row.category)?.id || null, confidence.get(row.confidence)?.id || null, row.id);
    syncLegacyTagProjection(db, 'profile_entry_tags', 'profile_entry_id', row.id, row.tags, 'general');
  }
  syncSingletonProfileTable(db, 'profile_contact', 'profile_contact_tags', 'profile_contact_id');
  syncSingletonProfileTable(db, 'profile_eeo', 'profile_eeo_tags', 'profile_eeo_id');
  for (const row of db.prepare('SELECT id,confidence,tags,company FROM profile_references ORDER BY id').all()) {
    const organizationId = resolveOrCreateOrganization(db, row.company, 'company');
    db.prepare('UPDATE profile_references SET profile_confidence_level_id=?,company_id=?,organization_id=? WHERE id=?')
      .run(confidence.get(row.confidence)?.id || null, resolveExactCompanyId(db, row.company), organizationId, row.id);
    syncLegacyTagProjection(db, 'profile_reference_tags', 'profile_reference_id', row.id, row.tags, 'profile-private');
  }
  for (const row of db.prepare('SELECT id,company FROM profile_work_entries ORDER BY id').all()) {
    const organizationId = resolveOrCreateOrganization(db, row.company, 'company');
    db.prepare('UPDATE profile_work_entries SET company_id=?,organization_id=? WHERE id=?')
      .run(resolveExactCompanyId(db, row.company), organizationId, row.id);
  }
  syncOrganizationField(db, 'profile_education_entries', 'institution', 'institution_organization_id', 'educational-institution');
  syncOrganizationField(db, 'profile_credentials', 'issuer', 'issuer_organization_id', 'other');
  syncOrganizationField(db, 'profile_recognitions', 'issuer', 'issuer_organization_id', 'other');
  syncOrganizationField(db, 'profile_publications', 'publisher', 'publisher_organization_id', 'publisher');
  syncOrganizationField(db, 'profile_volunteer_entries', 'organization', 'organization_id', 'other');
  syncKindTable(db, 'profile_links', 'kind', 'profile_link_kinds', 'profile_link_kind_id');
  syncKindTable(db, 'profile_credentials', 'kind', 'profile_credential_kinds', 'profile_credential_kind_id');
  syncKindTable(db, 'profile_recognitions', 'kind', 'profile_recognition_kinds', 'profile_recognition_kind_id');
  syncKindTable(db, 'profile_publications', 'kind', 'profile_publication_kinds', 'profile_publication_kind_id');
  syncProficiencies(db, 'profile_skills', 'skill');
  syncProficiencies(db, 'profile_languages', 'language');
  syncAnswerCategories(db);
  syncContactClassifications(db);
  syncProjectSkills(db);
}

function syncOrganizationField(db, table, legacyColumn, normalizedColumn, organizationType) {
  const update = db.prepare(`UPDATE ${table} SET ${normalizedColumn}=? WHERE id=?`);
  for (const row of db.prepare(`SELECT id,${legacyColumn} legacy_value FROM ${table} ORDER BY id`).all()) {
    update.run(resolveOrCreateOrganization(db, row.legacy_value, organizationType), row.id);
  }
}

function resolveOrCreateOrganization(db, rawName, organizationType) {
  if (!rawName || !String(rawName).trim()) return null;
  const canonicalName = String(rawName).trim();
  const normalizedName = normalizeCatalogText(canonicalName);
  const companyId = resolveExactCompanyId(db, canonicalName);
  let organization = companyId
    ? db.prepare(`SELECT o.* FROM organization_company_links l JOIN organizations o ON o.id=l.organization_id WHERE l.company_id=?`).get(companyId)
    : null;
  organization = organization || db.prepare(`
    SELECT o.* FROM organization_aliases a JOIN organizations o ON o.id=a.organization_id WHERE a.normalized_alias=?
  `).get(normalizedName);
  organization = organization || db.prepare('SELECT * FROM organizations WHERE normalized_name=?').get(normalizedName);
  if (!organization) {
    const inserted = db.prepare('INSERT INTO organizations(canonical_name,normalized_name) VALUES (?,?)')
      .run(canonicalName, normalizedName);
    organization = db.prepare('SELECT * FROM organizations WHERE id=?').get(inserted.lastInsertRowid);
  }
  const alias = db.prepare('SELECT organization_id FROM organization_aliases WHERE normalized_alias=?').get(normalizedName);
  if (alias && alias.organization_id !== organization.id) {
    throw new ProfileNormalizationError('IDENTITY_CONFLICT', `Organization alias ${canonicalName} belongs to another organization`);
  }
  db.prepare(`
    INSERT INTO organization_aliases(organization_id,alias,normalized_alias) VALUES (?,?,?)
    ON CONFLICT(normalized_alias) DO NOTHING
  `).run(organization.id, canonicalName, normalizedName);
  const type = db.prepare('SELECT id FROM organization_types WHERE slug=?').get(organizationType);
  if (!type) throw new ProfileNormalizationError('MIGRATION_CONFLICT', `Unknown organization type seed: ${organizationType}`);
  db.prepare(`
    INSERT INTO organization_type_links(organization_id,organization_type_id,source)
    VALUES (?,?,'exact_profile_field') ON CONFLICT(organization_id,organization_type_id) DO NOTHING
  `).run(organization.id, type.id);
  if (companyId) {
    const existing = db.prepare('SELECT company_id FROM organization_company_links WHERE organization_id=?').get(organization.id);
    if (existing && existing.company_id !== companyId) {
      throw new ProfileNormalizationError('IDENTITY_CONFLICT', `Organization ${organization.id} is already linked to company ${existing.company_id}`);
    }
    db.prepare(`
      INSERT INTO organization_company_links(organization_id,company_id) VALUES (?,?)
      ON CONFLICT(organization_id) DO NOTHING
    `).run(organization.id, companyId);
  }
  return organization.id;
}

function syncContactClassifications(db) {
  const mappings = [
    ['work_authorization', 'profile_work_authorization_types', 'work_authorization_type_id'],
    ['visa_sponsorship', 'profile_sponsorship_requirement_types', 'sponsorship_requirement_type_id'],
    ['relocation_willingness', 'profile_relocation_preference_types', 'relocation_preference_type_id'],
    ['remote_preference', 'profile_work_arrangement_types', 'work_arrangement_type_id']
  ];
  for (const [legacyColumn, vocabulary, normalizedColumn] of mappings) {
    const rows = db.prepare(`SELECT id,${legacyColumn} legacy_value FROM profile_contact ORDER BY id`).all();
    const lookup = db.prepare(`SELECT id FROM ${vocabulary} WHERE slug=?`);
    const update = db.prepare(`UPDATE profile_contact SET ${normalizedColumn}=? WHERE id=?`);
    for (const row of rows) {
      const slug = row.legacy_value ? normalizeEnumSlug(row.legacy_value) : 'unknown';
      update.run(lookup.get(slug)?.id || lookup.get('unknown').id, row.id);
    }
  }
}

function syncAnswerCategories(db) {
  const lookup = db.prepare('SELECT id FROM profile_answer_categories WHERE slug=?');
  const update = db.prepare('UPDATE profile_answers SET profile_answer_category_id=? WHERE id=?');
  for (const row of db.prepare('SELECT id,answer_category FROM profile_answers ORDER BY id').all()) {
    update.run(row.answer_category ? (lookup.get(normalizeEnumSlug(row.answer_category))?.id || lookup.get('other').id) : null, row.id);
  }
}

function syncSingletonProfileTable(db, table, joinTable, idColumn) {
  const confidence = db.prepare('SELECT id FROM profile_confidence_levels WHERE slug=?');
  for (const row of db.prepare(`SELECT id,confidence,tags FROM ${table} ORDER BY id`).all()) {
    db.prepare(`UPDATE ${table} SET profile_confidence_level_id=? WHERE id=?`).run(confidence.get(row.confidence)?.id || null, row.id);
    syncLegacyTagProjection(db, joinTable, idColumn, row.id, row.tags, 'profile-private');
  }
}

function syncKindTable(db, table, legacyColumn, vocabularyTable, normalizedColumn) {
  const lookup = db.prepare(`SELECT id FROM ${vocabularyTable} WHERE slug=?`);
  const other = lookup.get('other')?.id || null;
  const update = db.prepare(`UPDATE ${table} SET ${normalizedColumn}=? WHERE id=?`);
  for (const row of db.prepare(`SELECT id,${legacyColumn} legacy_value FROM ${table} ORDER BY id`).all()) {
    update.run(lookup.get(normalizeEnumSlug(row.legacy_value))?.id || other, row.id);
  }
}

function syncProficiencies(db, table, domain) {
  const lookup = db.prepare(`
    SELECT l.id FROM profile_proficiency_levels l
    JOIN profile_proficiency_level_domains ld ON ld.profile_proficiency_level_id=l.id
    JOIN profile_proficiency_domains d ON d.id=ld.profile_proficiency_domain_id
    WHERE l.slug=? AND d.slug=?
  `);
  const update = db.prepare(`UPDATE ${table} SET profile_proficiency_level_id=? WHERE id=?`);
  for (const row of db.prepare(`SELECT id,proficiency FROM ${table} ORDER BY id`).all()) {
    const slug = row.proficiency ? normalizeEnumSlug(row.proficiency) : 'unassessed';
    update.run(lookup.get(slug, domain)?.id || lookup.get('unassessed', domain).id, row.id);
  }
}

function syncProjectSkills(db) {
  const insert = db.prepare(`
    INSERT INTO profile_project_skills(profile_project_id,skill_id,raw_value,position,source)
    VALUES (?,?,?,?,'legacy_stack_exact') ON CONFLICT(profile_project_id,skill_id) DO NOTHING
  `);
  for (const project of db.prepare('SELECT id,stack FROM profile_projects ORDER BY id').all()) {
    const desiredIds = new Set();
    parseLegacyList(project.stack).forEach((raw, position) => {
      const skillId = resolveExactSkillId(db, raw);
      if (skillId) {
        desiredIds.add(skillId);
        insert.run(project.id, skillId, raw, position);
      }
    });
    for (const row of db.prepare("SELECT skill_id FROM profile_project_skills WHERE profile_project_id=? AND source='legacy_stack_exact'").all(project.id)) {
      if (!desiredIds.has(row.skill_id)) db.prepare('DELETE FROM profile_project_skills WHERE profile_project_id=? AND skill_id=?').run(project.id, row.skill_id);
    }
  }
}

function syncAllOpportunityTags(db) {
  if (!tableExists(db, 'opportunity_tags')) return;
  const desired = new Map();
  for (const row of db.prepare('SELECT opportunity_id,tag,tag_source FROM opportunity_tags ORDER BY opportunity_id,tag').all()) {
    const tag = ensureTag(db, 'general', row.tag, { allowInactive: true });
    desired.set(`${row.opportunity_id}:${tag.id}`, true);
    if (!db.prepare('SELECT 1 FROM opportunity_tag_links WHERE opportunity_id=? AND tag_id=?').get(row.opportunity_id, tag.id)) {
      db.prepare(`INSERT INTO opportunity_tag_links(opportunity_id,tag_id,source) VALUES (?,?,?)`)
        .run(row.opportunity_id, tag.id, `legacy_projection:${row.tag_source || 'unknown'}`);
    }
  }
  for (const row of db.prepare(`
    SELECT j.opportunity_id,j.tag_id FROM opportunity_tag_links j
    JOIN tags t ON t.id=j.tag_id JOIN tag_namespaces n ON n.id=t.tag_namespace_id WHERE n.slug='general'
  `).all()) {
    if (!desired.has(`${row.opportunity_id}:${row.tag_id}`)) {
      db.prepare('DELETE FROM opportunity_tag_links WHERE opportunity_id=? AND tag_id=?').run(row.opportunity_id, row.tag_id);
    }
  }
  syncInheritedOpportunityTags(db);
}

function syncInheritedOpportunityTags(db) {
  db.prepare(`
    DELETE FROM opening_tags
    WHERE source LIKE 'inherited:opportunity:%' AND NOT EXISTS (
      SELECT 1 FROM opportunities o JOIN opportunity_tag_links t ON t.opportunity_id=o.id
      JOIN tags x ON x.id=t.tag_id JOIN tag_lifecycle_statuses xs ON xs.id=x.status_id
      WHERE o.job_opening_id=opening_tags.job_opening_id AND t.tag_id=opening_tags.tag_id
        AND opening_tags.source='inherited:opportunity:'||o.id AND xs.slug='active'
    )
  `).run();
  db.prepare(`
    DELETE FROM application_tags
    WHERE source LIKE 'inherited:opportunity:%' AND NOT EXISTS (
      SELECT 1 FROM applications a JOIN opportunities o ON o.id=a.source_opportunity_id
      JOIN opportunity_tag_links t ON t.opportunity_id=o.id
      JOIN tags x ON x.id=t.tag_id JOIN tag_lifecycle_statuses xs ON xs.id=x.status_id
      WHERE a.id=application_tags.application_id AND t.tag_id=application_tags.tag_id
        AND application_tags.source='inherited:opportunity:'||o.id AND xs.slug='active'
    )
  `).run();
  db.prepare(`
    INSERT INTO opening_tags(job_opening_id,tag_id,source,evidence)
    SELECT o.job_opening_id,t.tag_id,'inherited:opportunity:'||o.id,'opportunity_tag_links:'||o.id||':'||t.tag_id
    FROM opportunities o JOIN opportunity_tag_links t ON t.opportunity_id=o.id
    JOIN tags x ON x.id=t.tag_id JOIN tag_lifecycle_statuses xs ON xs.id=x.status_id
    WHERE o.job_opening_id IS NOT NULL AND xs.slug='active'
    ON CONFLICT(job_opening_id,tag_id) DO NOTHING
  `).run();
  db.prepare(`
    INSERT INTO application_tags(application_id,tag_id,source,evidence)
    SELECT a.id,t.tag_id,'inherited:opportunity:'||o.id,'opportunity_tag_links:'||o.id||':'||t.tag_id
    FROM applications a JOIN opportunities o ON o.id=a.source_opportunity_id
    JOIN opportunity_tag_links t ON t.opportunity_id=o.id
    JOIN tags x ON x.id=t.tag_id JOIN tag_lifecycle_statuses xs ON xs.id=x.status_id
    WHERE xs.slug='active'
    ON CONFLICT(application_id,tag_id) DO NOTHING
  `).run();
}

function syncLegacyTagProjection(db, joinTable, idColumn, entityId, rawTags, namespaceSlug) {
  const desired = parseLegacyList(rawTags).map((label) => ensureTag(db, namespaceSlug, label, { allowInactive: true }));
  const insert = db.prepare(`
    INSERT INTO ${joinTable}(${idColumn},tag_id,source) VALUES (?,?,'legacy_projection')
    ON CONFLICT(${idColumn},tag_id) DO NOTHING
  `);
  for (const tag of desired) {
    if (!db.prepare(`SELECT 1 FROM ${joinTable} WHERE ${idColumn}=? AND tag_id=?`).get(entityId, tag.id)) insert.run(entityId, tag.id);
  }
  const desiredIds = new Set(desired.map((tag) => tag.id));
  for (const row of db.prepare(`
    SELECT j.tag_id FROM ${joinTable} j JOIN tags t ON t.id=j.tag_id JOIN tag_namespaces n ON n.id=t.tag_namespace_id
    WHERE j.${idColumn}=? AND n.slug=?
  `).all(entityId, namespaceSlug)) {
    if (!desiredIds.has(row.tag_id)) db.prepare(`DELETE FROM ${joinTable} WHERE ${idColumn}=? AND tag_id=?`).run(entityId, row.tag_id);
  }
}

function ensureTag(db, namespaceSlug, rawLabel, options = {}) {
  const namespace = db.prepare(`
    SELECT n.*,c.slug cardinality,s.slug lifecycle_status
    FROM tag_namespaces n JOIN tag_cardinalities c ON c.id=n.cardinality_id
    JOIN tag_lifecycle_statuses s ON s.id=n.status_id WHERE n.slug=?
  `).get(boundedText(namespaceSlug, 'tag namespace', 64));
  if (!namespace || namespace.lifecycle_status !== 'active') {
    throw new ProfileNormalizationError('NOT_FOUND', `Active tag namespace not found: ${namespaceSlug}`);
  }
  const label = boundedText(rawLabel, 'tag', 200);
  const normalized = normalizeTagLabel(label);
  let tag = db.prepare(`
    SELECT t.*,s.slug lifecycle_status FROM tags t JOIN tag_lifecycle_statuses s ON s.id=t.status_id
    WHERE t.tag_namespace_id=? AND t.normalized_label=?
  `).get(namespace.id, normalized);
  if (tag) {
    if (tag.lifecycle_status !== 'active' && !options.allowInactive) throw new ProfileNormalizationError('INACTIVE_TAG', `Tag ${namespaceSlug}:${label} is ${tag.lifecycle_status}`);
    return tag;
  }
  if (!namespace.allows_new_values) {
    throw new ProfileNormalizationError('UNKNOWN_TAG', `Tag ${label} is not defined in namespace ${namespace.slug}`);
  }
  const active = db.prepare("SELECT id FROM tag_lifecycle_statuses WHERE slug='active'").get();
  let slug = tagSlug(label);
  const collision = db.prepare('SELECT normalized_label FROM tags WHERE tag_namespace_id=? AND slug=?').get(namespace.id, slug);
  if (collision && collision.normalized_label !== normalized) slug = `${slug}-${sha256(normalized).slice(0, 8)}`;
  const info = db.prepare(`
    INSERT INTO tags(tag_namespace_id,slug,label,normalized_label,status_id) VALUES (?,?,?,?,?)
  `).run(namespace.id, slug, label, normalized, active.id);
  return db.prepare('SELECT * FROM tags WHERE id=?').get(info.lastInsertRowid);
}

function assignTag(db, input) {
  const target = resolveTagTarget(db, input);
  const namespaceSlug = optionalText(input.namespace) || 'general';
  const tag = ensureTag(db, namespaceSlug, input.tag);
  const scoped = db.prepare(`
    SELECT 1 FROM tag_namespace_entity_kinds nk
    JOIN tag_entity_kinds ek ON ek.id=nk.tag_entity_kind_id
    WHERE nk.tag_namespace_id=? AND ek.slug=?
  `).get(tag.tag_namespace_id, target.entityKind);
  if (!scoped) throw new ProfileNormalizationError('TAG_SCOPE_MISMATCH', `Namespace ${namespaceSlug} is not valid for ${target.entityKind}`);
  const namespace = db.prepare(`
    SELECT c.slug cardinality FROM tag_namespaces n JOIN tag_cardinalities c ON c.id=n.cardinality_id WHERE n.id=?
  `).get(tag.tag_namespace_id);
  if (namespace.cardinality === 'one') {
    db.prepare(`DELETE FROM ${target.joinTable} WHERE ${target.idColumn}=? AND tag_id IN (SELECT id FROM tags WHERE tag_namespace_id=?)`)
      .run(target.id, tag.tag_namespace_id);
  }
  const confidence = optionalConfidence(input.confidence);
  const evidence = optionalBoundedText(input.evidence, 'tag evidence', 20000);
  const source = optionalBoundedText(input.source, 'tag source', 200) || 'manual';
  db.prepare(`
    INSERT INTO ${target.joinTable}(${target.idColumn},tag_id,source,confidence,evidence) VALUES (?,?,?,?,?)
    ON CONFLICT(${target.idColumn},tag_id) DO UPDATE SET
      source=excluded.source,confidence=excluded.confidence,evidence=excluded.evidence
  `).run(target.id, tag.id, source, confidence, evidence);
  syncNormalizedTagToLegacy(db, target, tag, true, source);
  return { target: target.publicTarget, tag: serializeTag(db, tag), assigned: true };
}

function removeTag(db, input) {
  const target = resolveTagTarget(db, input);
  const namespaceSlug = optionalText(input.namespace) || 'general';
  const normalized = normalizeTagLabel(requiredText(input.tag, 'tag'));
  const tag = db.prepare(`
    SELECT t.* FROM tags t JOIN tag_namespaces n ON n.id=t.tag_namespace_id
    WHERE n.slug=? AND t.normalized_label=?
  `).get(namespaceSlug, normalized);
  if (!tag) throw new ProfileNormalizationError('NOT_FOUND', `Tag not found: ${namespaceSlug}:${input.tag}`);
  const info = db.prepare(`DELETE FROM ${target.joinTable} WHERE ${target.idColumn}=? AND tag_id=?`).run(target.id, tag.id);
  if (!info.changes) throw new ProfileNormalizationError('NOT_FOUND', 'Tag is not assigned to that target');
  syncNormalizedTagToLegacy(db, target, tag, false, 'manual');
  return { target: target.publicTarget, tag: serializeTag(db, tag), assigned: false };
}

function listTags(db, input = {}) {
  const targetFlags = tagTargetInputs(input);
  if (targetFlags.length) {
    const target = resolveTagTarget(db, input);
    return db.prepare(`
      SELECT t.*,n.slug namespace_slug,n.label namespace_label,j.source,j.confidence,j.evidence,j.created_at assigned_at
      FROM ${target.joinTable} j JOIN tags t ON t.id=j.tag_id JOIN tag_namespaces n ON n.id=t.tag_namespace_id
      JOIN tag_lifecycle_statuses ts ON ts.id=t.status_id JOIN tag_lifecycle_statuses ns ON ns.id=n.status_id
      WHERE j.${target.idColumn}=? AND ts.slug='active' AND ns.slug='active' ORDER BY n.slug,lower(t.label),t.id
    `).all(target.id);
  }
  const namespace = optionalText(input.namespace);
  return db.prepare(`
    SELECT t.*,n.slug namespace_slug,n.label namespace_label
    FROM tags t JOIN tag_namespaces n ON n.id=t.tag_namespace_id
    JOIN tag_lifecycle_statuses ts ON ts.id=t.status_id JOIN tag_lifecycle_statuses ns ON ns.id=n.status_id
    WHERE ts.slug='active' AND ns.slug='active' ${namespace ? 'AND n.slug=@namespace' : ''}
    ORDER BY n.slug,lower(t.label),t.id
  `).all({ namespace });
}

function resolveTagTarget(db, input) {
  const targets = tagTargetInputs(input);
  if (targets.length !== 1) {
    throw new ProfileNormalizationError('INVALID_TARGET', 'Provide exactly one of --profile-entry-id, --application-id, --opening-id, --opportunity-id, or --proposal-id');
  }
  const [kind] = targets;
  const configs = {
    profile: ['profile_entries', 'profile_entry_tags', 'profile_entry_id', input.profileEntryId, 'profile-entry'],
    application: ['applications', 'application_tags', 'application_id', input.applicationId, 'application'],
    opening: ['job_openings', 'opening_tags', 'job_opening_id', input.openingId, 'opening'],
    opportunity: ['opportunities', 'opportunity_tag_links', 'opportunity_id', input.opportunityId, 'opportunity']
  };
  if (kind === 'proposal') {
    const proposal = db.prepare('SELECT id,proposal_id FROM discovery_import_proposals WHERE proposal_id=?').get(requiredText(input.proposalId, 'proposal id'));
    if (!proposal) throw new ProfileNormalizationError('NOT_FOUND', `Discovery proposal not found: ${input.proposalId}`);
    return { joinTable: 'discovery_proposal_tags', idColumn: 'discovery_proposal_id', id: proposal.id, entityKind: 'discovery-proposal', publicTarget: { kind, id: proposal.proposal_id } };
  }
  const [table, joinTable, idColumn, rawId, entityKind] = configs[kind];
  const id = positiveId(rawId, `${kind} id`);
  if (!db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(id)) throw new ProfileNormalizationError('NOT_FOUND', `${kind} not found: ${id}`);
  return { joinTable, idColumn, id, entityKind, publicTarget: { kind, id } };
}

function syncNormalizedTagToLegacy(db, target, tag, assigned, source) {
  const namespace = db.prepare('SELECT slug FROM tag_namespaces WHERE id=?').get(tag.tag_namespace_id);
  if (!namespace || namespace.slug !== 'general') return;
  if (target.entityKind === 'profile-entry') {
    const row = db.prepare('SELECT tags FROM profile_entries WHERE id=?').get(target.id);
    const values = parseLegacyList(row.tags);
    const next = assigned
      ? uniqueStrings([...values, tag.label])
      : values.filter((value) => normalizeTagLabel(value) !== tag.normalized_label);
    db.prepare('UPDATE profile_entries SET tags=?,updated_at=datetime(\'now\') WHERE id=?').run(JSON.stringify(next), target.id);
  }
  if (target.entityKind === 'opportunity') {
    if (assigned) {
      db.prepare(`
        INSERT INTO opportunity_tags(opportunity_id,tag,tag_source) VALUES (?,?,?)
        ON CONFLICT(opportunity_id,tag) DO UPDATE SET tag_source=excluded.tag_source
      `).run(target.id, tag.label, source);
    } else {
      db.prepare('DELETE FROM opportunity_tags WHERE opportunity_id=? AND lower(trim(tag))=?')
        .run(target.id, tag.normalized_label);
    }
  }
}

function tagTargetInputs(input) {
  return [
    ['profile', input.profileEntryId], ['application', input.applicationId], ['opening', input.openingId],
    ['opportunity', input.opportunityId], ['proposal', input.proposalId]
  ].filter(([, value]) => value !== undefined && value !== null && value !== '').map(([kind]) => kind);
}

function markInformationRequest(db, input) {
  const target = resolveInformationTarget(db, input);
  const field = db.prepare('SELECT * FROM profile_information_fields WHERE slug=?').get(requiredText(input.field, 'information field'));
  if (!field) throw new ProfileNormalizationError('UNKNOWN_INFORMATION_FIELD', `Unknown information field: ${input.field}`);
  const requirednessSlug = optionalText(input.requiredness) || 'unknown';
  const requiredness = db.prepare('SELECT * FROM information_requiredness_levels WHERE slug=?').get(requirednessSlug);
  if (!requiredness) throw new ProfileNormalizationError('VALIDATION_ERROR', `Unknown requiredness: ${requirednessSlug}`);
  const requestedLabel = optionalBoundedText(input.requestedLabel, 'requested label', 500);
  const rawPrompt = optionalBoundedText(input.rawPrompt, 'raw prompt', 20000);
  if (!requestedLabel && !rawPrompt) throw new ProfileNormalizationError('VALIDATION_ERROR', 'Provide --requested-label or --raw-prompt');
  const source = boundedText(input.source, 'source', 200);
  const sourceUrl = validateOptionalUrl(input.sourceUrl);
  const snapshotId = optionalPositiveId(input.snapshotId, 'snapshot id');
  const postingId = optionalPositiveId(input.postingId, 'posting id');
  validateRequestEvidenceLinks(db, target, snapshotId, postingId);
  const suppliedObservedAt = input.observedAt === undefined ? null : normalizedTimestamp(input.observedAt, 'observed at');
  const intentCanonical = {
    targetKind: target.kind, targetId: target.id, informationField: field.slug, requiredness: requiredness.slug,
    requestedLabel, rawPrompt, source, sourceUrl, snapshotId, postingId, observedAt: suppliedObservedAt
  };
  const intentSha = sha256(stableJson(intentCanonical));
  const idempotencyKey = boundedText(input.idempotencyKey, 'idempotency key', 200);
  const existing = db.prepare(`SELECT * FROM ${target.requestTable} WHERE idempotency_key=?`).get(idempotencyKey);
  if (existing) {
    if (existing.intent_sha256 !== intentSha) throw new ProfileNormalizationError('IDEMPOTENCY_CONFLICT', 'Idempotency key was already used for a different information request');
    return { request: currentRequest(db, target, existing.id), replayed: true };
  }
  const observedAt = suppliedObservedAt || new Date().toISOString();
  const requestSha = sha256(stableJson({ ...intentCanonical, observedAt }));
  const info = db.prepare(`
    INSERT INTO ${target.requestTable}(
      ${target.targetColumn},information_field_id,requested_label,raw_prompt,source,source_url,
      requiredness_id,opportunity_snapshot_id,job_posting_id,request_sha256,intent_sha256,idempotency_key,observed_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(target.id, field.id, requestedLabel, rawPrompt, source, sourceUrl, requiredness.id, snapshotId, postingId, requestSha, intentSha, idempotencyKey, observedAt);
  return { request: currentRequest(db, target, Number(info.lastInsertRowid)), replayed: false };
}

function assessInformationRequest(db, input) {
  const target = resolveInformationTarget(db, input);
  const requestId = positiveId(input.requestId, 'request id');
  const request = db.prepare(`SELECT * FROM ${target.requestTable} WHERE id=? AND ${target.targetColumn}=?`).get(requestId, target.id);
  if (!request) throw new ProfileNormalizationError('NOT_FOUND', `Information request not found for ${target.kind}: ${requestId}`);
  const stateSlug = requiredText(input.state || input.assessment, 'assessment state');
  if (stateSlug === 'unassessed') throw new ProfileNormalizationError('VALIDATION_ERROR', 'Unassessed is represented by the absence of an assessment');
  const state = db.prepare('SELECT * FROM information_assessment_states WHERE slug=?').get(stateSlug);
  if (!state) throw new ProfileNormalizationError('VALIDATION_ERROR', `Unknown assessment state: ${stateSlug}`);
  const profileEntryId = optionalPositiveId(input.profileEntryId, 'profile entry id');
  if (stateSlug !== 'available' && profileEntryId) {
    throw new ProfileNormalizationError('VALIDATION_ERROR', 'A confirmed-missing assessment cannot resolve to a profile entry');
  }
  const rationale = optionalBoundedText(input.rationale, 'rationale', 20000);
  const evidence = optionalBoundedText(input.evidence, 'evidence', 20000);
  const assessedBy = boundedText(input.assessedBy, 'assessed by', 200);
  const suppliedAssessedAt = input.assessedAt === undefined ? null : normalizedTimestamp(input.assessedAt, 'assessed at');
  const expectedAssessmentId = parseExpectedAssessmentId(input.expectedAssessmentId);
  const intentCanonical = {
    requestSha256: request.request_sha256, state: stateSlug, profileEntryId, assessedBy,
    rationale, evidence, assessedAt: suppliedAssessedAt, expectedAssessmentId
  };
  const intentSha = sha256(stableJson(intentCanonical));
  const idempotencyKey = boundedText(input.idempotencyKey, 'idempotency key', 200);
  const existing = db.prepare(`SELECT * FROM ${target.assessmentTable} WHERE idempotency_key=?`).get(idempotencyKey);
  if (existing) {
    if (existing.intent_sha256 !== intentSha) throw new ProfileNormalizationError('IDEMPOTENCY_CONFLICT', 'Idempotency key was already used for a different assessment');
    return { request: currentRequest(db, target, requestId), replayed: true };
  }
  const current = db.prepare(`SELECT * FROM ${target.assessmentTable} WHERE request_id=? ORDER BY assessed_at DESC,id DESC LIMIT 1`).get(requestId);
  if ((current?.id || null) !== expectedAssessmentId) {
    throw new ProfileNormalizationError('STALE_ASSESSMENT', `Expected current assessment ${expectedAssessmentId || 'none'}, found ${current?.id || 'none'}`);
  }
  const assessedAt = suppliedAssessedAt || new Date().toISOString();
  if (current && Date.parse(assessedAt) < Date.parse(current.assessed_at)) {
    throw new ProfileNormalizationError('STALE_ASSESSMENT', 'Assessment time cannot precede the current assessment');
  }
  const field = db.prepare('SELECT * FROM profile_information_fields WHERE id=?').get(request.information_field_id);
  const resolution = stateSlug === 'available'
    ? resolveAvailableInformation(db, field, profileEntryId, evidence)
    : { kind: 'none', key: `assessment:${stateSlug}`, sha256: sha256(stableJson({ state: stateSlug })), profileEntryId: null };
  const resolutionKind = db.prepare('SELECT id FROM information_resolution_kinds WHERE slug=?').get(resolution.kind);
  const canonical = { ...intentCanonical, assessedAt, resolutionKind: resolution.kind, resolutionKey: resolution.key, resolutionSha256: resolution.sha256 };
  const assessmentSha = sha256(stableJson(canonical));
  db.prepare(`
    INSERT INTO ${target.assessmentTable}(
      request_id,assessment_state_id,resolved_profile_entry_id,resolution_kind_id,resolution_key,resolution_sha256,
      assessed_by,rationale,evidence,assessment_sha256,intent_sha256,idempotency_key,assessed_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(requestId, state.id, resolution.profileEntryId, resolutionKind.id, resolution.key, resolution.sha256,
    assessedBy, rationale, evidence, assessmentSha, intentSha, idempotencyKey, assessedAt);
  return { request: currentRequest(db, target, requestId), replayed: false };
}

function resolveAvailableInformation(db, field, profileEntryId, evidence) {
  if (field.profile_source_kind === 'contact') {
    if (profileEntryId) throw new ProfileNormalizationError('RESOLUTION_SCOPE_MISMATCH', `${field.slug} must resolve from profile contact, not an unrelated profile entry`);
    const allowed = new Set(INFORMATION_FIELD_SEEDS.filter((seed) => seed[4] === 'contact').map((seed) => seed[5]));
    if (!allowed.has(field.profile_source_key)) throw new ProfileNormalizationError('RESOLUTION_SCOPE_MISMATCH', 'Invalid contact-field mapping');
    const row = db.prepare(`SELECT ${field.profile_source_key} value FROM profile_contact WHERE id=1`).get();
    if (!row || row.value === null || String(row.value).trim() === '') {
      throw new ProfileNormalizationError('RESOLUTION_NOT_AVAILABLE', `Profile contact field ${field.profile_source_key} has no value`);
    }
    const key = `profile_contact.${field.profile_source_key}`;
    return { kind: 'contact-field', key, sha256: sha256(stableJson({ key, value: row.value })), profileEntryId: null };
  }
  if (field.profile_source_kind === 'section') {
    if (!profileEntryId) throw new ProfileNormalizationError('VALIDATION_ERROR', `${field.slug} availability requires --profile-entry-id`);
    const entry = db.prepare('SELECT * FROM profile_entries WHERE id=?').get(profileEntryId);
    if (!entry) throw new ProfileNormalizationError('NOT_FOUND', `Profile entry not found: ${profileEntryId}`);
    if (entry.category !== field.profile_source_key) {
      throw new ProfileNormalizationError('RESOLUTION_SCOPE_MISMATCH', `Profile entry ${profileEntryId} is ${entry.category}, not ${field.profile_source_key}`);
    }
    const key = `profile_entries:${profileEntryId}`;
    return {
      kind: 'profile-entry', key,
      sha256: sha256(stableJson({ key, category: entry.category, title: entry.title, content: entry.content, source: entry.source, evidence: entry.evidence, attachmentPath: entry.attachment_path })),
      profileEntryId
    };
  }
  if (field.profile_source_kind === 'link') {
    let row;
    if (profileEntryId) {
      row = db.prepare(`
        SELECT pe.id profile_entry_id,pl.* FROM profile_entries pe JOIN profile_links pl ON pl.profile_entry_id=pe.id
        WHERE pe.id=? AND lower(pl.kind)=?
      `).get(profileEntryId, field.profile_source_key);
    } else {
      row = db.prepare(`
        SELECT pe.id profile_entry_id,pl.* FROM profile_entries pe JOIN profile_links pl ON pl.profile_entry_id=pe.id
        WHERE lower(pl.kind)=? ORDER BY pe.id DESC LIMIT 1
      `).get(field.profile_source_key);
    }
    if (!row) throw new ProfileNormalizationError('RESOLUTION_NOT_AVAILABLE', `No ${field.profile_source_key} profile link is available`);
    const key = `profile_links:${row.id}`;
    return { kind: 'link', key, sha256: sha256(stableJson({ key, kind: row.kind, label: row.label, url: row.url, username: row.username })), profileEntryId: row.profile_entry_id };
  }
  if (field.profile_source_kind === 'record') {
    if (profileEntryId) throw new ProfileNormalizationError('RESOLUTION_SCOPE_MISMATCH', `${field.slug} resolves from a typed record set`);
    let records;
    if (field.profile_source_key === 'references') {
      records = db.prepare('SELECT id,name,relationship,company,title,contact,updated_at FROM profile_references ORDER BY id').all();
    } else if (field.profile_source_key === 'eeo') {
      records = db.prepare('SELECT id,gender,pronouns,race_ethnicity,veteran,disability,updated_at FROM profile_eeo ORDER BY id').all();
    } else {
      throw new ProfileNormalizationError('RESOLUTION_SCOPE_MISMATCH', 'Invalid record-set mapping');
    }
    if (!records.length) throw new ProfileNormalizationError('RESOLUTION_NOT_AVAILABLE', `No ${field.profile_source_key} records are available`);
    const key = `profile_records:${field.profile_source_key}`;
    return { kind: 'record-set', key, sha256: sha256(stableJson({ key, records })), profileEntryId: null };
  }
  if (!evidence) throw new ProfileNormalizationError('VALIDATION_ERROR', `${field.slug} availability requires --evidence`);
  const key = `evidence:${field.slug}`;
  return { kind: 'evidence', key, sha256: sha256(stableJson({ key, evidence })), profileEntryId: null };
}

function verifyInformationResolution(db, request) {
  if (!request || request.assessment_state !== 'available') {
    return { current: request?.assessment_state === 'not_applicable', resolution: null };
  }
  const field = db.prepare('SELECT * FROM profile_information_fields WHERE id=?').get(request.information_field_id);
  if (!field) return { current: false, resolution: null };
  try {
    const resolution = resolveAvailableInformation(db, field, request.resolved_profile_entry_id, request.evidence);
    return {
      current: resolution.key === request.resolution_key && resolution.sha256 === request.resolution_sha256,
      resolution
    };
  } catch (error) {
    if (error instanceof ProfileNormalizationError) return { current: false, resolution: null };
    throw error;
  }
}

function readEffectiveApplicationInformationRequests(db, applicationId) {
  const id = positiveId(applicationId, 'application id');
  const application = db.prepare(`
    SELECT id,source_opportunity_id,primary_job_posting_id
    FROM applications WHERE id=?
  `).get(id);
  if (!application) throw new ProfileNormalizationError('NOT_FOUND', `Application not found: ${id}`);

  const routeExpression = `COALESCE(
    c.job_posting_id,
    (SELECT snapshot.job_posting_id FROM opportunity_snapshots snapshot WHERE snapshot.id=c.opportunity_snapshot_id)
  )`;
  const params = {
    applicationId: application.id,
    opportunityId: application.source_opportunity_id,
    primaryPostingId: application.primary_job_posting_id
  };
  const applicationRequests = db.prepare(`
    SELECT c.*,s.slug AS sensitivity,'application' AS request_scope,
      ${routeExpression} AS effective_job_posting_id
    FROM application_information_request_current c
    JOIN profile_information_fields f ON f.id=c.information_field_id
    JOIN information_sensitivity_levels s ON s.id=f.sensitivity_level_id
    WHERE c.application_id=@applicationId
      AND (@primaryPostingId IS NULL OR ${routeExpression} IS NULL OR ${routeExpression}=@primaryPostingId)
  `).all(params);
  const opportunityRequests = application.source_opportunity_id === null
    ? []
    : db.prepare(`
    SELECT c.*,s.slug AS sensitivity,'opportunity' AS request_scope,
      ${routeExpression} AS effective_job_posting_id
    FROM opportunity_information_request_current c
    JOIN profile_information_fields f ON f.id=c.information_field_id
    JOIN information_sensitivity_levels s ON s.id=f.sensitivity_level_id
    WHERE c.opportunity_id=@opportunityId
      AND (@primaryPostingId IS NULL OR ${routeExpression} IS NULL OR ${routeExpression}=@primaryPostingId)
  `).all(params);
  const requests = [...applicationRequests, ...opportunityRequests];

  const requirednessRank = { required: 0, conditional: 1, preferred: 2, optional: 3, unknown: 4 };
  const scopeRank = { application: 0, opportunity: 1 };
  return requests.map((request) => {
    const storedAssessmentState = request.assessment_state;
    const storedIsGap = Number(Boolean(request.is_gap));
    const resolution = verifyInformationResolution(db, request);
    const resolutionStale = storedAssessmentState === 'available' && !resolution.current;
    return {
      ...request,
      stored_assessment_state: storedAssessmentState,
      stored_is_gap: storedIsGap,
      effective_assessment_state: resolutionStale ? 'needs_review' : storedAssessmentState,
      is_gap: Number(Boolean(storedIsGap || resolutionStale)),
      resolution_current: Boolean(resolution.current),
      resolution_stale: resolutionStale
    };
  }).sort((left, right) => (
    (requirednessRank[left.requiredness] ?? 5) - (requirednessRank[right.requiredness] ?? 5)
    || String(right.observed_at || '').localeCompare(String(left.observed_at || ''))
    || (scopeRank[left.request_scope] ?? 2) - (scopeRank[right.request_scope] ?? 2)
    || right.id - left.id
  ));
}

function summarizeEffectiveApplicationInformationRequests(applicationId, requests) {
  const id = positiveId(applicationId, 'application id');
  const rows = Array.isArray(requests) ? requests : [];
  const count = (predicate) => rows.filter(predicate).length;
  const isGap = (request) => Boolean(request.is_gap);
  const effectiveState = (request) => request.effective_assessment_state || request.assessment_state;
  const confirmedMissingCount = count(isGap);
  const blockingMissingCount = count((request) => isGap(request) && ['required', 'conditional'].includes(request.requiredness));
  const staleResolutionCount = count((request) => Boolean(request.resolution_stale));
  return {
    application_id: id,
    request_count: rows.length,
    unassessed_count: count((request) => effectiveState(request) === 'unassessed'),
    available_count: count((request) => effectiveState(request) === 'available'),
    confirmed_missing_count: confirmedMissingCount,
    blocking_missing_count: blockingMissingCount,
    optional_missing_count: count((request) => isGap(request) && ['optional', 'preferred'].includes(request.requiredness)),
    needs_review_count: count((request) => effectiveState(request) === 'needs_review'),
    not_applicable_count: count((request) => effectiveState(request) === 'not_applicable'),
    stale_resolution_count: staleResolutionCount,
    has_confirmed_missing: Number(confirmedMissingCount > 0),
    has_blocking_gap: Number(blockingMissingCount > 0),
    has_stale_resolution: Number(staleResolutionCount > 0)
  };
}

function getEffectiveApplicationInformationGaps(db, applicationId) {
  const requests = readEffectiveApplicationInformationRequests(db, applicationId);
  return {
    summary: summarizeEffectiveApplicationInformationRequests(applicationId, requests),
    requests: requests.filter((request) => Boolean(request.is_gap)).map((request) => ({
      ...request,
      assessment_state: request.effective_assessment_state
    }))
  };
}

function listInformationRequests(db, input) {
  const target = resolveInformationTarget(db, input);
  const state = optionalText(input.state || input.assessment);
  if (state && !db.prepare('SELECT 1 FROM information_assessment_states WHERE slug=?').get(state)) {
    throw new ProfileNormalizationError('VALIDATION_ERROR', `Unknown assessment state: ${state}`);
  }
  return db.prepare(`
    SELECT * FROM ${target.currentView} WHERE ${target.targetColumn}=@targetId
    ${state ? 'AND assessment_state=@state' : ''} ORDER BY observed_at DESC,id DESC
  `).all({ targetId: target.id, state });
}

function getInformationGaps(db, input = {}) {
  const provided = informationTargetInputs(input);
  if (provided.length === 0) {
    const applications = db.prepare('SELECT id FROM applications ORDER BY id').all()
      .map(({ id }) => summarizeEffectiveApplicationInformationRequests(
        id,
        readEffectiveApplicationInformationRequests(db, id)
      ))
      .sort((left, right) => right.has_confirmed_missing - left.has_confirmed_missing
        || right.confirmed_missing_count - left.confirmed_missing_count
        || left.application_id - right.application_id);
    return {
      applications,
      opportunities: db.prepare('SELECT * FROM opportunity_profile_gap_summary ORDER BY has_confirmed_missing DESC,confirmed_missing_count DESC,opportunity_id').all()
    };
  }
  const target = resolveInformationTarget(db, input);
  if (target.kind === 'application') {
    const result = getEffectiveApplicationInformationGaps(db, target.id);
    return { target: { kind: target.kind, id: target.id }, ...result };
  }
  const summary = db.prepare(`SELECT * FROM ${target.summaryView} WHERE ${target.targetColumn}=?`).get(target.id);
  const requests = db.prepare(`SELECT * FROM ${target.currentView} WHERE ${target.targetColumn}=? AND assessment_state='confirmed_missing' ORDER BY observed_at DESC,id DESC`).all(target.id);
  return { target: { kind: target.kind, id: target.id }, summary, requests };
}

function listInformationFields(db) {
  return db.prepare(`
    SELECT f.*,v.slug value_kind,s.slug sensitivity
    FROM profile_information_fields f
    JOIN information_value_kinds v ON v.id=f.value_kind_id
    JOIN information_sensitivity_levels s ON s.id=f.sensitivity_level_id
    ORDER BY s.sort_rank,f.slug
  `).all();
}

function resolveInformationTarget(db, input) {
  const targets = informationTargetInputs(input);
  if (targets.length !== 1) throw new ProfileNormalizationError('INVALID_TARGET', 'Provide exactly one of --application-id or --opportunity-id');
  if (targets[0] === 'application') {
    const id = positiveId(input.applicationId, 'application id');
    if (!db.prepare('SELECT 1 FROM applications WHERE id=?').get(id)) throw new ProfileNormalizationError('NOT_FOUND', `Application not found: ${id}`);
    return {
      kind: 'application', id, targetColumn: 'application_id', requestTable: 'application_information_requests',
      assessmentTable: 'application_information_assessments', currentView: 'application_information_request_current',
      summaryView: 'application_profile_gap_summary'
    };
  }
  const id = positiveId(input.opportunityId, 'opportunity id');
  if (!db.prepare('SELECT 1 FROM opportunities WHERE id=?').get(id)) throw new ProfileNormalizationError('NOT_FOUND', `Opportunity not found: ${id}`);
  return {
    kind: 'opportunity', id, targetColumn: 'opportunity_id', requestTable: 'opportunity_information_requests',
    assessmentTable: 'opportunity_information_assessments', currentView: 'opportunity_information_request_current',
    summaryView: 'opportunity_profile_gap_summary'
  };
}

function informationTargetInputs(input) {
  return [['application', input.applicationId], ['opportunity', input.opportunityId]]
    .filter(([, value]) => value !== undefined && value !== null && value !== '').map(([kind]) => kind);
}

function currentRequest(db, target, requestId) {
  return db.prepare(`SELECT * FROM ${target.currentView} WHERE id=?`).get(requestId);
}

function validateRequestEvidenceLinks(db, target, snapshotId, postingId) {
  if (postingId) {
    const row = target.kind === 'application'
      ? db.prepare(`
          SELECT 1 FROM applications a LEFT JOIN application_postings ap
            ON ap.application_id=a.id AND ap.job_posting_id=?
          WHERE a.id=? AND (a.primary_job_posting_id=? OR ap.job_posting_id IS NOT NULL)
        `).get(postingId, target.id, postingId)
      : db.prepare(`
          SELECT 1 FROM opportunities o WHERE o.id=? AND (
            o.primary_job_posting_id=? OR EXISTS (
              SELECT 1 FROM opportunity_snapshots s WHERE s.opportunity_id=o.id AND s.job_posting_id=?
            )
          )
        `).get(target.id, postingId, postingId);
    if (!row) throw new ProfileNormalizationError('EVIDENCE_SCOPE_MISMATCH', 'Posting must be explicitly linked to the target');
  }
  if (snapshotId) {
    let snapshot;
    if (target.kind === 'opportunity') {
      snapshot = db.prepare('SELECT * FROM opportunity_snapshots WHERE id=? AND opportunity_id=?').get(snapshotId, target.id);
    } else {
      snapshot = db.prepare(`
        SELECT s.* FROM opportunity_snapshots s JOIN applications a ON a.id=?
        LEFT JOIN application_postings ap ON ap.application_id=a.id AND ap.job_posting_id=s.job_posting_id
        WHERE s.id=? AND (
          (s.opportunity_id=a.source_opportunity_id AND s.job_posting_id IS NULL)
          OR s.job_posting_id=a.primary_job_posting_id OR ap.job_posting_id IS NOT NULL
        )
      `).get(target.id, snapshotId);
    }
    if (!snapshot) throw new ProfileNormalizationError('EVIDENCE_SCOPE_MISMATCH', 'Snapshot must belong to the target opportunity/opening');
    if (postingId && snapshot.job_posting_id !== postingId) {
      throw new ProfileNormalizationError('EVIDENCE_SCOPE_MISMATCH', 'Snapshot and posting do not match');
    }
  }
}

function assertProfileEnum(db, vocabularyTable, raw, label, nullable = false) {
  if ((raw === undefined || raw === null || String(raw).trim() === '') && nullable) return null;
  const slug = normalizeEnumSlug(requiredText(raw, label));
  if (!db.prepare(`SELECT 1 FROM ${vocabularyTable} WHERE slug=?`).get(slug)) {
    const allowed = db.prepare(`SELECT slug FROM ${vocabularyTable} ORDER BY id`).all().map((row) => row.slug);
    throw new ProfileNormalizationError('VALIDATION_ERROR', `${label} must be one of: ${allowed.join(', ')}`);
  }
  return slug;
}

function assertProfileProficiency(db, raw, domain = 'skill') {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const slug = normalizeEnumSlug(raw);
  const row = db.prepare(`
    SELECT 1 FROM profile_proficiency_levels l
    JOIN profile_proficiency_level_domains ld ON ld.profile_proficiency_level_id=l.id
    JOIN profile_proficiency_domains d ON d.id=ld.profile_proficiency_domain_id
    WHERE l.slug=? AND d.slug=?
  `).get(slug, domain);
  if (!row) {
    const allowed = db.prepare(`
      SELECT l.slug FROM profile_proficiency_levels l
      JOIN profile_proficiency_level_domains ld ON ld.profile_proficiency_level_id=l.id
      JOIN profile_proficiency_domains d ON d.id=ld.profile_proficiency_domain_id
      WHERE d.slug=? ORDER BY l.sort_rank
    `).all(domain).map((item) => item.slug);
    throw new ProfileNormalizationError('VALIDATION_ERROR', `${domain} proficiency must be one of: ${allowed.join(', ')}`);
  }
  return slug;
}

function resolveExactCompanyId(db, raw) {
  if (!raw) return null;
  const normalized = normalizeCatalogText(raw);
  const direct = db.prepare('SELECT id FROM companies WHERE normalized_name=?').get(normalized);
  if (direct) return direct.id;
  const alias = db.prepare('SELECT company_id id FROM company_aliases WHERE normalized_alias=?').get(normalized);
  return alias?.id || null;
}

function resolveExactSkillId(db, raw) {
  if (!raw) return null;
  const normalized = normalizeCatalogText(raw);
  const direct = db.prepare('SELECT id FROM skills WHERE normalized_name=?').get(normalized);
  if (direct) return direct.id;
  const alias = db.prepare('SELECT skill_id id FROM skill_aliases WHERE normalized_alias=?').get(normalized);
  return alias?.id || null;
}

function serializeTag(db, tag) {
  const namespace = db.prepare('SELECT slug,label FROM tag_namespaces WHERE id=?').get(tag.tag_namespace_id);
  return { id: tag.id, namespace: namespace.slug, namespaceLabel: namespace.label, slug: tag.slug, label: tag.label };
}

function parseLegacyList(value) {
  if (Array.isArray(value)) return uniqueStrings(value);
  if (value === undefined || value === null || value === '') return [];
  try {
    const parsed = JSON.parse(String(value));
    if (Array.isArray(parsed)) return uniqueStrings(parsed);
  } catch { /* legacy CSV fallback */ }
  return uniqueStrings(String(value).split(','));
}

function uniqueStrings(values) {
  const result = [];
  const seen = new Set();
  for (const value of values) {
    const text = String(value).trim();
    if (!text) continue;
    const normalized = normalizeTagLabel(text);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(text);
  }
  return result;
}

function normalizeTagLabel(value) {
  return requiredText(value, 'tag').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function tagSlug(value) {
  const slug = normalizeTagLabel(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9+#.]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || `tag-${sha256(value).slice(0, 12)}`;
}

function normalizeEnumSlug(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
}

function ensureColumn(db, table, column, definition) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function positiveId(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new ProfileNormalizationError('VALIDATION_ERROR', `${label} must be a positive integer`);
  return number;
}

function optionalPositiveId(value, label) {
  return value === undefined || value === null || value === '' ? null : positiveId(value, label);
}

function parseExpectedAssessmentId(value) {
  if (value === 'none') return null;
  if (value === undefined || value === null || value === '') {
    throw new ProfileNormalizationError('VALIDATION_ERROR', '--expected-assessment-id is required; use none when no current assessment exists');
  }
  return positiveId(value, 'expected assessment id');
}

function requiredText(value, label) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new ProfileNormalizationError('VALIDATION_ERROR', `${label} is required`);
  }
  return String(value).trim();
}

function optionalText(value) {
  return value === undefined || value === null || String(value).trim() === '' ? null : String(value).trim();
}

function boundedText(value, label, maxLength) {
  const text = requiredText(value, label);
  if (text.length > maxLength) throw new ProfileNormalizationError('VALIDATION_ERROR', `${label} exceeds ${maxLength} characters`);
  return text;
}

function optionalBoundedText(value, label, maxLength) {
  const text = optionalText(value);
  if (text && text.length > maxLength) throw new ProfileNormalizationError('VALIDATION_ERROR', `${label} exceeds ${maxLength} characters`);
  return text;
}

function optionalConfidence(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) throw new ProfileNormalizationError('VALIDATION_ERROR', 'tag confidence must be from 0 to 1');
  return number;
}

function validateOptionalUrl(value) {
  const text = optionalText(value);
  if (!text) return null;
  let url;
  try { url = new URL(text); } catch { throw new ProfileNormalizationError('VALIDATION_ERROR', 'source URL must be valid'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new ProfileNormalizationError('VALIDATION_ERROR', 'source URL must use http or https and contain no credentials');
  }
  return url.toString();
}

function normalizedTimestamp(value, label) {
  const text = requiredText(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) {
    throw new ProfileNormalizationError('VALIDATION_ERROR', `${label} must be an offset-bearing ISO-8601 timestamp`);
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new ProfileNormalizationError('VALIDATION_ERROR', `${label} must be a valid timestamp`);
  return date.toISOString();
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/**
 * Toggle whether a profile entry may be provided as material to generation
 * contexts. Hidden entries vanish from the source catalog, and selecting a
 * hidden id fails closed as ineligible. This is the operator's curation of
 * what the drafting model may see — orthogonal to display_status, which
 * curates the public export.
 */
function setGenerationVisibility(db, { entryId, hidden }) {
  const id = Number(entryId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ProfileNormalizationError('INVALID_INPUT', 'entry id must be a positive integer');
  }
  if (typeof hidden !== 'boolean') {
    throw new ProfileNormalizationError('INVALID_INPUT', '--hidden must be true or false');
  }
  const entry = db.prepare('SELECT id, category, title, generation_hidden FROM profile_entries WHERE id=?').get(id);
  if (!entry) throw new ProfileNormalizationError('NOT_FOUND', `Profile entry ${id} not found`);
  db.prepare("UPDATE profile_entries SET generation_hidden=?, updated_at=datetime('now') WHERE id=?")
    .run(hidden ? 1 : 0, id);
  return {
    entry: db.prepare('SELECT id, category, title, generation_hidden FROM profile_entries WHERE id=?').get(id),
    changed: Boolean(entry.generation_hidden) !== hidden
  };
}

module.exports = {
  PROFILE_NORMALIZATION_MIGRATION_NAME,
  PROFILE_NORMALIZATION_SCHEMA_VERSION,
  PROFILE_NORMALIZATION_USER_VERSION,
  ProfileNormalizationError,
  setGenerationVisibility,
  assessInformationRequest,
  assertProfileEnum,
  assertProfileProficiency,
  assignTag,
  getEffectiveApplicationInformationGaps,
  getInformationGaps,
  listInformationFields,
  listInformationRequests,
  listTags,
  markInformationRequest,
  migrateProfileNormalization,
  readEffectiveApplicationInformationRequests,
  removeTag,
  summarizeEffectiveApplicationInformationRequests,
  syncAllOpportunityTags,
  syncAllProfileNormalization,
  verifyInformationResolution
};
