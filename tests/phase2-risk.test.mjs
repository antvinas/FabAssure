import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRisk, occurrenceFromBaseline, applyRiskOverride, defaultVerificationPlan, RISK_RULE_VERSION } from '../src/domain/risk.mjs';

const bases = Object.freeze({
    severity: 'Synthetic defect effect', occurrence: 'AOI baseline rows',
    detectability: 'Inspection control', scope: 'Recipe and module context',
    criticalCharacteristic: 'Characteristic registry', safetyRelevance: 'Synthetic assessment'
});
const input = (severity, occurrence, detectability, scope, extra = {}) => ({
    severity, occurrence, detectability, scope,
    criticalCharacteristic: false, safetyRelevance: false, bases, ...extra
});

test('ordered demonstration rules keep decisive match and every score boundary', () => {
    for (const [ratings, level, rule] of [
        [[1, 1, 1, 1], 'L1', 'R06'],
        [[2, 1, 1, 1], 'L1', 'R06'],
        [[2, 1, 2, 1], 'L2', 'R05'],
        [[2, 2, 2, 2], 'L2', 'R05'],
        [[2, 3, 2, 2], 'L3', 'R04'],
        [[3, 3, 2, 3], 'L3', 'R04']
    ]) {
        const result = classifyRisk(input(...ratings));
        assert.equal(result.score, ratings.reduce((sum, rating) => sum + rating, 0));
        assert.equal(result.computedLevel, level);
        assert.equal(result.finalLevel, level);
        assert.equal(result.matchedRule, rule);
        assert.equal(result.ruleVersion, RISK_RULE_VERSION);
        assert.deepEqual(result.inputs.bases, bases);
    }
    assert.equal(classifyRisk(input(3, 3, 3, 3)).matchedRule, 'R03');
    assert.equal(classifyRisk(input(3, 1, 3, 1)).matchedRule, 'R03');
    assert.equal(classifyRisk(input(1, 1, 1, 1, { criticalCharacteristic: true })).matchedRule, 'R02');
    assert.equal(classifyRisk(input(1, 1, 1, 1, { criticalCharacteristic: true, safetyRelevance: true })).matchedRule, 'R01');
});

test('baseline occurrence uses explicit AOI denominator and conservative missing evidence', () => {
    assert.equal(occurrenceFromBaseline({ defectCount: 0, inspectedUnits: 100 }), 1);
    assert.equal(occurrenceFromBaseline({ defectCount: 9, inspectedUnits: 1000 }), 1);
    assert.equal(occurrenceFromBaseline({ defectCount: 10, inspectedUnits: 1000 }), 2);
    assert.equal(occurrenceFromBaseline({ defectCount: 29, inspectedUnits: 1000 }), 2);
    assert.equal(occurrenceFromBaseline({ defectCount: 30, inspectedUnits: 1000 }), 3);
    assert.equal(occurrenceFromBaseline({ defectCount: null, inspectedUnits: 0 }), 3);
    assert.throws(() => occurrenceFromBaseline({ defectCount: 12, inspectedUnits: 10 }), /baseline|count|units/i);
    assert.throws(() => occurrenceFromBaseline({ defectCount: 12, inspectedUnits: 0 }), /baseline|count|units/i);
});

test('classification requires six explicit inputs and a basis for each', () => {
    assert.throws(() => classifyRisk(input(1, 1, 1, 1, { safetyRelevance: null })), /safety|unknown/i);
    assert.throws(() => classifyRisk(input(0, 1, 1, 1)), /severity/i);
    assert.throws(() => classifyRisk(input(1, 1, 1, 1, { bases: { ...bases, scope: '' } })), /basis|scope/i);
    assert.throws(() => classifyRisk(input(1, 1, 1, 1, { criticalCharacteristic: 'false' })), /critical/i);
});

test('override preserves computed rule and enforces floor, rationale and actor separation', () => {
    const medium = classifyRisk(input(2, 1, 2, 1));
    const downward = applyRiskOverride(medium, {
        fromLevel: 'L2', toLevel: 'L1', rationale: 'Synthetic containment evidence', evidenceId: 'EVID-1',
        recordedAt: '2026-09-24T00:00:00.000Z',
        requestedBy: { id: 'ACT-Q1', role: 'Quality Engineer' },
        approvedBy: { id: 'ACT-A1', role: 'Approver' }, beforePlanApproval: true
    });
    assert.equal(downward.computedLevel, 'L2');
    assert.equal(downward.finalLevel, 'L1');
    assert.equal(downward.matchedRule, 'R05');
    assert.equal(downward.override.fromLevel, 'L2');
    assert.equal(downward.override.evidenceId, 'EVID-1');
    assert.equal(downward.override.recordedAt, '2026-09-24T00:00:00.000Z');
    assert.equal(downward.auditPayload.action, 'risk-override');
    assert.equal(downward.auditPayload.ruleVersion, RISK_RULE_VERSION);
    assert.throws(() => applyRiskOverride(medium, {
        fromLevel: 'L2', toLevel: 'L1', rationale: 'x', evidenceId: 'EVID-2', recordedAt: '2026-09-24T00:00:00.000Z',
        requestedBy: { id: 'ACT-Q1', role: 'Quality Engineer' },
        approvedBy: { id: 'ACT-Q1', role: 'Approver' }, beforePlanApproval: true
    }), /distinct|approver/i);
    assert.throws(() => applyRiskOverride(medium, {
        fromLevel: 'L2', toLevel: 'L1', rationale: 'x', evidenceId: 'EVID-2', recordedAt: '2026-09-24T00:00:00.000Z',
        requestedBy: { id: 'ACT-Q1', role: 'Quality Engineer' },
        approvedBy: { id: 'ACT-A1', role: 'Approver' }, beforePlanApproval: false
    }), /plan approval/i);
    const floor = classifyRisk(input(1, 1, 1, 1, { criticalCharacteristic: true }));
    assert.throws(() => applyRiskOverride(floor, {
        fromLevel: 'L3', toLevel: 'L2', rationale: 'x', evidenceId: 'EVID-3', recordedAt: '2026-09-24T00:00:00.000Z',
        requestedBy: { id: 'ACT-Q1', role: 'Quality Engineer' },
        approvedBy: { id: 'ACT-A1', role: 'Approver' }, beforePlanApproval: true
    }), /floor|cannot lower/i);
    assert.throws(() => applyRiskOverride(medium, {
        fromLevel: 'L1', toLevel: 'L3', rationale: 'x', evidenceId: 'EVID-4', recordedAt: '2026-09-24T00:00:00.000Z',
        requestedBy: { id: 'ACT-Q1', role: 'Quality Engineer' }, beforePlanApproval: true
    }), /from level|current/i);
    const upward = applyRiskOverride(medium, {
        fromLevel: 'L2', toLevel: 'L3', rationale: 'Conservative synthetic escalation',
        evidenceId: 'EVID-4', recordedAt: '2026-09-24T00:00:00.000Z',
        requestedBy: { id: 'ACT-Q1', role: 'Quality Engineer' }, beforePlanApproval: true
    });
    assert.equal(upward.finalLevel, 'L3');
    assert.equal(upward.override.approverId, null);
    const highByScore = classifyRisk(input(2, 3, 2, 2));
    assert.throws(() => applyRiskOverride(highByScore, {
        fromLevel: 'L3', toLevel: 'L1', rationale: 'x', evidenceId: 'EVID-5', recordedAt: '2026-09-24T00:00:00.000Z',
        requestedBy: { id: 'ACT-Q1', role: 'Quality Engineer' },
        approvedBy: { id: 'ACT-A1', role: 'Approver' }, beforePlanApproval: true
    }), /one level/i);
});

test('verification defaults exactly match the approved synthetic policy', () => {
    assert.deepEqual(defaultVerificationPlan('L1'), {
        baselineLots: 1, postChangeLots: 1, samplesPerLot: 5, effectivenessLots: 2,
        effectivenessDays: 0, aoiCoverage: 1, maxRejectRate: 0.02, zeroCriticalDefects: true
    });
    assert.deepEqual(defaultVerificationPlan('L2'), {
        baselineLots: 2, postChangeLots: 3, samplesPerLot: 10, effectivenessLots: 5,
        effectivenessDays: 0, aoiCoverage: 1, maxRejectRate: 0.02, zeroCriticalDefects: true
    });
    assert.deepEqual(defaultVerificationPlan('L3'), {
        baselineLots: 3, postChangeLots: 5, samplesPerLot: 20, effectivenessLots: 10,
        effectivenessDays: 7, aoiCoverage: 1, maxRejectRate: 0.02, zeroCriticalDefects: true
    });
});
