export const RISK_RULE_VERSION = 'FA-DEMO-RISK-1.0';

const orderedLevels = Object.freeze(['L1', 'L2', 'L3']);
const ratingNames = Object.freeze(['severity', 'occurrence', 'detectability', 'scope']);
const basisNames = Object.freeze([...ratingNames, 'criticalCharacteristic', 'safetyRelevance']);

function requireNonempty(value, label) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new TypeError(`${label} is required`);
    }
    return value.trim();
}

export function occurrenceFromBaseline({ defectCount, inspectedUnits } = {}) {
    if (defectCount != null && (!Number.isInteger(defectCount) || defectCount < 0)) {
        throw new RangeError('Invalid synthetic baseline defect count or inspected units');
    }
    if (inspectedUnits != null && (!Number.isInteger(inspectedUnits) || inspectedUnits < 0)) {
        throw new RangeError('Invalid synthetic baseline defect count or inspected units');
    }
    if (inspectedUnits === 0 && defectCount > 0) {
        throw new RangeError('Defect count cannot exceed zero inspected baseline units');
    }
    if (defectCount == null || inspectedUnits == null || inspectedUnits === 0) return 3;
    if (defectCount > inspectedUnits) {
        throw new RangeError('Invalid synthetic baseline defect count or inspected units');
    }
    const rate = defectCount / inspectedUnits;
    return rate < 0.01 ? 1 : rate < 0.03 ? 2 : 3;
}

export function classifyRisk(input) {
    if (input === null || typeof input !== 'object') {
        throw new TypeError('Six risk inputs and their bases are required');
    }
    for (const name of ratingNames) {
        if (!Number.isInteger(input[name]) || input[name] < 1 || input[name] > 3) {
            throw new RangeError(`${name} must be an explicit rating from 1 to 3`);
        }
    }
    if (typeof input.criticalCharacteristic !== 'boolean') {
        throw new TypeError('criticalCharacteristic must be explicitly true or false');
    }
    if (typeof input.safetyRelevance !== 'boolean') {
        throw new TypeError('safetyRelevance cannot be unknown; provide true or false');
    }
    if (input.bases === null || typeof input.bases !== 'object') {
        throw new TypeError('A basis for every risk input is required');
    }
    const bases = {};
    for (const name of basisNames) bases[name] = requireNonempty(input.bases[name], `${name} basis`);

    const score = ratingNames.reduce((sum, name) => sum + input[name], 0);
    let matchedRule;
    let computedLevel;
    if (input.safetyRelevance) [matchedRule, computedLevel] = ['R01', 'L3'];
    else if (input.criticalCharacteristic) [matchedRule, computedLevel] = ['R02', 'L3'];
    else if (input.severity === 3 && input.detectability === 3) [matchedRule, computedLevel] = ['R03', 'L3'];
    else if (score >= 9) [matchedRule, computedLevel] = ['R04', 'L3'];
    else if (score >= 6) [matchedRule, computedLevel] = ['R05', 'L2'];
    else [matchedRule, computedLevel] = ['R06', 'L1'];

    return {
        ruleVersion: RISK_RULE_VERSION,
        inputs: {
            severity: input.severity,
            occurrence: input.occurrence,
            detectability: input.detectability,
            scope: input.scope,
            criticalCharacteristic: input.criticalCharacteristic,
            safetyRelevance: input.safetyRelevance,
            bases
        },
        score, matchedRule, computedLevel, finalLevel: computedLevel, override: null
    };
}

export function applyRiskOverride(assessment, request) {
    if (!assessment || assessment.ruleVersion !== RISK_RULE_VERSION || !orderedLevels.includes(assessment.finalLevel)) {
        throw new TypeError('A current, classified risk assessment is required');
    }
    if (!request || request.beforePlanApproval !== true) {
        throw new Error('Override is allowed only before plan approval');
    }
    const requestedBy = request.requestedBy;
    if (!requestedBy || requestedBy.role !== 'Quality Engineer') {
        throw new Error('A Quality Engineer must request the override');
    }
    const requesterId = requireNonempty(requestedBy.id, 'Quality requester ID');
    const rationale = requireNonempty(request.rationale, 'Override rationale');
    const evidenceId = requireNonempty(request.evidenceId, 'Override evidence ID');
    const fromLevel = assessment.finalLevel;
    if (request.fromLevel !== fromLevel) {
        throw new Error('Explicit override from level must match the current final level');
    }
    const recordedAt = requireNonempty(request.recordedAt, 'Override UTC time');
    if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/.test(recordedAt) ||
        Number.isNaN(Date.parse(recordedAt)) || new Date(recordedAt).toISOString() !== recordedAt) {
        throw new TypeError('Override time must be canonical UTC');
    }
    const toLevel = request.toLevel;
    if (!orderedLevels.includes(toLevel) || toLevel === fromLevel) {
        throw new RangeError('Override target must be a different L1/L2/L3 level');
    }
    const delta = orderedLevels.indexOf(toLevel) - orderedLevels.indexOf(fromLevel);
    let approverId = null;
    if (delta < 0) {
        if (delta !== -1) throw new Error('Downward override is limited to one level');
        if (['R01', 'R02', 'R03'].includes(assessment.matchedRule)) {
            throw new Error('Mandatory L3 floor cannot be lowered');
        }
        if (!request.approvedBy || request.approvedBy.role !== 'Approver') {
            throw new Error('Distinct Approver decision is required for downward override');
        }
        approverId = requireNonempty(request.approvedBy.id, 'Approver ID');
        if (approverId === requesterId) throw new Error('Override Approver must be distinct from requester');
    }
    return {
        ...assessment,
        finalLevel: toLevel,
        override: { fromLevel, toLevel, rationale, evidenceId, requesterId, approverId, recordedAt },
        auditPayload: {
            action: 'risk-override', ruleVersion: assessment.ruleVersion,
            matchedRule: assessment.matchedRule, computedLevel: assessment.computedLevel,
            fromLevel, toLevel, rationale, evidenceId, requesterId, approverId, recordedAt
        }
    };
}

export function defaultVerificationPlan(level) {
    const defaults = {
        L1: [1, 1, 5, 2, 0],
        L2: [2, 3, 10, 5, 0],
        L3: [3, 5, 20, 10, 7]
    }[level];
    if (!defaults) throw new RangeError('Unknown demonstration risk level');
    return {
        baselineLots: defaults[0], postChangeLots: defaults[1], samplesPerLot: defaults[2],
        effectivenessLots: defaults[3], effectivenessDays: defaults[4],
        aoiCoverage: 1, maxRejectRate: 0.02, zeroCriticalDefects: true
    };
}
