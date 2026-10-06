'use strict';

const PROTECTED_APPLICATION_SENSITIVITY_LEVELS = new Set([
  'personal', 'sensitive', 'highly-sensitive', 'restricted'
]);

const PROTECTED_APPLICATION_INPUT_KINDS = new Set([
  'email', 'phone', 'address-group', 'consent', 'signature', 'password', 'hidden', 'system'
]);

const PROTECTED_APPLICATION_EXACT_TERMS = new Set([
  'ssn', 'dob', 'itin', 'iban', 'pin', 'eeo', 'passport', 'password', 'passcode',
  'signature', 'consent', 'demographics', 'disability', 'veteran status'
]);

const PROTECTED_APPLICATION_FIELD_PATTERN = /(?:\bsocial[\s_-]*security\b|\bssn\b|\bnational[\s_-]*insurance\b|\bpassword\b|\bpass[\s_-]*code\b|\bpin\b|\bbank[\s_-]*(?:account|routing|details?)\b|\brouting[\s_-]*(?:number|code|transit)\b|\baccount[\s_-]*(?:number|no|identifier|id)\b|\biban\b|\bswift[\s_-]*code\b|\b(?:credit|debit)[\s_-]*card\b|\bgovernment[\s_-]*(?:id|identifier|number)\b|\bnational[\s_-]*(?:id|identifier|number)\b|\bpassport\b|\bdriver'?s?[\s_-]*licen[cs]e\b|\btax(?:payer)?[\s_-]*(?:id|identifier|number)\b|\bitin\b|\bsignature\b|\b(?:your|applicant|legal)[\s_-]*initials\b|\binitials[\s_-]*(?:here|below)\b|\bconsent\b|\beeo\b|\bequal[\s_-]*employment\b|\bdemographic(?:s)?\b|\brace[\s_-]*(?:or[\s_-]*)?ethnicity\b|\bethnic(?:ity)?\b|\bgender(?:[\s_-]*identity)?\b|\bsex(?:ual[\s_-]*orientation)?\b|\bpronouns?\b|\bveteran(?:[\s_-]*status)?\b|\bdisabilit(?:y|ies)\b|\bmedical\b|\bhealth[\s_-]*(?:condition|history|information|record|status|details?)\b|\bdiagnos(?:is|es|ed)\b|\bdate[\s_-]*of[\s_-]*birth\b|\bbirth[\s_-]*date\b|\bdob\b|\bbiometric\b|\bfull[\s_-]*(?:legal[\s_-]*)?name\b|\blegal[\s_-]*name\b|\bhome[\s_-]*address\b|\bmailing[\s_-]*address\b|\bphone[\s_-]*(?:number|no)\b|\bemail[\s_-]*address\b|\bcitizenship\b|\bnationality\b|\bimmigration\b|\bvisa[\s_-]*(?:status|type)\b|\bwork[\s_-]*authori[sz]ation\b|\bsponsorship[\s_-]*(?:status|requirement|needed)\b|\bcriminal[\s_-]*(?:history|record)\b|\bbackground[\s_-]*check\b|\bconviction\b)/i;

function isProtectedApplicationField(field) {
  if (!field) return false;
  const sensitivity = String(field.sensitivity || field.sensitivity_slug || field.sensitivitySlug || '').toLowerCase();
  if (PROTECTED_APPLICATION_SENSITIVITY_LEVELS.has(sensitivity)) return true;
  const inputKind = String(field.input_kind || field.inputKind || field.field_kind || field.fieldKind || '').toLowerCase();
  if (PROTECTED_APPLICATION_INPUT_KINDS.has(inputKind)) return true;
  const parts = [
    field.provider_field_key,
    field.providerFieldKey,
    field.label,
    field.prompt,
    field.prompt_label,
    field.help_text,
    field.helpText,
    field.information_field_slug,
    field.informationFieldSlug,
    field.profileInformationField
  ].filter(Boolean).map((value) => String(value).replace(/([a-z0-9])([A-Z])/g, '$1 $2'));
  const exactProtected = parts.some((value) => PROTECTED_APPLICATION_EXACT_TERMS.has(
    value.trim().toLowerCase().replace(/[_-]+/g, ' ')
  ));
  return exactProtected || PROTECTED_APPLICATION_FIELD_PATTERN.test(parts.join(' '));
}

module.exports = {
  PROTECTED_APPLICATION_EXACT_TERMS,
  PROTECTED_APPLICATION_FIELD_PATTERN,
  PROTECTED_APPLICATION_INPUT_KINDS,
  PROTECTED_APPLICATION_SENSITIVITY_LEVELS,
  isProtectedApplicationField
};
