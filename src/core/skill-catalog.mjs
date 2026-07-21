const SPECIALIST_NAMES = [
  'security-operations-lead',
  'smart-contract-reviewer',
  'exploit-validation-specialist',
  'threat-research-analyst',
  'detection-rules-engineer',
  'incident-triage-lead',
  'controls-compliance-reviewer',
  'cloud-hardening-architect',
  'secure-systems-architect',
  'secure-code-reviewer',
  'security-domain-router'
];

export const SKILL_CATALOG = Object.freeze(SPECIALIST_NAMES.map((specialistId) => Object.freeze({
  skillId: `linmas-${specialistId}`,
  specialistId,
  legacyAliases: Object.freeze([specialistId]),
  kind: specialistId === 'security-domain-router' ? 'router' : 'specialist'
})));

export const PUBLIC_SKILL_IDS = Object.freeze(SKILL_CATALOG.map(({ skillId }) => skillId));
export const SPECIALIST_IDS = Object.freeze(SKILL_CATALOG.map(({ specialistId }) => specialistId));
export const SPECIALIST_IDENTIFIERS = Object.freeze(
  SKILL_CATALOG
    .filter(({ kind }) => kind === 'specialist')
    .flatMap(({ skillId, legacyAliases }) => [skillId, ...legacyAliases])
);

const BY_IDENTIFIER = new Map(
  SKILL_CATALOG.flatMap((entry) => [entry.skillId, ...entry.legacyAliases].map((identifier) => [identifier, entry]))
);

export function resolveSkill(identifier) {
  return typeof identifier === 'string' && identifier ? BY_IDENTIFIER.get(identifier) ?? null : null;
}

export function toSpecialistId(identifier) {
  const entry = resolveSkill(identifier);
  return entry?.kind === 'specialist' ? entry.specialistId : null;
}

export function matchesSkillIdentifier(manifestName, requestedIdentifier) {
  const requested = resolveSkill(requestedIdentifier);
  if (!requested) return manifestName === requestedIdentifier;
  return manifestName === requested.skillId || requested.legacyAliases.includes(manifestName);
}
