import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/data/db.mjs';
import { seedDatabase } from '../src/data/seed.mjs';
import { verifyAuditChain } from '../src/domain/audit.mjs';
import {
    createChange, submitChange, classifyChange, approvePlan,
    startVerification, addMeasurementEvidence, recordAlignmentResult,
    reviseFailedChange, getChangeRevisionContext
} from '../src/domain/change-service.mjs';

const riskInputs = {
    severity: 2, occurrence: 1, detectability: 2, scope: 1,
    criticalCharacteristic: true, safetyRelevance: false,
    bases: {
        severity: 'Synthetic alignment characteristic', occurrence: 'Three baseline lots below 1%',
        detectability: 'AOI and sampled alignment', scope: 'One module and recipe',
        criticalCharacteristic: 'ALIGN-X demo critical characteristic', safetyRelevance: 'No synthetic safety impact'
    }
};

function failedChange(operation) {
    const db = openDatabase(':memory:');
    try {
        seedDatabase(db, { instanceId: 'DATASET-REWORK' });
        createChange(db, {
            id: 'CHG-A', title: 'Synthetic alignment change', actorId: 'ACT-MFG',
            lineId: 'LINE-A', equipmentId: 'EQ-ALIGN-A', moduleId: 'MOD-ALIGN-A',
            recipeRevisionId: 'REC-ALIGN-R2', baselineRef: 'AOI-A-001',
            reason: 'Improve synthetic alignment', at: '2026-08-05T12:00:00.000Z'
        });
        submitChange(db, { changeId: 'CHG-A', actorId: 'ACT-MFG', expectedRevisionNo: 1,
            at: '2026-08-05T12:10:00.000Z' });
        classifyChange(db, { changeId: 'CHG-A', actorId: 'ACT-Q1', expectedRevisionNo: 1,
            assessmentId: 'RISK-A-R1', riskInputs, at: '2026-08-05T12:20:00.000Z' });
        approvePlan(db, { changeId: 'CHG-A', actorId: 'ACT-Q1', expectedRevisionNo: 1,
            planId: 'PLAN-A-R1', at: '2026-08-05T12:30:00.000Z' });
        startVerification(db, { changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
            at: '2026-08-06T08:00:00.000Z' });
        addMeasurementEvidence(db, { changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
            evidenceId: 'EVID-FAIL', measurementId: 'MEAS-A-006-07', at: '2026-08-06T10:01:00.000Z' });
        recordAlignmentResult(db, { changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
            resultId: 'RESULT-FAIL', evidenceId: 'EVID-FAIL', at: '2026-08-06T10:02:00.000Z' });
        return operation(db);
    } finally {
        db.close();
    }
}

const revised = {
    changeId: 'CHG-A', actorId: 'ACT-MFG', expectedRevisionNo: 1,
    failedResultId: 'RESULT-FAIL', newRecipeRevisionId: 'REC-ALIGN-R3',
    reason: 'Correct the failed synthetic R2 alignment offset with R3',
    at: '2026-08-07T12:00:00.000Z'
};

test('failed R2 criterion remains immutable while a linked R3 change revision gets its own risk and plan', () => failedChange(db => {
    const priorContext = getChangeRevisionContext(db, 'CHG-A', 1);
    const priorPlan = JSON.stringify(db.prepare("SELECT * FROM verification_plans WHERE id='PLAN-A-R1'").get());
    const priorEvidence = JSON.stringify(db.prepare("SELECT * FROM evidence_items WHERE id='EVID-FAIL'").get());
    const priorResult = JSON.stringify(db.prepare("SELECT * FROM criterion_results WHERE id='RESULT-FAIL'").get());
    const result = reviseFailedChange(db, revised);
    assert.deepEqual(result, { id: 'CHG-A', revisionId: 'CHG-A-R2', revisionNo: 2, state: 'Draft' });
    const header = db.prepare("SELECT current_revision_no,recipe_revision_id,state FROM changes WHERE id='CHG-A'").get();
    assert.equal(header.current_revision_no, 2);
    assert.equal(header.recipe_revision_id, 'REC-ALIGN-R3');
    assert.equal(header.state, 'Draft');
    assert.equal(getChangeRevisionContext(db, 'CHG-A', 1).recipeRevisionId, 'REC-ALIGN-R2');
    assert.deepEqual(getChangeRevisionContext(db, 'CHG-A', 1), priorContext);
    const newContext = getChangeRevisionContext(db, 'CHG-A', 2);
    assert.equal(newContext.recipeRevisionId, 'REC-ALIGN-R3');
    assert.equal(newContext.equipmentId, 'EQ-ALIGN-A');
    assert.equal(newContext.moduleId, 'MOD-ALIGN-A');
    assert.equal(newContext.baselineRef, 'AOI-A-001');
    const lineage = db.prepare("SELECT parent_revision_id,reason FROM change_revisions WHERE id='CHG-A-R2'").get();
    assert.equal(lineage.parent_revision_id, 'CHG-A-R1');
    assert.match(lineage.reason, /failed synthetic R2/);
    assert.equal(db.prepare("SELECT passed,plan_id,evidence_id FROM criterion_results WHERE id='RESULT-FAIL'").get().passed, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM evidence_items WHERE change_revision_id='CHG-A-R1'").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM verification_plans WHERE change_revision_id='CHG-A-R1'").get().n, 1);
    assert.equal(JSON.stringify(db.prepare("SELECT * FROM verification_plans WHERE id='PLAN-A-R1'").get()), priorPlan);
    assert.equal(JSON.stringify(db.prepare("SELECT * FROM evidence_items WHERE id='EVID-FAIL'").get()), priorEvidence);
    assert.equal(JSON.stringify(db.prepare("SELECT * FROM criterion_results WHERE id='RESULT-FAIL'").get()), priorResult);
    const audit = db.prepare("SELECT entity_revision_id,prior_state,new_state,payload_json FROM audit_events WHERE action='change-revised-after-failure'").get();
    assert.equal(audit.entity_revision_id, 'CHG-A-R2');
    assert.equal(audit.prior_state, 'Needs Rework');
    assert.equal(audit.new_state, 'Draft');
    assert.equal(JSON.parse(audit.payload_json).failedResultId, 'RESULT-FAIL');
    assert.equal(verifyAuditChain(db).count, 8);
    submitChange(db, { changeId: 'CHG-A', actorId: 'ACT-MFG', expectedRevisionNo: 2,
        at: '2026-08-07T12:10:00.000Z' });
    classifyChange(db, { changeId: 'CHG-A', actorId: 'ACT-Q1', expectedRevisionNo: 2,
        assessmentId: 'RISK-A-R2', riskInputs, at: '2026-08-07T12:20:00.000Z' });
    approvePlan(db, { changeId: 'CHG-A', actorId: 'ACT-Q1', expectedRevisionNo: 2,
        planId: 'PLAN-A-R2', at: '2026-08-07T12:30:00.000Z' });
    assert.equal(db.prepare("SELECT change_revision_id FROM verification_plans WHERE id='PLAN-A-R2'").get().change_revision_id,
        'CHG-A-R2');
    assert.throws(() => db.prepare(`
        INSERT INTO criterion_results(id,plan_id,criterion_code,evidence_id,verifier_actor_id,passed,observed_value,unit,recorded_at)
        VALUES ('CROSS-REV','PLAN-A-R2','ALIGN-X','EVID-FAIL','ACT-VER',1,0.04,'mm','2026-08-08T10:02:00.000Z')
    `).run(), /revision mismatch/i);
    assert.equal(verifyAuditChain(db).count, 11);
}));

test('rework rejects stale revision, wrong actor, unlinked failure and wrong recipe family without partial writes', () => failedChange(db => {
    assert.throws(() => reviseFailedChange(db, { ...revised, actorId: 'ACT-Q1' }), /proposer/i);
    assert.throws(() => reviseFailedChange(db, { ...revised, expectedRevisionNo: 2 }), /stale/i);
    assert.throws(() => reviseFailedChange(db, { ...revised, failedResultId: 'MISSING' }), /failed|result/i);
    assert.throws(() => reviseFailedChange(db, { ...revised, newRecipeRevisionId: 'REC-B-R2' }), /recipe|family/i);
    assert.throws(() => reviseFailedChange(db, { ...revised, newRecipeRevisionId: 'REC-ALIGN-R2' }), /newer|revision/i);
    assert.throws(() => reviseFailedChange(db, { ...revised, newRecipeRevisionId: 'REC-ALIGN-R1' }), /newer|revision/i);
    assert.throws(() => reviseFailedChange(db, { ...revised, reason: ' ' }), /reason/i);
    assert.throws(() => reviseFailedChange(db, { ...revised, at: '2026-08-06T09:00:00.000Z' }), /time|previous/i);
    assert.equal(db.prepare("SELECT state FROM changes WHERE id='CHG-A'").get().state, 'Needs Rework');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM change_revisions').get().n, 1);
    assert.equal(verifyAuditChain(db).count, 7);
}));

test('late audit payload rejection rolls back the newly inserted revision and mutable header together', () => failedChange(db => {
    const oversizedRecipeId = `REC-ALIGN-${'X'.repeat(33000)}`;
    db.prepare('INSERT INTO recipe_revisions(id,recipe_code,revision,effective_at) VALUES (?,?,?,?)')
        .run(oversizedRecipeId, 'ALIGN-A', 4, '2026-08-09T00:00:00.000Z');
    assert.throws(() => reviseFailedChange(db, {
        ...revised, newRecipeRevisionId: oversizedRecipeId
    }), /audit payload is too large/i);
    const header = db.prepare("SELECT state,current_revision_no,recipe_revision_id FROM changes WHERE id='CHG-A'").get();
    assert.equal(header.state, 'Needs Rework');
    assert.equal(header.current_revision_no, 1);
    assert.equal(header.recipe_revision_id, 'REC-ALIGN-R2');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM change_revisions').get().n, 1);
    assert.equal(verifyAuditChain(db).count, 7);
}));
