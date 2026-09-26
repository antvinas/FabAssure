import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, withValidatedTransaction } from '../src/data/db.mjs';
import { seedDatabase } from '../src/data/seed.mjs';
import { appendAuditEvent, verifyAuditChain } from '../src/domain/audit.mjs';
import { createChange, submitChange, classifyChange, approvePlan } from '../src/domain/change-service.mjs';

const at = {
    draft: '2026-08-05T12:00:00.000Z',
    submit: '2026-08-05T12:10:00.000Z',
    classify: '2026-08-05T12:20:00.000Z',
    plan: '2026-08-05T12:30:00.000Z'
};
const riskInputs = {
    severity: 2, occurrence: 1, detectability: 2, scope: 1,
    criticalCharacteristic: true, safetyRelevance: false,
    bases: {
        severity: 'Synthetic alignment characteristic', occurrence: 'Three baseline lots below 1%',
        detectability: 'AOI plus sampled alignment', scope: 'One integrated module and recipe',
        criticalCharacteristic: 'ALIGN-X is marked critical for this demo',
        safetyRelevance: 'No safety relevance in this synthetic scenario'
    }
};

function fixture(operation) {
    const db = openDatabase(':memory:');
    try {
        seedDatabase(db, { instanceId: 'DATASET-CHANGE' });
        return operation(db);
    } finally {
        db.close();
    }
}

function createA(db, actorId = 'ACT-MFG', id = 'CHG-A') {
    return createChange(db, {
        id, title: 'Synthetic alignment recipe verification', actorId,
        lineId: 'LINE-A', equipmentId: 'EQ-ALIGN-A', moduleId: 'MOD-ALIGN-A',
        recipeRevisionId: 'REC-ALIGN-R2', baselineRef: 'AOI-A-001',
        reason: 'Reduce fictional alignment variation', at: at.draft
    });
}

test('change creation and each forward gate append exactly one same-transaction audit event', () => fixture(db => {
    createA(db);
    assert.equal(db.prepare("SELECT state FROM changes WHERE id='CHG-A'").get().state, 'Draft');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM change_revisions WHERE change_id='CHG-A'").get().n, 1);
    submitChange(db, { changeId: 'CHG-A', actorId: 'ACT-MFG', expectedRevisionNo: 1, at: at.submit });
    const risk = classifyChange(db, {
        changeId: 'CHG-A', actorId: 'ACT-Q1', expectedRevisionNo: 1,
        assessmentId: 'RISK-A', riskInputs, at: at.classify
    });
    assert.equal(risk.matchedRule, 'R02');
    assert.equal(risk.computedLevel, 'L3');
    approvePlan(db, {
        changeId: 'CHG-A', actorId: 'ACT-Q1', expectedRevisionNo: 1,
        planId: 'PLAN-A', at: at.plan
    });
    const plan = db.prepare("SELECT * FROM verification_plans WHERE id='PLAN-A'").get();
    assert.equal(plan.final_level, 'L3');
    assert.equal(plan.baseline_lots, 3);
    assert.equal(plan.post_change_lots, 5);
    assert.equal(plan.samples_per_lot, 20);
    assert.equal(plan.effectiveness_lots, 10);
    assert.equal(plan.effectiveness_days, 7);
    assert.equal(plan.alignment_abs_limit, 0.08);
    assert.equal(plan.max_aoi_reject_rate, 0.02);
    const criteria = db.prepare("SELECT code,threshold FROM plan_criteria WHERE plan_id='PLAN-A' ORDER BY code").all()
        .map(({ code, threshold }) => ({ code, threshold }));
    assert.deepEqual(criteria, [
        { code: 'ALIGN-X', threshold: 0.08 },
        { code: 'AOI-RATE', threshold: 0.02 },
        { code: 'CRITICAL-DEFECTS', threshold: 0 }
    ]);
    assert.equal(db.prepare("SELECT state FROM changes WHERE id='CHG-A'").get().state, 'Plan Approved');
    const auditSteps = db.prepare('SELECT action,prior_state,new_state FROM audit_events ORDER BY sequence').all()
        .map(({ action, prior_state, new_state }) => ({ action, prior_state, new_state }));
    assert.deepEqual(auditSteps, [
        { action: 'change-created', prior_state: null, new_state: 'Draft' },
        { action: 'change-submitted', prior_state: 'Draft', new_state: 'Submitted' },
        { action: 'risk-classified', prior_state: 'Submitted', new_state: 'Risk Classified' },
        { action: 'plan-approved', prior_state: 'Risk Classified', new_state: 'Plan Approved' }
    ]);
    assert.deepEqual(verifyAuditChain(db), {
        valid: true, count: 4,
        lastDigest: db.prepare('SELECT digest FROM audit_events ORDER BY sequence DESC LIMIT 1').get().digest,
        anchored: false
    });
}));

test('invalid source scope, role, stale revision and state gate cause no partial decision or audit', () => fixture(db => {
    assert.throws(() => createChange(db, {
        id: 'CHG-BAD', title: 'Bad', actorId: 'ACT-MFG', lineId: 'LINE-B',
        equipmentId: 'EQ-ALIGN-A', moduleId: 'MOD-ALIGN-A', recipeRevisionId: 'REC-ALIGN-R2',
        baselineRef: 'AOI-A-001', reason: 'Cross line', at: at.draft
    }), /line|scope/i);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM changes').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n, 0);
    assert.throws(() => createChange(db, {
        id: 'CHG-RECIPE-BAD', title: 'Bad recipe', actorId: 'ACT-MFG', lineId: 'LINE-A',
        equipmentId: 'EQ-ALIGN-A', moduleId: 'MOD-ALIGN-A', recipeRevisionId: 'REC-B-R1',
        baselineRef: 'AOI-A-001', reason: 'Cross recipe family', at: at.draft
    }), /recipe|scope/i);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM changes').get().n, 0);
    createA(db);
    assert.throws(() => submitChange(db, { changeId: 'CHG-A', actorId: 'ACT-Q1', expectedRevisionNo: 1, at: at.submit }), /proposer/i);
    assert.throws(() => submitChange(db, { changeId: 'CHG-A', actorId: 'ACT-MFG', expectedRevisionNo: 2, at: at.submit }), /stale|revision/i);
    assert.throws(() => classifyChange(db, { changeId: 'CHG-A', actorId: 'ACT-Q1', expectedRevisionNo: 1, assessmentId: 'RISK-BAD', riskInputs, at: at.classify }), /state|transition|submitted/i);
    assert.equal(db.prepare("SELECT state FROM changes WHERE id='CHG-A'").get().state, 'Draft');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM risk_assessments').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n, 1);
    submitChange(db, { changeId: 'CHG-A', actorId: 'ACT-MFG', expectedRevisionNo: 1, at: at.submit });
    assert.throws(() => classifyChange(db, { changeId: 'CHG-A', actorId: 'ACT-MFG', expectedRevisionNo: 1, assessmentId: 'RISK-BAD', riskInputs, at: at.classify }), /Quality Engineer/i);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM risk_assessments').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n, 2);
}));

test('a stored downgrade cannot lower an R02 L3 floor at plan approval', () => fixture(db => {
    createA(db);
    submitChange(db, { changeId: 'CHG-A', actorId: 'ACT-MFG', expectedRevisionNo: 1, at: at.submit });
    classifyChange(db, { changeId: 'CHG-A', actorId: 'ACT-Q1', expectedRevisionNo: 1,
        assessmentId: 'RISK-A', riskInputs, at: at.classify });
    db.prepare(`
        INSERT INTO evidence_items(id,change_revision_id,source_table,source_id,evidence_type,payload_json,sha256,recorded_by,recorded_at)
        VALUES ('EVID-OVR','CHG-A-R1','embedded_note','EVID-OVR','note','{"text":"Synthetic override request"}',?,'ACT-Q1',?)
    `).run('a'.repeat(64), at.classify);
    db.prepare(`
        INSERT INTO risk_overrides(id,assessment_id,from_level,to_level,rationale,evidence_id,requester_actor_id,approver_actor_id,recorded_at)
        VALUES ('OVR-BAD','RISK-A','L3','L2','Invalid synthetic downgrade','EVID-OVR','ACT-Q1','ACT-APP',?)
    `).run(at.classify);
    withValidatedTransaction(db, handle => appendAuditEvent(handle, {
        actorId: 'ACT-Q1', recordedAt: at.classify, entityType: 'change', entityId: 'CHG-A',
        entityRevisionId: 'CHG-A-R1', action: 'risk-override',
        payload: { overrideId: 'OVR-BAD', fromLevel: 'L3', toLevel: 'L2' }
    }));
    assert.throws(() => approvePlan(db, { changeId: 'CHG-A', actorId: 'ACT-Q1', expectedRevisionNo: 1,
        planId: 'PLAN-BAD', at: at.plan }), /floor|override|L3/i);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM verification_plans').get().n, 0);
    assert.equal(db.prepare("SELECT state FROM changes WHERE id='CHG-A'").get().state, 'Risk Classified');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n, 4);
}));

test('late criterion insertion failure rolls back plan and audit together', () => fixture(db => {
    createA(db);
    submitChange(db, { changeId: 'CHG-A', actorId: 'ACT-MFG', expectedRevisionNo: 1, at: at.submit });
    classifyChange(db, { changeId: 'CHG-A', actorId: 'ACT-Q1', expectedRevisionNo: 1,
        assessmentId: 'RISK-A', riskInputs, at: at.classify });
    db.exec("CREATE TRIGGER injected_late_plan_failure BEFORE INSERT ON plan_criteria WHEN NEW.code='AOI-RATE' BEGIN SELECT RAISE(ABORT,'injected late failure'); END");
    try {
        assert.throws(() => approvePlan(db, { changeId: 'CHG-A', actorId: 'ACT-Q1', expectedRevisionNo: 1,
            planId: 'PLAN-LATE', at: at.plan }), /injected late failure/i);
    } finally {
        db.exec('DROP TRIGGER injected_late_plan_failure');
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM verification_plans').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM plan_criteria').get().n, 0);
    assert.equal(db.prepare("SELECT state FROM changes WHERE id='CHG-A'").get().state, 'Risk Classified');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n, 3);
}));

test('L3 Quality proposer cannot approve own plan; separate Quality actor can', () => fixture(db => {
    createA(db, 'ACT-Q1', 'CHG-Q');
    submitChange(db, { changeId: 'CHG-Q', actorId: 'ACT-Q1', expectedRevisionNo: 1, at: at.submit });
    classifyChange(db, { changeId: 'CHG-Q', actorId: 'ACT-Q1', expectedRevisionNo: 1, assessmentId: 'RISK-Q', riskInputs, at: at.classify });
    assert.throws(() => approvePlan(db, { changeId: 'CHG-Q', actorId: 'ACT-Q1', expectedRevisionNo: 1, planId: 'PLAN-Q', at: at.plan }), /independent|proposer/i);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM verification_plans').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n, 3);
    approvePlan(db, { changeId: 'CHG-Q', actorId: 'ACT-Q2', expectedRevisionNo: 1, planId: 'PLAN-Q', at: at.plan });
    assert.equal(db.prepare("SELECT approved_by FROM verification_plans WHERE id='PLAN-Q'").get().approved_by, 'ACT-Q2');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n, 4);
}));
