import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { openDatabase } from '../src/data/db.mjs';
import { seedDatabase } from '../src/data/seed.mjs';
import { createChange, submitChange } from '../src/domain/change-service.mjs';
import { classifyRisk } from '../src/domain/risk.mjs';
import { createLocalServer, listenLocal } from '../src/server/http.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('rendered ID patterns compile under the browser v flag', () => {
    const source = readFileSync(join(root, 'assets', 'ui', 'app.js'), 'utf8');
    const patterns = [...source.matchAll(/pattern="([^"]+)"/g)]
        .map(match => match[1].replace(/\\\\/g, '\\'));
    assert.ok(patterns.length >= 7, 'expected Change and Incident ID inputs');
    for (const pattern of patterns) {
        let whole;
        assert.doesNotThrow(() => {
            whole = new RegExp(`^(?:${pattern})$`, 'v');
        },
            `invalid HTML pattern: ${pattern}`);
        assert.equal(whole.test('AOI-B-003'), true, pattern);
        for (const invalid of ['AB', 'aBC', 'A B', 'A_1']) {
            assert.equal(whole.test(invalid), false, `${pattern}: ${invalid}`);
        }
    }
});

function renderChangeDetailFixture(detail, bootstrap, localUrl,
    expression = 'renderChangeDetail()') {
    const view = { innerHTML: '', focus() {} };
    const shellNode = () => ({ textContent: '', className: '', hidden: true,
        setAttribute() {}, addEventListener() {} });
    const elements = { view, 'actor-select': { innerHTML: '', value: '',
        addEventListener() {} }, crumb: { textContent: '' },
    toast: shellNode(), 'toast-message': shellNode(),
    'toast-close': shellNode(), 'live-region': shellNode(),
    actorName: shellNode(), actorRole: shellNode() };
    const shellSelectors = { '[data-actor-name]': 'actorName',
        '[data-actor-role]': 'actorRole' };
    const document = {
        getElementById: id => elements[id] ?? null,
        querySelector: selector => elements[shellSelectors[selector]] ?? null,
        querySelectorAll: () => [], addEventListener() {}
    };
    const context = { document,
        fetch: (path, options) => fetch(new URL(path, localUrl), options),
        setTimeout, clearTimeout, crypto: globalThis.crypto, console,
        FormData };
    runInNewContext(readFileSync(join(root, 'assets', 'ui', 'app.js'), 'utf8'),
        context);
    context.__detail = detail;
    context.__bootstrap = bootstrap;
    return runInNewContext(`state.bootstrap = __bootstrap;
        state.detail = __detail;
        state.actorId = 'ACT-Q1'; ${expression}`, context);
}

test('Line B L1 walkthrough offers the seeded module contrast and L1 risk path', async () => {
    const db = openDatabase(':memory:');
    let server;
    try {
        seedDatabase(db, { instanceId: 'DATASET-CHANGE-UI-L1' });
        createChange(db, { id: 'CHG-UI-L1', title: 'Synthetic L1 module contrast',
            actorId: 'ACT-MFG', lineId: 'LINE-B', equipmentId: 'EQ-ALIGN-B',
            moduleId: 'MOD-ALIGN-B-R2', recipeRevisionId: 'REC-B-R2',
            baselineRef: 'AOI-B-002', reason: 'Guide seeded L1 module source',
            at: '2026-08-04T13:00:00.000Z' });
        server = createLocalServer(db, { assetsDir: join(root, 'assets', 'ui') });
        const local = await listenLocal(server, 0);
        const bootstrap = await fetch(new URL('/api/bootstrap', local.url))
            .then(response => response.json());
        let detail = await fetch(new URL('/api/changes/CHG-UI-L1', local.url))
            .then(response => response.json());
        const html = renderChangeDetailFixture(detail, bootstrap, local.url,
            'renderChanges()');
        assert.match(html, /REC-B-R2/);
        assert.match(html, /AOI-B-002/);
        submitChange(db, { changeId: 'CHG-UI-L1', expectedRevisionNo: 1,
            actorId: 'ACT-MFG', at: '2026-08-04T13:10:00.000Z' });
        detail = await fetch(new URL('/api/changes/CHG-UI-L1', local.url))
            .then(response => response.json());
        const action = renderChangeDetailFixture(detail, bootstrap, local.url,
            'actionFor(__detail)');
        assert.equal(action.action, 'classifyChange');
        assert.equal(classifyRisk(action.input.riskInputs).computedLevel, 'L1');
    } finally {
        if (server?.listening) await new Promise(resolve => server.close(resolve));
        db.close();
    }
});

test('failed-effectiveness R2 uses a valid decision clock and exposes its source step', async () => {
    const db = openDatabase(':memory:');
    let server;
    try {
        seedDatabase(db, { instanceId: 'DATASET-CHANGE-UI-R2' });
        createChange(db, { id: 'CHG-UI-L1-R2', title: 'Synthetic L1 revision',
            actorId: 'ACT-MFG', lineId: 'LINE-B', equipmentId: 'EQ-ALIGN-B',
            moduleId: 'MOD-ALIGN-B-R2', recipeRevisionId: 'REC-B-R2',
            baselineRef: 'AOI-B-002', reason: 'Show controlled R2 source need',
            at: '2026-08-04T13:00:00.000Z' });
        server = createLocalServer(db, { assetsDir: join(root, 'assets', 'ui') });
        const local = await listenLocal(server, 0);
        const bootstrap = await fetch(new URL('/api/bootstrap', local.url))
            .then(response => response.json());
        const detail = await fetch(new URL('/api/changes/CHG-UI-L1-R2', local.url))
            .then(response => response.json());
        const now = '2026-09-25T13:10:00.000Z';
        detail.serverNowUtc = now;
        detail.change.current_revision_no = 2;
        detail.change.state = 'Draft';
        detail.change.updated_at = now;
        detail.revisions.push({ ...detail.revisions[0],
            revision: { ...detail.revisions[0].revision,
                id: 'CHG-UI-L1-R2-R2', revision_no: 2, created_at: now },
            evidence: [], results: [], reviews: [], acceptances: [] });
        const submit = renderChangeDetailFixture(detail, bootstrap, local.url,
            'actionFor(__detail)');
        assert.equal(submit.action, 'submitChange');
        assert.ok(submit.input.at >= detail.change.updated_at);
        assert.ok(submit.input.at <= detail.serverNowUtc);
        detail.change.state = 'Verification In Progress';
        detail.revisions.at(-1).evidence.push({ id: 'EVID-R2-BASE',
            evidence_type: 'baseline-set', recorded_by: 'ACT-VER' });
        const next = renderChangeDetailFixture(detail, bootstrap, local.url,
            'actionFor(__detail)');
        assert.equal(next.action, 'awaitPostRevisionSource');
        assert.match(next.blocked, /개정 후 근거가 필요합니다/);
        assert.match(next.description, /완전한 AOI 검사/);
        const eligible = renderChangeDetailFixture(detail, bootstrap, local.url,
            "state.actorId = 'ACT-VER'; actorEligible(actionFor(__detail), __detail)");
        assert.equal(eligible, false);
    } finally {
        if (server?.listening) await new Promise(resolve => server.close(resolve));
        db.close();
    }
});

test('UNKNOWN legacy Acceptance renders classification-required history without guessing its type', async () => {
    const db = openDatabase(':memory:');
    let server;
    try {
        seedDatabase(db, { instanceId: 'DATASET-CHANGE-UI-UNKNOWN' });
        createChange(db, {
            id: 'CHG-UI-UNKNOWN', title: 'Synthetic legacy classification card',
            actorId: 'ACT-MFG', lineId: 'LINE-B', equipmentId: 'EQ-ALIGN-B',
            moduleId: 'MOD-ALIGN-B-R2', recipeRevisionId: 'REC-B-R2',
            baselineRef: 'AOI-B-002', reason: 'Show the undetermined legacy type',
            at: '2026-08-04T13:00:00.000Z'
        });
        server = createLocalServer(db, { assetsDir: join(root, 'assets', 'ui') });
        const local = await listenLocal(server, 0);
        const detail = await fetch(new URL('/api/changes/CHG-UI-UNKNOWN', local.url))
            .then(response => response.json());
        const bootstrap = await fetch(new URL('/api/bootstrap', local.url))
            .then(response => response.json());
        detail.revisions[0].acceptances = [{ id: 'ACCEPT-UI-UNKNOWN',
            approver_actor_id: 'ACT-APP', accepted_at: '2026-08-05T12:06:00.000Z',
            status: { type: 'UNKNOWN', classificationRequired: true,
                operationallyValid: false, expired: false } }];
        const html = renderChangeDetailFixture(detail, bootstrap, local.url);
        assert.match(html, /분류 확인 필요/);
        assert.match(html, /운영 승인에 사용할 수 없습니다/);
        assert.match(html, /원본과 감사 이력은 조회할 수 있습니다/);
        assert.doesNotMatch(html, /일반 수락|조건부 수락|만료됨/);
    } finally {
        if (server?.listening) await new Promise(resolve => server.close(resolve));
        db.close();
    }
});

test('Change detail shows a source-linked monitoring detail fixture and evaluation path', async () => {
    const db = openDatabase(':memory:');
    let server;
    try {
        seedDatabase(db, { instanceId: 'DATASET-CHANGE-UI-RED' });
        createChange(db, {
            id: 'CHG-UI-MONITOR', title: 'Synthetic Change monitoring card',
            actorId: 'ACT-MFG', lineId: 'LINE-B', equipmentId: 'EQ-ALIGN-B',
            moduleId: 'MOD-ALIGN-B-R2', recipeRevisionId: 'REC-B-R2',
            baselineRef: 'AOI-B-002', reason: 'Render source-linked history',
            at: '2026-08-04T13:00:00.000Z'
        });
        server = createLocalServer(db, { assetsDir: join(root, 'assets', 'ui') });
        const local = await listenLocal(server, 0);
        const detail = await fetch(new URL('/api/changes/CHG-UI-MONITOR', local.url))
            .then(response => response.json());
        const bootstrap = await fetch(new URL('/api/bootstrap', local.url))
            .then(response => response.json());
        detail.change.state = 'Effectiveness Monitoring';
        detail.change.updated_at = '2026-08-06T12:30:00.000Z';
        detail.revisions[0].acceptances = [{ id: 'ACCEPT-UI-MONITOR',
            approver_actor_id: 'ACT-APP', accepted_at: '2026-08-05T12:06:00.000Z',
            status: { type: 'Ordinary', expired: false } }];
        detail.revisions[0].effectivenessChecks = [{ id: 'EFF-UI-MONITOR',
            change_revision_id: 'CHG-UI-MONITOR-R1',
            window_start: '2026-08-05T12:06:00.000Z',
            window_end: '2026-08-06T12:30:00.000Z', lot_count: 1, passed: 0,
            reason: 'Insufficient subsequent lots', recorded_by: 'ACT-Q1',
            recorded_at: '2026-08-06T12:30:00.000Z' }];
        detail.audit.push({ id: 'AUD-UI-MONITOR',
            action: 'change-effectiveness-evaluated',
            actor_id: 'ACT-Q1', simulated_role: 'Quality Engineer',
            entity_revision_id: 'CHG-UI-MONITOR-R1',
            recorded_at: '2026-08-06T12:30:00.000Z',
            prior_state: 'Accepted', new_state: 'Effectiveness Monitoring',
            reason: 'Insufficient subsequent lots',
            payload: { checkId: 'EFF-UI-MONITOR', status: 'Monitoring',
                sourceLotIds: ['LOT-B-004'], sourceRunIds: ['RUN-B-004'],
                aoiInspectionIds: ['AOI-B-004'],
                sourceDigest: 'a'.repeat(64), requiredLots: 2, lotCount: 1,
                reasons: ['Insufficient subsequent lots'] },
            digest: 'b'.repeat(64), previous_digest: 'c'.repeat(64) });
        const html = renderChangeDetailFixture(detail, bootstrap, local.url);
        assert.match(html, /EFF-UI-MONITOR/);
        assert.match(html, /RUN-B-004/);
        assert.match(html, /AOI-B-004/);
        assert.match(html, /효과성 평가|Evaluate effectiveness/i);
    } finally {
        if (server?.listening) await new Promise(resolve => server.close(resolve));
        db.close();
    }
});
