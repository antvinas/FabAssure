import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { openDatabase, withValidatedTransaction, assertDataIntegrity } from '../src/data/db.mjs';
import { seedDatabase } from '../src/data/seed.mjs';
import { appendAuditEvent, verifyAuditChain } from '../src/domain/audit.mjs';
import { createLocalServer, listenLocal } from '../src/server/http.mjs';
import { evaluateChangeEffectiveness, reopenChangeMonitoring }
    from '../src/domain/change-effectiveness-service.mjs';
import {
    createChange, submitChange, classifyChange, approvePlan, startVerification,
    recordBaselineSet, addMeasurementEvidence, recordAlignmentResult,
    addAoiEvidence, recordAoiResults, markEvidenceReady,
    beginIndependentReview, recordIndependentReview, acceptChange,
    getAcceptanceStatus, reconcileConditionalAcceptances,
    classifyLegacyAcceptance, assertOperatingAcceptance, reviseExpiredChange,
    reviseFailedEffectivenessChange, reviseFailedChange,
    getChangeRevisionContext
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
const at = (day, time) => `2026-08-${String(day).padStart(2, '0')}T${time}.000Z`;
const suffix = day => String(day).padStart(3, '0');

function fixture(options, operation) {
    const db = openDatabase(options.filename ?? ':memory:');
    try {
        seedDatabase(db, { instanceId: 'DATASET-READY' });
        createChange(db, {
            id: 'CHG-A', title: 'Synthetic R3 verification', actorId: 'ACT-MFG',
            lineId: 'LINE-A', equipmentId: 'EQ-ALIGN-A', moduleId: 'MOD-ALIGN-A',
            recipeRevisionId: 'REC-ALIGN-R3', baselineRef: 'AOI-A-001',
            reason: 'Verify synthetic alignment improvement', at: at(7, '12:00:00')
        });
        submitChange(db, { changeId: 'CHG-A', actorId: 'ACT-MFG', expectedRevisionNo: 1,
            at: at(7, '12:10:00') });
        classifyChange(db, { changeId: 'CHG-A', actorId: 'ACT-Q1', expectedRevisionNo: 1,
            assessmentId: 'RISK-A', riskInputs, at: at(7, '12:20:00') });
        approvePlan(db, { changeId: 'CHG-A', actorId: 'ACT-Q1', expectedRevisionNo: 1,
            planId: 'PLAN-A', at: at(7, '12:30:00') });
        startVerification(db, { changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
            at: at(8, options.delayedStart ? '08:15:00' : '08:00:00') });
        if (options.baseline !== false) {
            recordBaselineSet(db, { changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
                evidenceId: 'EVID-BASE', at: at(8, options.delayedStart ? '08:16:00' : '08:01:00') });
        }
        for (let day = 8; day <= 12; day++) {
            for (let unit = 1; unit <= 20; unit++) {
                const id = `MEAS-A-${suffix(day)}-${String(unit).padStart(2, '0')}`;
                addMeasurementEvidence(db, {
                    changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
                    evidenceId: `EVID-${suffix(day)}-${String(unit).padStart(2, '0')}`,
                    measurementId: id, at: at(day, '10:01:00')
                });
            }
            if (options.aoiEvidence !== false) {
                addAoiEvidence(db, {
                    changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
                    evidenceId: `EVID-AOI-${suffix(day)}`, inspectionId: `AOI-A-${suffix(day)}`,
                    at: at(day, '10:31:00')
                });
            }
        }
        recordAlignmentResult(db, {
            changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
            resultId: 'RESULT-ALIGN', evidenceId: 'EVID-012-20', at: at(12, '12:01:00')
        });
        if (options.aoiResults !== false) {
            recordAoiResults(db, { changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
                resultPrefix: 'RESULT-AOI', at: at(12, '12:02:00') });
        }
        return operation(db);
    } finally {
        db.close();
    }
}

const ready = { changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
    at: at(12, '12:03:00') };

const begin = { changeId: 'CHG-A', actorId: 'ACT-REV', expectedRevisionNo: 1,
    at: at(12, '12:04:00') };
const pass = { changeId: 'CHG-A', actorId: 'ACT-REV', expectedRevisionNo: 1,
    reviewId: 'REVIEW-A', decision: 'Pass', reason: 'Synthetic verification package is complete',
    at: at(12, '12:05:00') };
const accept = { changeId: 'CHG-A', actorId: 'ACT-APP', expectedRevisionNo: 1,
    acceptanceId: 'ACCEPT-A', reviewId: 'REVIEW-A',
    reason: 'Synthetic acceptance after independent review', at: at(12, '12:06:00'),
    acceptanceType: 'Ordinary' };

function readyAndReviewed(db) {
    const frozen = markEvidenceReady(db, ready);
    beginIndependentReview(db, begin);
    recordIndependentReview(db, pass);
    return frozen;
}

test('independent passing review and separate approver accept the same frozen package', () => fixture({}, db => {
    const frozen = readyAndReviewed(db);
    const decision = acceptChange(db, accept);
    assert.equal(decision.state, 'Accepted');
    assert.equal(decision.frozenDigest, frozen.packageDigest);
    const row = db.prepare("SELECT * FROM acceptances WHERE id='ACCEPT-A'").get();
    assert.equal(row.frozen_digest, frozen.packageDigest);
    assert.equal(row.plan_id, 'PLAN-A');
    assert.equal(row.review_id, 'REVIEW-A');
    assert.equal(row.approver_actor_id, 'ACT-APP');
    assert.equal(db.prepare("SELECT state FROM changes WHERE id='CHG-A'").get().state, 'Accepted');
    assert.equal(verifyAuditChain(db).count, 117);
}));

test('future independent review cannot strand the current Change before Acceptance', () => fixture({}, db => {
    markEvidenceReady(db, ready);
    beginIndependentReview(db, begin);
    const before = verifyAuditChain(db).count;
    assert.throws(() => recordIndependentReview(db, { ...pass,
        at: '2099-01-01T00:00:00.000Z', serverNow: pass.at }), /server UTC/i);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reviews').get().n, 0);
    assert.equal(verifyAuditChain(db).count, before);
    assert.equal(recordIndependentReview(db, { ...pass,
        serverNow: pass.at }).decision, 'Pass');
}));

test('HTTP overwrites client clock before a future independent Change review', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fabassure-review-clock-'));
    const filename = join(directory, 'review.sqlite');
    let db;
    let server;
    try {
        fixture({ filename }, seeded => {
            markEvidenceReady(seeded, ready);
            beginIndependentReview(seeded, begin);
        });
        db = openDatabase(filename);
        const auditBefore = verifyAuditChain(db).count;
        server = createLocalServer(db, { assetsDir: join(resolve(fileURLToPath(
            new URL('..', import.meta.url))), 'assets', 'ui'), clock: () => pass.at });
        const local = await listenLocal(server, 0);
        const send = async input => {
            const response = await fetch(new URL('/api/actions', local.url), {
                method: 'POST', headers: { 'content-type': 'application/json',
                    'x-fabassure-local': '1', origin: local.url },
                body: JSON.stringify({ action: 'recordIndependentReview', input }) });
            return response.status;
        };
        assert.equal(await send({ ...pass, at: '2099-01-01T00:00:00.000Z',
            serverNow: '2099-01-01T00:00:00.000Z' }), 409);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reviews').get().n, 0);
        assert.equal(verifyAuditChain(db).count, auditBefore);
        assert.equal(await send(pass), 200);
        assert.equal(db.prepare('SELECT reviewed_at FROM reviews WHERE id=?')
            .get(pass.reviewId).reviewed_at, pass.at);
    } finally {
        if (server?.listening) await new Promise(resolve => server.close(resolve));
        db?.close();
        const withinTemp = relative(resolve(tmpdir()), resolve(directory));
        assert.ok(withinTemp && !withinTemp.startsWith('..'));
        rmSync(directory, { recursive: true, force: true });
    }
});

test('a conditional Change acceptance cannot omit its approver-specified UTC expiry', () => fixture({}, db => {
    readyAndReviewed(db);
    const before = verifyAuditChain(db).count;
    assert.throws(() => acceptChange(db, { ...accept,
        acceptanceType: 'Conditional', condition: 'Synthetic monitoring condition' }),
    /expir|due|UTC|condition/i);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM acceptances').get().n, 0);
    assert.equal(db.prepare("SELECT state FROM changes WHERE id='CHG-A'").get().state,
        'Independent Review');
    assert.equal(verifyAuditChain(db).count, before);
}));

test('failed monitoring before first closure opens a controlled new Change cycle', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fabassure-change-preclose-'));
    const filename = join(directory, 'preclose.sqlite');
    try {
        fixture({ filename }, db => {
            readyAndReviewed(db);
            acceptChange(db, accept);
            const original = db.prepare("SELECT * FROM acceptances WHERE id='ACCEPT-A'").get();
            assert.equal(evaluateChangeEffectiveness(db, {
                changeId: 'CHG-A', expectedRevisionNo: 1, id: 'EFF-A-INSUFFICIENT',
                actorId: 'ACT-Q1', at: at(13, '08:00:00'),
                serverNow: at(13, '08:00:00')
            }).status, 'Monitoring');
            assert.throws(() => reopenChangeMonitoring(db, {
                changeId: 'CHG-A', expectedRevisionNo: 1,
                id: 'REOPEN-A-INSUFFICIENT', checkId: 'EFF-A-INSUFFICIENT',
                actorId: 'ACT-Q1', reason: 'Insufficient lots are not a failure',
                at: at(13, '08:01:00'), serverNow: at(13, '08:01:00')
            }), /failed monitoring audit|failed source-derived/i);
            db.prepare(`INSERT INTO equipment_events(id,equipment_id,module_id,event_type,
                occurred_at,duration_seconds) VALUES (?,?,?,?,?,?)`).run(
                'EV-A-MONITOR-ALARM', 'EQ-ALIGN-A', 'MOD-ALIGN-A', 'alarm',
                at(13, '10:00:00'), 0);
            const failed = evaluateChangeEffectiveness(db, {
                changeId: 'CHG-A', expectedRevisionNo: 1, id: 'EFF-A-EARLY-ALARM',
                actorId: 'ACT-Q1', at: at(13, '12:30:00'),
                serverNow: at(13, '12:30:00')
            });
            assert.equal(failed.status, 'Reopen Required');
            assert.equal(db.prepare("SELECT state FROM changes WHERE id='CHG-A'").get().state,
                'Effectiveness Monitoring');
            const reopened = reopenChangeMonitoring(db, {
                changeId: 'CHG-A', expectedRevisionNo: 1,
                id: 'REOPEN-A-EARLY-ALARM', checkId: 'EFF-A-EARLY-ALARM',
                actorId: 'ACT-Q1', reason: 'Unresolved alarm in first monitoring window',
                at: at(13, '12:31:00'), serverNow: at(13, '12:31:00')
            });
            assert.equal(reopened.state, 'Reopened');
            assert.equal(reopened.nextCycleNo, 2);
            assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM audit_events
                WHERE entity_id='CHG-A' AND action='change-monitoring-closed'`).get().n, 0);
            const revised = reviseFailedEffectivenessChange(db, {
                changeId: 'CHG-A', expectedRevisionNo: 1, actorId: 'ACT-MFG',
                reason: 'Investigate alarm and verify a new controlled plan',
                at: at(13, '12:32:00'), serverNow: at(13, '12:32:00')
            });
            assert.equal(revised.revisionNo, 2);
            assert.equal(revised.state, 'Draft');
            assert.equal(getChangeRevisionContext(db, 'CHG-A', 2).revisionId,
                'CHG-A-R2');
            assert.deepEqual(db.prepare("SELECT * FROM acceptances WHERE id='ACCEPT-A'").get(),
                original);
            submitChange(db, { changeId: 'CHG-A', actorId: 'ACT-MFG',
                expectedRevisionNo: 2, at: at(13, '12:33:00') });
            classifyChange(db, { changeId: 'CHG-A', actorId: 'ACT-Q1',
                expectedRevisionNo: 2, assessmentId: 'RISK-A-R2', riskInputs,
                at: at(13, '12:34:00') });
            approvePlan(db, { changeId: 'CHG-A', actorId: 'ACT-Q1',
                expectedRevisionNo: 2, planId: 'PLAN-A-R2', at: at(13, '12:35:00') });
            startVerification(db, { changeId: 'CHG-A', actorId: 'ACT-VER',
                expectedRevisionNo: 2, at: at(13, '12:36:00') });
            db.prepare(`INSERT INTO lots(id,product_family_id,code,quantity,start_at,end_at)
                VALUES (?,?,?,?,?,?)`).run('LOT-A-REWORK', 'PF-CAMERA', 'LOT-A-REWORK',
                100, at(13, '13:00:00'), at(13, '15:00:00'));
            db.prepare(`INSERT INTO process_runs(id,lot_id,equipment_id,module_id,
                recipe_revision_id,start_at,end_at,processed_units)
                VALUES (?,?,?,?,?,?,?,?)`).run('RUN-A-REWORK', 'LOT-A-REWORK',
                'EQ-ALIGN-A', 'MOD-ALIGN-A', 'REC-ALIGN-R3',
                at(13, '13:10:00'), at(13, '14:00:00'), 100);
            db.prepare(`INSERT INTO inspection_samples(id,lot_id,process_run_id,
                sampled_at,sample_size) VALUES (?,?,?,?,?)`).run('SAMPLE-A-REWORK',
                'LOT-A-REWORK', 'RUN-A-REWORK', at(13, '13:30:00'), 1);
            db.prepare(`INSERT INTO measurements(id,inspection_sample_id,characteristic_id,
                value,unit,method,recorded_at) VALUES (?,?,?,?,?,?,?)`).run(
                'MEAS-A-REWORK', 'SAMPLE-A-REWORK', 'CHAR-ALIGN-X', 0.20, 'mm',
                'synthetic vision gauge', at(13, '13:31:00'));
            db.prepare(`INSERT INTO aoi_inspections(id,lot_id,process_run_id,
                inspected_at,inspected_units,rejected_units)
                VALUES (?,?,?,?,?,?)`).run('AOI-A-REWORK', 'LOT-A-REWORK',
                'RUN-A-REWORK', at(13, '13:50:00'), 100, 0);
            addMeasurementEvidence(db, { changeId: 'CHG-A', actorId: 'ACT-VER',
                expectedRevisionNo: 2, evidenceId: 'EVID-A-REWORK',
                measurementId: 'MEAS-A-REWORK', at: at(13, '14:01:00') });
            assert.equal(recordAlignmentResult(db, { changeId: 'CHG-A',
                actorId: 'ACT-VER', expectedRevisionNo: 2,
                resultId: 'RESULT-A-REWORK', evidenceId: 'EVID-A-REWORK',
                at: at(13, '14:02:00') }).passed, false);
            db.prepare(`INSERT INTO recipe_revisions(id,recipe_code,revision,effective_at)
                VALUES (?,?,?,?)`).run('REC-ALIGN-R4', 'ALIGN-A', 4,
                at(13, '15:00:00'));
            const next = reviseFailedChange(db, { changeId: 'CHG-A',
                expectedRevisionNo: 2, actorId: 'ACT-MFG',
                failedResultId: 'RESULT-A-REWORK',
                newRecipeRevisionId: 'REC-ALIGN-R4',
                reason: 'Correct failed second-cycle alignment result',
                at: at(13, '15:10:00') });
            assert.equal(next.revisionNo, 3);
            assert.doesNotThrow(() => assertDataIntegrity(db));
            assert.deepEqual(db.prepare("SELECT * FROM acceptances WHERE id='ACCEPT-A'").get(),
                original);
            db.prepare(`INSERT INTO lots(id,product_family_id,code,quantity,start_at,end_at)
                VALUES (?,?,?,?,?,?)`).run('LOT-A-BACKFILL', 'PF-CAMERA',
                'LOT-A-BACKFILL', 100, at(13, '08:00:00'), at(13, '11:00:00'));
            assert.throws(() => db.prepare(`INSERT INTO process_runs(id,lot_id,
                equipment_id,module_id,recipe_revision_id,start_at,end_at,
                processed_units) VALUES (?,?,?,?,?,?,?,?)`).run('RUN-A-BACKFILL',
                'LOT-A-BACKFILL', 'EQ-ALIGN-A', 'MOD-ALIGN-A', 'REC-ALIGN-R3',
                at(13, '09:00:00'), at(13, '10:00:00'), 100),
            /backdated Change run/i);
        });
        const reopenedDb = openDatabase(filename);
        try {
            assert.equal(reopenedDb.prepare("SELECT state FROM changes WHERE id='CHG-A'")
                .get().state, 'Draft');
            assert.deepEqual(reopenedDb.prepare(`SELECT id FROM effectiveness_checks
                WHERE change_revision_id='CHG-A-R1' ORDER BY recorded_at`).all()
                .map(item => item.id), ['EFF-A-INSUFFICIENT', 'EFF-A-EARLY-ALARM']);
            assert.equal(reopenedDb.prepare(`SELECT COUNT(*) AS n FROM audit_events
                WHERE entity_id='CHG-A' AND action='change-monitoring-closed'`).get().n, 0);
        } finally { reopenedDb.close(); }
    } finally {
        const withinTemp = relative(resolve(tmpdir()), resolve(directory));
        assert.ok(withinTemp && !withinTemp.startsWith('..'));
        rmSync(directory, { recursive: true, force: true });
    }
});

test('conditional expiry uses exact server UTC boundary and records one immutable system event', () => fixture({}, db => {
    readyAndReviewed(db);
    const due = at(13, '09:00:00');
    acceptChange(db, { ...accept, acceptanceType: 'Conditional',
        condition: '  Keep AOI evidence under review  ', expiresAt: due,
        serverNow: at(12, '12:06:00') });
    const original = db.prepare("SELECT * FROM acceptances WHERE id='ACCEPT-A'").get();
    const auditBefore = verifyAuditChain(db).count;
    assert.equal(getAcceptanceStatus(db, 'ACCEPT-A', at(13, '08:59:59')).expired, false);
    assert.deepEqual(reconcileConditionalAcceptances(db, at(13, '08:59:59')), []);
    assert.equal(assertOperatingAcceptance(db, 'CHG-A-R1', at(13, '08:59:59'))
        .operationallyValid, true);
    assert.equal(getAcceptanceStatus(db, 'ACCEPT-A', due).expired, true);
    assert.throws(() => assertOperatingAcceptance(db, 'CHG-A-R1', due), /expired/i);
    const events = reconcileConditionalAcceptances(db, due);
    assert.equal(events.length, 1);
    assert.equal(db.prepare("SELECT state,cycle_no FROM changes WHERE id='CHG-A'").get().state,
        'Reopened');
    assert.equal(db.prepare("SELECT * FROM conditional_acceptance_expiries WHERE acceptance_id='ACCEPT-A'")
        .get().effective_at, due);
    assert.deepEqual(db.prepare("SELECT * FROM acceptances WHERE id='ACCEPT-A'").get(), original);
    assert.equal(verifyAuditChain(db).count, auditBefore + 1);
    assert.deepEqual(reconcileConditionalAcceptances(db, at(13, '09:00:01')), []);
    assert.equal(verifyAuditChain(db).count, auditBefore + 1);
    assert.equal(getAcceptanceStatus(db, 'ACCEPT-A', at(13, '08:59:59')).expired, true);
    assert.throws(() => reviseExpiredChange(db, { changeId: 'CHG-A',
        expectedRevisionNo: 1, actorId: 'ACT-APP', reason: 'Renew the condition',
        at: at(13, '09:00:01') }), /proposer/i);
    assert.throws(() => reviseExpiredChange(db, { changeId: 'CHG-A',
        expectedRevisionNo: 1, actorId: 'ACT-MFG', reason: 'Renew the condition',
        at: at(13, '09:00:01'), serverNow: due }), /server UTC/i);
    assert.equal(verifyAuditChain(db).count, auditBefore + 1);
    const next = reviseExpiredChange(db, { changeId: 'CHG-A',
        expectedRevisionNo: 1, actorId: 'ACT-MFG', reason: 'Collect fresh AOI evidence',
        at: at(13, '09:00:01') });
    assert.equal(next.revisionNo, 2);
    assert.equal(db.prepare("SELECT state FROM changes WHERE id='CHG-A'").get().state, 'Draft');
    assert.deepEqual(db.prepare("SELECT * FROM acceptances WHERE id='ACCEPT-A'").get(), original);
    assert.throws(() => assertOperatingAcceptance(db, 'CHG-A-R1', at(13, '09:00:01')),
        /expired|current/i);
}));

test('a linked expired revision can use only its explicitly accepted descendant as current authority', () => {
    const db = new DatabaseSync(':memory:');
    try {
        db.exec(`CREATE TABLE changes(id TEXT,state TEXT,current_revision_no INTEGER);
            CREATE TABLE change_revisions(id TEXT,change_id TEXT,revision_no INTEGER,
                parent_revision_id TEXT);
            CREATE TABLE acceptances(id TEXT,change_revision_id TEXT,
                acceptance_type TEXT,condition_text TEXT,expires_at TEXT);
            CREATE TABLE legacy_acceptance_classifications(acceptance_id TEXT,
                classification_type TEXT,condition_text TEXT,expires_at TEXT);
            CREATE TABLE conditional_acceptance_expiries(id TEXT,acceptance_id TEXT);
            INSERT INTO changes VALUES('CHG-LINK','Accepted',2);
            INSERT INTO change_revisions VALUES('CHG-LINK-R1','CHG-LINK',1,NULL);
            INSERT INTO change_revisions VALUES('CHG-LINK-R2','CHG-LINK',2,'CHG-LINK-R1');
            INSERT INTO acceptances VALUES('ACCEPT-LINK-R1','CHG-LINK-R1',
                'Conditional','Renew after AOI review','2026-08-13T09:00:00.000Z');
            INSERT INTO conditional_acceptance_expiries VALUES('EXP-LINK','ACCEPT-LINK-R1');`);
        const now = at(14, '09:00:00');
        assert.throws(() => assertOperatingAcceptance(db, 'CHG-LINK-R1', now),
            /new accepted/i);
        db.exec(`INSERT INTO acceptances VALUES('ACCEPT-LINK-R2','CHG-LINK-R2',
            'Ordinary',NULL,NULL)`);
        const authority = assertOperatingAcceptance(db, 'CHG-LINK-R1', now);
        assert.equal(authority.acceptanceId, 'ACCEPT-LINK-R2');
        assert.equal(authority.authorityRevisionId, 'CHG-LINK-R2');
        assert.equal(authority.linkedRevisionId, 'CHG-LINK-R1');
        assert.equal(authority.renewedAuthority, true);
        db.exec(`UPDATE acceptances SET acceptance_type=NULL WHERE id='ACCEPT-LINK-R1'`);
        assert.throws(() => assertOperatingAcceptance(db, 'CHG-LINK-R1', now),
            /classification/i);
        db.exec(`UPDATE acceptances SET acceptance_type='Conditional'
            WHERE id='ACCEPT-LINK-R1';
            UPDATE acceptances SET acceptance_type='Conditional',
                condition_text='Second explicit condition',
                expires_at='2026-08-14T09:00:00.000Z'
            WHERE id='ACCEPT-LINK-R2'`);
        assert.throws(() => assertOperatingAcceptance(db, 'CHG-LINK-R1', now),
            /expired/i);
    } finally {
        db.close();
    }
});

test('conditional decision rejects missing, malformed and nonlater UTC expiry', () => fixture({}, db => {
    readyAndReviewed(db);
    for (const acceptanceType of ['Ordinary', 'Conditional']) {
        assert.throws(() => acceptChange(db, {
            ...accept, acceptanceType, at: at(13, '09:00:01'),
            serverNow: at(13, '09:00:00'),
            ...(acceptanceType === 'Conditional' ? {
                condition: 'AOI review', expiresAt: at(14, '09:00:00')
            } : {})
        }), /server UTC/i);
    }
    const { acceptanceType: _ignored, ...untyped } = accept;
    assert.throws(() => acceptChange(db, untyped), /type|Ordinary|Conditional/i);
    for (const expiresAt of [undefined, '2026-08-13T09:00:00+09:00',
        '2026-08-13T99:00:00.000Z', at(12, '12:06:00'), at(12, '12:05:59')]) {
        assert.throws(() => acceptChange(db, { ...accept, acceptanceType: 'Conditional',
            condition: 'AOI review', expiresAt }), /UTC|expir|time/i);
    }
    assert.throws(() => acceptChange(db, { ...accept, acceptanceType: 'Conditional',
        condition: ' ', expiresAt: at(13, '09:00:00') }), /condition/i);
    assert.throws(() => acceptChange(db, { ...accept, acceptanceType: 'Conditional',
        condition: 'AOI review', expiresAt: at(13, '09:00:00'),
        serverNow: at(13, '09:00:00') }), /server UTC|later|expiry/i);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM acceptances').get().n, 0);
}));

test('legacy UNKNOWN stays readable but needs a separate Approver classification for operating use', () => fixture({}, db => {
    readyAndReviewed(db);
    acceptChange(db, accept);
    const guard = db.prepare("SELECT sql FROM sqlite_master WHERE name='immutable_acceptance_update'")
        .get().sql;
    db.exec('DROP TRIGGER immutable_acceptance_update');
    db.prepare("UPDATE acceptances SET acceptance_type=NULL WHERE id='ACCEPT-A'").run();
    db.exec(guard);
    const original = db.prepare("SELECT * FROM acceptances WHERE id='ACCEPT-A'").get();
    const history = db.prepare("SELECT id,digest FROM audit_events WHERE action='change-accepted'")
        .all();
    assert.equal(getAcceptanceStatus(db, 'ACCEPT-A', at(13, '08:00:00')).type, 'UNKNOWN');
    assert.throws(() => assertOperatingAcceptance(db, 'CHG-A-R1', at(13, '08:00:00')),
        /classification/i);
    const auditBeforeGate = verifyAuditChain(db).count;
    assert.throws(() => evaluateChangeEffectiveness(db, {
        changeId: 'CHG-A', expectedRevisionNo: 1, id: 'EFF-LEGACY-UNKNOWN',
        actorId: 'ACT-Q1', at: at(13, '08:00:01'),
        serverNow: at(13, '08:00:01')
    }), /classification/i);
    assert.equal(verifyAuditChain(db).count, auditBeforeGate);
    assert.equal(verifyAuditChain(db).valid, true);
    assert.throws(() => classifyLegacyAcceptance(db, { id: 'CLASS-A',
        acceptanceId: 'ACCEPT-A', actorId: 'ACT-APP', at: at(13, '08:00:00'),
        reason: 'Unspecified type' }), /explicit|type|choice/i);
    assert.throws(() => classifyLegacyAcceptance(db, { id: 'CLASS-A', acceptanceId: 'ACCEPT-A',
        actorId: 'ACT-Q1', at: at(13, '08:00:00'), reason: 'Review source record',
        acceptanceType: 'Ordinary' }), /Approver/i);
    assert.throws(() => classifyLegacyAcceptance(db, { id: 'CLASS-A', acceptanceId: 'ACCEPT-A',
        actorId: 'ACT-APP', at: at(13, '08:00:00'), reason: 'Review source record',
        acceptanceType: 'Conditional', condition: 'AOI review' }), /expir/i);
    for (const acceptanceType of ['Ordinary', 'Conditional']) {
        assert.throws(() => classifyLegacyAcceptance(db, {
            id: 'CLASS-FUTURE', acceptanceId: 'ACCEPT-A', actorId: 'ACT-APP',
            at: at(13, '08:00:01'), serverNow: at(13, '08:00:00'),
            reason: 'Future classification must fail', acceptanceType,
            ...(acceptanceType === 'Conditional' ? {
                condition: 'AOI review', expiresAt: at(14, '08:00:00')
            } : {})
        }), /server UTC/i);
    }
    const result = classifyLegacyAcceptance(db, { id: 'CLASS-A', acceptanceId: 'ACCEPT-A',
        actorId: 'ACT-APP', at: at(13, '08:00:00'), reason: 'Review source record',
        acceptanceType: 'Conditional', condition: 'AOI review',
        expiresAt: at(14, '08:00:00'), serverNow: at(13, '08:00:00') });
    assert.equal(result.classificationType, 'Conditional');
    assert.equal(evaluateChangeEffectiveness(db, {
        changeId: 'CHG-A', expectedRevisionNo: 1, id: 'EFF-LEGACY-CLASSIFIED',
        actorId: 'ACT-Q1', at: at(13, '08:01:00'),
        serverNow: at(13, '08:01:00')
    }).status, 'Monitoring');
    assert.equal(assertOperatingAcceptance(db, 'CHG-A-R1', at(14, '07:59:59'))
        .operationallyValid, true);
    assert.throws(() => assertOperatingAcceptance(db, 'CHG-A-R1', at(14, '08:00:00')),
        /expired/i);
    const classifiedExpiry = reconcileConditionalAcceptances(db, at(14, '08:00:00'));
    assert.equal(classifiedExpiry.length, 1);
    assert.deepEqual(reconcileConditionalAcceptances(db, at(14, '08:00:01')), []);
    assert.equal(db.prepare("SELECT state FROM changes WHERE id='CHG-A'").get().state,
        'Reopened');
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM audit_events
        WHERE action='conditional-acceptance-expired'`).get().n, 1);
    assert.deepEqual(db.prepare("SELECT * FROM acceptances WHERE id='ACCEPT-A'").get(), original);
    assert.deepEqual(db.prepare("SELECT id,digest FROM audit_events WHERE action='change-accepted'")
        .all(), history);
    assert.throws(() => classifyLegacyAcceptance(db, { id: 'CLASS-SECOND',
        acceptanceId: 'ACCEPT-A', actorId: 'ACT-APP', at: at(13, '09:00:00'),
        reason: 'Duplicate', acceptanceType: 'Ordinary' }), /already classified/i);
    assert.equal(verifyAuditChain(db).valid, true);
}));

function makeHistoricalV5File(filename, mutatePayload = null) {
    const db = new DatabaseSync(filename);
    const source = readFileSync(new URL('../src/data/schema-v2.sql', import.meta.url), 'utf8');
    const originalAcceptanceTable = source.match(/CREATE TABLE acceptances \([\s\S]*?\n\);/)[0];
    const originalAuditTable = source.match(/CREATE TABLE audit_events \([\s\S]*?\n\);/)[0];
    const originalAuditTriggers = ['audit_append_guard', 'immutable_audit_update',
        'immutable_audit_delete'].map(name => source.match(
        new RegExp(`CREATE TRIGGER ${name}[^]*?END;`))[0]);
    const acceptanceColumns = ['id', 'change_revision_id', 'plan_id', 'review_id',
        'review_decision', 'approver_actor_id', 'accepted_at', 'frozen_digest'];
    const auditColumns = ['sequence', 'id', 'dataset_instance_id', 'recorded_at',
        'actor_id', 'simulated_role', 'entity_type', 'entity_id', 'entity_revision_id',
        'action', 'prior_state', 'new_state', 'reason', 'payload_json',
        'payload_sha256', 'previous_digest', 'digest'];
    try {
        db.exec('PRAGMA foreign_keys=OFF');
        db.exec('BEGIN IMMEDIATE');
        const acceptances = db.prepare('SELECT * FROM acceptances ORDER BY id').all();
        const audit = db.prepare('SELECT * FROM audit_events ORDER BY sequence').all();
        assert.equal(audit.at(-1).action, 'change-accepted');
        const acceptedEvent = audit.at(-1);
        const oldPayload = JSON.parse(acceptedEvent.payload_json);
        delete oldPayload.acceptanceType;
        delete oldPayload.condition;
        delete oldPayload.expiresAt;
        if (mutatePayload) mutatePayload(oldPayload);
        acceptedEvent.payload_json = JSON.stringify(oldPayload);
        const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');
        acceptedEvent.payload_sha256 = sha256(acceptedEvent.payload_json);
        const envelope = {
            id: acceptedEvent.id, datasetInstanceId: acceptedEvent.dataset_instance_id,
            recordedAt: acceptedEvent.recorded_at, actorId: acceptedEvent.actor_id,
            simulatedRole: acceptedEvent.simulated_role,
            entityType: acceptedEvent.entity_type, entityId: acceptedEvent.entity_id,
            entityRevisionId: acceptedEvent.entity_revision_id,
            action: acceptedEvent.action, priorState: acceptedEvent.prior_state,
            newState: acceptedEvent.new_state, reason: acceptedEvent.reason,
            payloadSha256: acceptedEvent.payload_sha256,
            previousDigest: acceptedEvent.previous_digest
        };
        acceptedEvent.digest = sha256(JSON.stringify(Object.fromEntries(
            Object.keys(envelope).sort().map(key => [key, envelope[key]]))));
        const acceptanceTriggers = db.prepare(`SELECT sql FROM sqlite_master
            WHERE type='trigger' AND tbl_name='acceptances'
                AND name<>'acceptance_condition_guard' ORDER BY name`).all();
        const migrationGuard = db.prepare(`SELECT sql FROM sqlite_master
            WHERE name='immutable_migration_delete'`).get().sql;
        for (const { name } of db.prepare(`SELECT name FROM sqlite_master
            WHERE type='trigger' AND name LIKE 'change_%_after_effectiveness_guard'`).all()) {
            db.exec(`DROP TRIGGER ${name}`);
        }
        db.exec(`DROP TRIGGER incident_cycle_latest_check_guard;
            DROP TRIGGER incident_cycle_check_audit_guard;
            DROP VIEW change_revision_frozen_scope`);
        db.exec(`DROP TRIGGER equipment_event_after_effectiveness_guard;
            DROP TRIGGER equipment_resolution_after_effectiveness_guard;
            DROP TRIGGER aoi_defect_after_effectiveness_guard;
            DROP TABLE conditional_acceptance_expiries;
            DROP TABLE legacy_acceptance_classifications;
            DROP TABLE acceptances;
            DROP TABLE audit_events;
            DROP TABLE system_principals;`);
        db.exec(originalAuditTable);
        const insertAudit = db.prepare(`INSERT INTO audit_events(${auditColumns.join(',')})
            VALUES (${auditColumns.map(() => '?').join(',')})`);
        for (const row of audit) insertAudit.run(...auditColumns.map(column => row[column]));
        for (const sql of originalAuditTriggers) db.exec(sql);
        db.exec(originalAcceptanceTable);
        const insertAcceptance = db.prepare(`INSERT INTO acceptances(${acceptanceColumns.join(',')})
            VALUES (${acceptanceColumns.map(() => '?').join(',')})`);
        for (const row of acceptances) {
            insertAcceptance.run(...acceptanceColumns.map(column => row[column]));
        }
        for (const row of acceptanceTriggers) db.exec(row.sql);
        db.exec('DROP TRIGGER immutable_migration_delete');
        db.prepare("DELETE FROM schema_migrations WHERE id='MIG-009'").run();
        db.prepare("DELETE FROM schema_migrations WHERE id='MIG-008'").run();
        db.prepare("DELETE FROM schema_migrations WHERE id='MIG-007'").run();
        db.prepare("DELETE FROM schema_migrations WHERE id='MIG-006'").run();
        db.exec(migrationGuard);
        db.exec('PRAGMA user_version=5');
        db.exec('COMMIT');
        db.exec('PRAGMA foreign_keys=ON');
        assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
    } finally { db.close(); }
}

test('real v5 file migration preserves unknown Acceptance and audit through restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fabassure-accept-v5-'));
    const filename = join(directory, 'legacy.sqlite');
    try {
        let original;
        let historicalAudit;
        let scenarioSources;
        fixture({ filename }, db => {
            readyAndReviewed(db);
            acceptChange(db, accept);
            original = db.prepare(`SELECT id,change_revision_id,plan_id,review_id,
                review_decision,approver_actor_id,accepted_at,frozen_digest FROM acceptances
                WHERE id='ACCEPT-A'`).get();
            scenarioSources = {
                lots: db.prepare(`SELECT * FROM lots
                    WHERE id IN ('LOT-A-001','LOT-B-002','LOT-B-004') ORDER BY id`).all(),
                runs: db.prepare(`SELECT * FROM process_runs
                    WHERE id IN ('RUN-A-001','RUN-B-002','RUN-B-004') ORDER BY id`).all(),
                aoi: db.prepare(`SELECT * FROM aoi_inspections
                    WHERE id IN ('AOI-A-001','AOI-B-002','AOI-B-004') ORDER BY id`).all()
            };
            assert.equal(scenarioSources.lots.length, 3);
            assert.equal(scenarioSources.runs.length, 3);
            assert.equal(scenarioSources.aoi.length, 3);
        });
        makeHistoricalV5File(filename);
        const v5 = new DatabaseSync(filename);
        try {
            assert.equal(v5.prepare('PRAGMA user_version').get().user_version, 5);
            historicalAudit = v5.prepare(`SELECT id,digest,payload_json FROM audit_events
                WHERE action='change-accepted'`).get();
            assert.equal(JSON.parse(historicalAudit.payload_json).acceptanceType, undefined);
        } finally { v5.close(); }
        let db = openDatabase(filename);
        try {
            assert.equal(db.prepare('PRAGMA user_version').get().user_version, 9);
            const migrated = db.prepare("SELECT * FROM acceptances WHERE id='ACCEPT-A'").get();
            for (const [key, value] of Object.entries(original)) assert.equal(migrated[key], value);
            assert.equal(migrated.acceptance_type, null);
            assert.equal(migrated.expires_at, null);
            assert.deepEqual(db.prepare(`SELECT id,digest,payload_json FROM audit_events
                WHERE action='change-accepted'`).get(), historicalAudit);
            assert.equal(getAcceptanceStatus(db, 'ACCEPT-A', at(13, '08:00:00')).type,
                'UNKNOWN');
            assert.throws(() => assertOperatingAcceptance(db, 'CHG-A-R1', at(13, '08:00:00')),
                /classification/i);
            assert.equal(db.prepare('SELECT COUNT(*) AS n FROM legacy_acceptance_classifications')
                .get().n, 0);
            assert.equal(db.prepare('SELECT COUNT(*) AS n FROM conditional_acceptance_expiries')
                .get().n, 0);
            assert.deepEqual(db.prepare(`SELECT * FROM lots
                WHERE id IN ('LOT-A-001','LOT-B-002','LOT-B-004') ORDER BY id`).all(),
            scenarioSources.lots);
            assert.deepEqual(db.prepare(`SELECT * FROM process_runs
                WHERE id IN ('RUN-A-001','RUN-B-002','RUN-B-004') ORDER BY id`).all(),
            scenarioSources.runs);
            assert.deepEqual(db.prepare(`SELECT * FROM aoi_inspections
                WHERE id IN ('AOI-A-001','AOI-B-002','AOI-B-004') ORDER BY id`).all(),
            scenarioSources.aoi);
            assert.equal(verifyAuditChain(db).valid, true);
        } finally { db.close(); }
        db = openDatabase(filename);
        try {
            assert.equal(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id='MIG-006'")
                .get().n, 1);
            assert.equal(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id='MIG-007'")
                .get().n, 1);
            assert.equal(db.prepare('SELECT COUNT(*) AS n FROM legacy_acceptance_classifications')
                .get().n, 0);
            assert.deepEqual(db.prepare(`SELECT id,digest,payload_json FROM audit_events
                WHERE action='change-accepted'`).get(), historicalAudit);
            assert.deepEqual(db.prepare(`SELECT * FROM lots
                WHERE id IN ('LOT-A-001','LOT-B-002','LOT-B-004') ORDER BY id`).all(),
            scenarioSources.lots);
        } finally { db.close(); }
    } finally {
        const withinTemp = relative(resolve(tmpdir()), resolve(directory));
        assert.ok(withinTemp && !withinTemp.startsWith('..'));
        rmSync(directory, { recursive: true, force: true });
    }
});

test('real v5 UNKNOWN unlocks only after explicit conditional classification and expires once', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fabassure-accept-v5-classified-'));
    const filename = join(directory, 'legacy.sqlite');
    try {
        let original;
        let originalAudit;
        fixture({ filename }, db => {
            readyAndReviewed(db);
            acceptChange(db, accept);
            original = db.prepare("SELECT * FROM acceptances WHERE id='ACCEPT-A'").get();
        });
        makeHistoricalV5File(filename);
        let db = openDatabase(filename);
        try {
            originalAudit = db.prepare(`SELECT id,digest,payload_json FROM audit_events
                WHERE action='change-accepted'`).get();
            assert.equal(getAcceptanceStatus(db, 'ACCEPT-A', at(13, '08:00:00')).type,
                'UNKNOWN');
            assert.throws(() => evaluateChangeEffectiveness(db, {
                changeId: 'CHG-A', expectedRevisionNo: 1,
                id: 'EFF-V5-BEFORE-CLASS', actorId: 'ACT-Q1',
                at: at(13, '08:00:01'), serverNow: at(13, '08:00:01')
            }), /classification/i);
            assert.throws(() => classifyLegacyAcceptance(db, {
                id: 'CLASS-V5-NO-DUE', acceptanceId: 'ACCEPT-A',
                actorId: 'ACT-APP', acceptanceType: 'Conditional',
                condition: 'Review later AOI', reason: 'Explicit source review',
                at: at(13, '08:00:00'), serverNow: at(13, '08:00:00')
            }), /expir/i);
            classifyLegacyAcceptance(db, {
                id: 'CLASS-V5-EXPLICIT', acceptanceId: 'ACCEPT-A',
                actorId: 'ACT-APP', acceptanceType: 'Conditional',
                condition: 'Review later AOI', expiresAt: at(14, '08:00:00'),
                reason: 'Explicit source review', at: at(13, '08:00:00'),
                serverNow: at(13, '08:00:00')
            });
            assert.equal(assertOperatingAcceptance(db, 'CHG-A-R1',
                at(13, '08:00:01')).operationallyValid, true);
            assert.equal(evaluateChangeEffectiveness(db, {
                changeId: 'CHG-A', expectedRevisionNo: 1,
                id: 'EFF-V5-AFTER-CLASS', actorId: 'ACT-Q1',
                at: at(13, '08:01:00'), serverNow: at(13, '08:01:00')
            }).status, 'Monitoring');
            assert.deepEqual({ ...db.prepare("SELECT * FROM acceptances WHERE id='ACCEPT-A'")
                .get() }, { ...original, acceptance_type: null,
                condition_text: null, expires_at: null });
            assert.deepEqual(db.prepare(`SELECT id,digest,payload_json FROM audit_events
                WHERE action='change-accepted'`).get(), originalAudit);
        } finally { db.close(); }
        for (let attempt = 0; attempt < 2; attempt++) {
            db = openDatabase(filename);
            try {
                assert.equal(db.prepare('SELECT COUNT(*) AS n FROM legacy_acceptance_classifications')
                    .get().n, 1);
                assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM audit_events
                    WHERE action='legacy-acceptance-classified'`).get().n, 1);
                assert.deepEqual(db.prepare(`SELECT id,digest,payload_json FROM audit_events
                    WHERE action='change-accepted'`).get(), originalAudit);
                assert.equal(reconcileConditionalAcceptances(db,
                    at(14, '08:00:00')).length, attempt === 0 ? 1 : 0);
                assert.equal(db.prepare('SELECT COUNT(*) AS n FROM conditional_acceptance_expiries')
                    .get().n, 1);
                assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM audit_events
                    WHERE action='conditional-acceptance-expired'`).get().n, 1);
            } finally { db.close(); }
        }
    } finally {
        const withinTemp = relative(resolve(tmpdir()), resolve(directory));
        assert.ok(withinTemp && !withinTemp.startsWith('..'));
        rmSync(directory, { recursive: true, force: true });
    }
});

test('local HTTP keeps migrated UNKNOWN history readable and requires an explicit Approver classification', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fabassure-accept-v5-http-'));
    const filename = join(directory, 'legacy.sqlite');
    const assetsDir = fileURLToPath(new URL('../assets/ui/', import.meta.url));
    let db;
    let server;
    try {
        let original;
        fixture({ filename }, tx => {
            readyAndReviewed(tx);
            acceptChange(tx, accept);
            original = tx.prepare("SELECT * FROM acceptances WHERE id='ACCEPT-A'").get();
        });
        makeHistoricalV5File(filename);
        db = openDatabase(filename);
        const historical = db.prepare(`SELECT id,digest,payload_json FROM audit_events
            WHERE action='change-accepted'`).get();
        let now = at(13, '08:00:00');
        server = createLocalServer(db, { assetsDir, clock: () => now });
        const listener = await listenLocal(server, 0);
        const detailUrl = `${listener.url}/api/changes/CHG-A`;
        const actionUrl = `${listener.url}/api/actions`;
        const post = (action, input) => fetch(actionUrl, {
            method: 'POST', headers: { 'content-type': 'application/json',
                'x-fabassure-local': '1' },
            body: JSON.stringify({ action, input })
        });
        const before = await (await fetch(detailUrl)).json();
        assert.equal(before.acceptances[0].status.type, 'UNKNOWN');
        assert.equal(before.acceptances[0].status.classificationRequired, true);
        assert.equal(before.acceptances[0].status.operationallyValid, false);
        assert.equal(before.audit.some(event => event.action === 'change-accepted'), true);
        const auditBefore = verifyAuditChain(db).count;
        const baseDecision = { id: 'CLASS-V5-HTTP', acceptanceId: 'ACCEPT-A',
            acceptanceType: 'Conditional', condition: 'Review later AOI',
            reason: 'Explicit review of the legacy record', at: now };
        const futureOrdinary = await post('classifyLegacyAcceptance', {
            ...baseDecision, acceptanceType: 'Ordinary', condition: undefined,
            actorId: 'ACT-APP', at: at(13, '08:00:01'),
            serverNow: at(13, '09:00:00')
        });
        assert.equal(futureOrdinary.status, 409);
        assert.equal(verifyAuditChain(db).count, auditBefore);
        const futureConditional = await post('classifyLegacyAcceptance', {
            ...baseDecision, actorId: 'ACT-APP', at: at(13, '08:00:01'),
            expiresAt: at(14, '08:00:00'), serverNow: at(13, '09:00:00')
        });
        assert.equal(futureConditional.status, 409);
        assert.equal(verifyAuditChain(db).count, auditBefore);
        assert.equal((await post('classifyLegacyAcceptance', {
            ...baseDecision, actorId: 'ACT-Q1', expiresAt: at(14, '08:00:00')
        })).status, 409);
        assert.equal((await post('classifyLegacyAcceptance', {
            ...baseDecision, actorId: 'ACT-APP'
        })).status, 409);
        assert.equal(verifyAuditChain(db).count, auditBefore);
        const classifiedResponse = await post('classifyLegacyAcceptance', {
            ...baseDecision, actorId: 'ACT-APP', expiresAt: at(14, '08:00:00')
        });
        assert.equal(classifiedResponse.status, 200);
        const classified = await (await fetch(detailUrl)).json();
        assert.equal(classified.acceptances[0].status.type, 'Conditional');
        assert.equal(classified.acceptances[0].status.expiresAt, at(14, '08:00:00'));
        assert.equal(classified.acceptances[0].status.operationallyValid, true);
        assert.equal(classified.audit.filter(event =>
            event.action === 'legacy-acceptance-classified').length, 1);
        assert.deepEqual(db.prepare(`SELECT id,digest,payload_json FROM audit_events
            WHERE action='change-accepted'`).get(), historical);
        assert.deepEqual({ ...db.prepare("SELECT * FROM acceptances WHERE id='ACCEPT-A'").get() },
            { ...original, acceptance_type: null, condition_text: null,
                expires_at: null });
        now = at(14, '08:00:00');
        const expired = await (await fetch(detailUrl)).json();
        assert.equal(expired.acceptances[0].status.expired, true);
        assert.equal(expired.change.state, 'Reopened');
        const auditAfter = verifyAuditChain(db).count;
        await fetch(detailUrl);
        assert.equal(verifyAuditChain(db).count, auditAfter);
        assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM audit_events
            WHERE action='conditional-acceptance-expired'`).get().n, 1);
    } finally {
        if (server?.listening) await new Promise(resolve => server.close(resolve));
        db?.close();
        const withinTemp = relative(resolve(tmpdir()), resolve(directory));
        assert.ok(withinTemp && !withinTemp.startsWith('..'));
        rmSync(directory, { recursive: true, force: true });
    }
});

test('invalid historical acceptance provenance rolls v5 migration back atomically', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fabassure-accept-v5-rollback-'));
    const filename = join(directory, 'legacy.sqlite');
    try {
        fixture({ filename }, db => {
            readyAndReviewed(db);
            acceptChange(db, accept);
        });
        makeHistoricalV5File(filename);
        const raw = new DatabaseSync(filename);
        try {
            const guard = raw.prepare(`SELECT sql FROM sqlite_master
                WHERE name='immutable_audit_delete'`).get().sql;
            raw.exec('DROP TRIGGER immutable_audit_delete');
            raw.prepare("DELETE FROM audit_events WHERE action='change-accepted'").run();
            raw.exec(guard);
        } finally { raw.close(); }
        assert.throws(() => openDatabase(filename), /acceptance audit provenance/i);
        const preserved = new DatabaseSync(filename);
        try {
            assert.equal(preserved.prepare('PRAGMA user_version').get().user_version, 5);
            assert.equal(preserved.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id='MIG-006'")
                .get().n, 0);
            assert.equal(preserved.prepare("SELECT COUNT(*) AS n FROM acceptances WHERE id='ACCEPT-A'")
                .get().n, 1);
            assert.equal(preserved.prepare(`SELECT COUNT(*) AS n FROM sqlite_master
                WHERE name='legacy_acceptance_classifications'`).get().n, 0);
        } finally { preserved.close(); }
    } finally {
        const withinTemp = relative(resolve(tmpdir()), resolve(directory));
        assert.ok(withinTemp && !withinTemp.startsWith('..'));
        rmSync(directory, { recursive: true, force: true });
    }
});

test('hash-valid historical audit with mismatched reviewed package cannot migrate', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fabassure-accept-v5-mismatch-'));
    const filename = join(directory, 'legacy.sqlite');
    try {
        fixture({ filename }, db => {
            readyAndReviewed(db);
            acceptChange(db, accept);
        });
        makeHistoricalV5File(filename, payload => { payload.reviewId = 'OTHER-REVIEW'; });
        assert.throws(() => openDatabase(filename), /acceptance audit package/i);
        const preserved = new DatabaseSync(filename);
        try {
            assert.equal(preserved.prepare('PRAGMA user_version').get().user_version, 5);
            assert.equal(preserved.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id='MIG-006'")
                .get().n, 0);
            assert.equal(preserved.prepare("SELECT review_id FROM acceptances WHERE id='ACCEPT-A'")
                .get().review_id, 'REVIEW-A');
        } finally { preserved.close(); }
    } finally {
        const withinTemp = relative(resolve(tmpdir()), resolve(directory));
        assert.ok(withinTemp && !withinTemp.startsWith('..'));
        rmSync(directory, { recursive: true, force: true });
    }
});

for (const field of ['linkedEvidenceIds', 'verifierActorIds']) {
    test(`hash-valid historical ${field} mismatch rolls migration back`, () => {
        const directory = mkdtempSync(join(tmpdir(), 'fabassure-accept-v5-set-'));
        const filename = join(directory, 'legacy.sqlite');
        try {
            fixture({ filename }, db => {
                readyAndReviewed(db);
                acceptChange(db, accept);
            });
            makeHistoricalV5File(filename, payload => { payload[field] = ['ACT-FAKE']; });
            assert.throws(() => openDatabase(filename), /audit evidence or verifier set/i);
            const preserved = new DatabaseSync(filename);
            try {
                assert.equal(preserved.prepare('PRAGMA user_version').get().user_version, 5);
                assert.equal(preserved.prepare(`SELECT COUNT(*) AS n FROM schema_migrations
                    WHERE id='MIG-006'`).get().n, 0);
            } finally { preserved.close(); }
        } finally {
            const withinTemp = relative(resolve(tmpdir()), resolve(directory));
            assert.ok(withinTemp && !withinTemp.startsWith('..'));
            rmSync(directory, { recursive: true, force: true });
        }
    });
}

test('injected HTTP server clock expires once at equality and stays idempotent after restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fabassure-accept-clock-'));
    const filename = join(directory, 'clock.sqlite');
    const assetsDir = fileURLToPath(new URL('../assets/ui/', import.meta.url));
    const due = at(13, '09:00:00');
    let db;
    let server;
    try {
        fixture({ filename }, tx => {
            readyAndReviewed(tx);
            acceptChange(tx, { ...accept, acceptanceType: 'Conditional',
                condition: 'Inspect AOI before closure', expiresAt: due,
                serverNow: at(12, '12:06:00') });
        });
        db = openDatabase(filename);
        let now = at(13, '08:59:59');
        server = createLocalServer(db, { assetsDir, clock: () => now });
        const listener = await listenLocal(server, 0);
        const before = await (await fetch(`${listener.url}/api/changes/CHG-A`)).json();
        assert.equal(before.acceptances[0].status.expired, false);
        assert.equal(before.change.state, 'Accepted');
        const body = JSON.stringify({ action: 'classifyLegacyAcceptance', input: {} });
        const split = Math.floor(body.length / 2);
        const status = await new Promise((resolve, reject) => {
            const request = httpRequest(`${listener.url}/api/actions`, {
                method: 'POST', headers: { 'content-type': 'application/json',
                    'x-fabassure-local': '1' }
            }, response => {
                response.resume();
                response.on('end', () => resolve(response.statusCode));
            });
            request.on('error', reject);
            request.write(body.slice(0, split));
            setTimeout(() => {
                now = due;
                request.end(body.slice(split));
            }, 60);
        });
        assert.equal(status, 409);
        const exact = await (await fetch(`${listener.url}/api/changes/CHG-A`)).json();
        assert.equal(exact.acceptances[0].status.expired, true);
        assert.equal(exact.change.state, 'Reopened');
        assert.equal(exact.audit.at(-1).action, 'conditional-acceptance-expired');
        assert.equal(exact.audit.at(-1).system_principal_id, 'SYS-SERVER-CLOCK');
        const auditCount = verifyAuditChain(db).count;
        const futureRevision = await fetch(`${listener.url}/api/actions`, {
            method: 'POST', headers: { 'content-type': 'application/json',
                'x-fabassure-local': '1' },
            body: JSON.stringify({ action: 'reviseExpiredChange', input: {
                changeId: 'CHG-A', expectedRevisionNo: 1, actorId: 'ACT-MFG',
                reason: 'Renew only after the server reaches the decision time',
                at: at(13, '09:00:01'), serverNow: at(14, '09:00:00')
            } })
        });
        assert.equal(futureRevision.status, 409);
        assert.equal(db.prepare("SELECT state FROM changes WHERE id='CHG-A'").get().state,
            'Reopened');
        assert.equal(verifyAuditChain(db).count, auditCount);
        await fetch(`${listener.url}/api/changes/CHG-A`);
        assert.equal(verifyAuditChain(db).count, auditCount);
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        server = null;
        db.close();
        db = openDatabase(filename);
        server = createLocalServer(db, { assetsDir, clock: () => at(13, '09:00:01') });
        const restarted = await listenLocal(server, 0);
        const later = await (await fetch(`${restarted.url}/api/changes/CHG-A`)).json();
        assert.equal(later.change.state, 'Reopened');
        assert.equal(verifyAuditChain(db).count, auditCount);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM conditional_acceptance_expiries')
            .get().n, 1);
    } finally {
        if (server?.listening) await new Promise(resolve => server.close(resolve));
        db?.close();
        const withinTemp = relative(resolve(tmpdir()), resolve(directory));
        assert.ok(withinTemp && !withinTemp.startsWith('..'));
        rmSync(directory, { recursive: true, force: true });
    }
});

test('HTTP overrides a client clock and refuses an already-expired conditional decision', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fabassure-accept-current-'));
    const filename = join(directory, 'current.sqlite');
    const assetsDir = fileURLToPath(new URL('../assets/ui/', import.meta.url));
    let db;
    let server;
    try {
        fixture({ filename }, tx => { readyAndReviewed(tx); });
        db = openDatabase(filename);
        const due = at(13, '09:00:00');
        server = createLocalServer(db, { assetsDir, clock: () => due });
        const listener = await listenLocal(server, 0);
        const futureOrdinary = await fetch(`${listener.url}/api/actions`, {
            method: 'POST', headers: { 'content-type': 'application/json',
                'x-fabassure-local': '1' },
            body: JSON.stringify({ action: 'acceptChange', input: {
                ...accept, at: at(13, '09:00:01'), serverNow: at(14, '09:00:00')
            } })
        });
        assert.equal(futureOrdinary.status, 409);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM acceptances').get().n, 0);
        const futureConditional = await fetch(`${listener.url}/api/actions`, {
            method: 'POST', headers: { 'content-type': 'application/json',
                'x-fabassure-local': '1' },
            body: JSON.stringify({ action: 'acceptChange', input: {
                ...accept, acceptanceType: 'Conditional', condition: 'Inspect AOI',
                expiresAt: at(14, '09:00:00'), at: at(13, '09:00:01'),
                serverNow: at(14, '09:00:00')
            } })
        });
        assert.equal(futureConditional.status, 409);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM acceptances').get().n, 0);
        const response = await fetch(`${listener.url}/api/actions`, {
            method: 'POST', headers: { 'content-type': 'application/json',
                'x-fabassure-local': '1' },
            body: JSON.stringify({ action: 'acceptChange', input: { ...accept,
                acceptanceType: 'Conditional', condition: 'Inspect AOI', expiresAt: due,
                serverNow: at(12, '12:06:00') } })
        });
        assert.equal(response.status, 409);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM acceptances').get().n, 0);
        assert.equal(db.prepare("SELECT state FROM changes WHERE id='CHG-A'").get().state,
            'Independent Review');
    } finally {
        if (server?.listening) await new Promise(resolve => server.close(resolve));
        db?.close();
        const withinTemp = relative(resolve(tmpdir()), resolve(directory));
        assert.ok(withinTemp && !withinTemp.startsWith('..'));
        rmSync(directory, { recursive: true, force: true });
    }
});

test('wrong role, stale revision, wrong review, early time and blank reason cannot accept', () => fixture({}, db => {
    readyAndReviewed(db);
    const before = verifyAuditChain(db).count;
    assert.throws(() => acceptChange(db, { ...accept, actorId: 'ACT-VER' }), /Approver|verifier/i);
    assert.throws(() => acceptChange(db, { ...accept, expectedRevisionNo: 2 }), /stale/i);
    assert.throws(() => acceptChange(db, { ...accept, reviewId: 'UNKNOWN' }), /review/i);
    assert.throws(() => acceptChange(db, { ...accept, at: at(12, '12:04:00') }), /time|review/i);
    assert.throws(() => acceptChange(db, { ...accept, reason: ' ' }), /reason/i);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM acceptances').get().n, 0);
    assert.equal(db.prepare("SELECT state FROM changes WHERE id='CHG-A'").get().state, 'Independent Review');
    assert.equal(verifyAuditChain(db).count, before);
}));

test('a fabricated passing review row without review audit cannot authorize acceptance', () => fixture({}, db => {
    const frozen = markEvidenceReady(db, ready);
    beginIndependentReview(db, begin);
    db.prepare(`
        INSERT INTO reviews(id,change_revision_id,plan_id,reviewer_actor_id,
            decision,reason,evidence_set_digest,reviewed_at) VALUES (?,?,?,?,?,?,?,?)
    `).run('REVIEW-A', 'CHG-A-R1', 'PLAN-A', 'ACT-REV', 'Pass',
        'Synthetic fabricated review row', frozen.packageDigest, at(12, '12:05:00'));
    assert.throws(() => db.prepare(`
        INSERT INTO acceptances(id,change_revision_id,plan_id,review_id,
            approver_actor_id,accepted_at,frozen_digest,acceptance_type) VALUES (?,?,?,?,?,?,?,'Ordinary')
    `).run('DIRECT-ACCEPT', 'CHG-A-R1', 'PLAN-A', 'REVIEW-A', 'ACT-APP',
        at(12, '12:06:00'), frozen.packageDigest), /audit/i);
    assert.throws(() => acceptChange(db, accept), /review audit|provenance|decision/i);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM acceptances').get().n, 0);
}));

test('direct SQL acceptance cannot substitute a different digest for an audited Pass review', () => fixture({}, db => {
    readyAndReviewed(db);
    assert.throws(() => db.prepare(`
        INSERT INTO acceptances(id,change_revision_id,plan_id,review_id,
            approver_actor_id,accepted_at,frozen_digest,acceptance_type) VALUES (?,?,?,?,?,?,?,'Ordinary')
    `).run('DIRECT-DIGEST', 'CHG-A-R1', 'PLAN-A', 'REVIEW-A', 'ACT-APP',
        at(12, '12:06:00'), 'f'.repeat(64)), /digest/i);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM acceptances').get().n, 0);
}));

test('direct SQL acceptance enforces distinct Approver identity and later decision time', () => fixture({}, db => {
    const frozen = readyAndReviewed(db);
    const insert = db.prepare(`
        INSERT INTO acceptances(id,change_revision_id,plan_id,review_id,
            approver_actor_id,accepted_at,frozen_digest,acceptance_type) VALUES (?,?,?,?,?,?,?,'Ordinary')
    `);
    const args = actorId => ['DIRECT-ROLE', 'CHG-A-R1', 'PLAN-A', 'REVIEW-A',
        actorId, at(12, '12:06:00'), frozen.packageDigest];
    assert.throws(() => insert.run(...args('ACT-REV')), /approver|role|separation/i);
    assert.throws(() => insert.run(...args('ACT-MFG')), /approver|role|separation/i);
    assert.throws(() => insert.run(...args('ACT-VER')), /approver|role|separation/i);
    assert.throws(() => insert.run('DIRECT-EARLY', 'CHG-A-R1', 'PLAN-A', 'REVIEW-A',
        'ACT-APP', at(12, '12:04:00'), frozen.packageDigest), /time|review/i);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM acceptances').get().n, 0);
}));

test('late source-linked evidence invalidates the reviewed digest before acceptance', () => fixture({}, db => {
    readyAndReviewed(db);
    const original = db.prepare("SELECT * FROM evidence_items WHERE id='EVID-008-01'").get();
    withValidatedTransaction(db, tx => {
        tx.prepare(`
            INSERT INTO evidence_items(id,change_revision_id,source_table,source_id,evidence_type,
                payload_json,sha256,recorded_by,recorded_at) VALUES (?,?,?,?,?,?,?,?,?)
        `).run('EVID-LATE', original.change_revision_id, original.source_table,
            original.source_id, original.evidence_type, original.payload_json,
            original.sha256, 'ACT-VER', at(12, '12:05:30'));
        appendAuditEvent(tx, {
            actorId: 'ACT-VER', recordedAt: at(12, '12:05:30'), entityType: 'change',
            entityId: 'CHG-A', entityRevisionId: 'CHG-A-R1',
            action: 'measurement-evidence-added', linkedEvidenceIds: ['EVID-LATE'],
            payload: { evidenceId: 'EVID-LATE', measurementId: original.source_id,
                lotId: 'LOT-A-008', sha256: original.sha256 }
        });
    });
    assert.throws(() => acceptChange(db, accept), /frozen|digest|changed/i);
    assert.equal(db.prepare("SELECT state FROM changes WHERE id='CHG-A'").get().state, 'Independent Review');
}));
