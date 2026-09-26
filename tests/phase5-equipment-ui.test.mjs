import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { openDatabase } from '../src/data/db.mjs';
import { seedDatabase } from '../src/data/seed.mjs';
import { createChange } from '../src/domain/change-service.mjs';
import { createIncident } from '../src/domain/incident-service.mjs';
import { createLocalServer, listenLocal } from '../src/server/http.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const assetsDir = join(root, 'assets', 'ui');

async function loaded(view, marker) {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (view.innerHTML.includes(marker)) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail(`UI did not render ${marker}`);
}

test('Equipment navigation renders source-linked timeline and tool-specific denominator', async () => {
    const db = openDatabase(':memory:');
    let server;
    try {
        seedDatabase(db, { instanceId: 'DATASET-EQUIPMENT-UI' });
        createChange(db, { id: 'CHG-UI-RACE', title: 'Synthetic navigation race check',
            actorId: 'ACT-MFG', lineId: 'LINE-A', equipmentId: 'EQ-ALIGN-A',
            moduleId: 'MOD-ALIGN-A', recipeRevisionId: 'REC-ALIGN-R2',
            baselineRef: 'AOI-A-001', reason: 'Exercise a pending local detail request',
            at: '2026-08-05T12:00:00.000Z' });
        createIncident(db, { id: 'INC-UI-RACE', title: 'Synthetic incident navigation check',
            actorId: 'ACT-Q1', defectCodeId: 'DEF-FIDUCIAL',
            detectionEventId: 'EV-DETECTION', observedLotId: 'LOT-A-026',
            recipeRevisionId: 'REC-ALIGN-R3', detectedAt: '2026-08-27T10:00:00.000Z',
            at: '2026-08-27T10:02:00.000Z' });
        createIncident(db, { id: 'INC-UI-RACE-B', title: 'Second synthetic incident detail',
            actorId: 'ACT-Q1', defectCodeId: 'DEF-FIDUCIAL',
            detectionEventId: 'EV-DETECTION', observedLotId: 'LOT-A-026',
            recipeRevisionId: 'REC-ALIGN-R3', detectedAt: '2026-08-27T10:00:00.000Z',
            at: '2026-08-27T10:03:00.000Z' });
        server = createLocalServer(db, { assetsDir });
        const local = await listenLocal(server, 0);
        const handlers = new Map();
        const view = { innerHTML: '', focus() {} };
        const actorSelect = { innerHTML: '', value: '', selectedOptions: [],
            addEventListener: (name, handler) => handlers.set(`actor-${name}`, handler) };
        const shellNode = () => ({ textContent: '', className: '', hidden: true, attributes: {},
            setAttribute(name, value) { this.attributes[name] = String(value); },
            addEventListener() {} });
        const elements = { view, 'actor-select': actorSelect,
            crumb: { textContent: '' }, toast: shellNode(), 'toast-message': shellNode(),
            'toast-close': shellNode(), 'live-region': shellNode(),
            actorName: shellNode(), actorRole: shellNode(),
            'incident-gate-reason': { value: 'Synthetic containment rationale' } };
        const shellSelectors = { '[data-actor-name]': 'actorName', '[data-actor-role]': 'actorRole' };
        const document = {
            getElementById: id => elements[id] ?? null,
            querySelector: selector => elements[shellSelectors[selector]] ?? null,
            querySelectorAll: () => [],
            addEventListener: (name, handler) => handlers.set(name, handler)
        };
        let heldPath = null;
        let releaseHeld = null;
        let rejectHeld = false;
        const localFetch = (path, options) => {
            if (path === heldPath) {
                heldPath = null;
                return new Promise((resolve, reject) => {
                    releaseHeld = () => rejectHeld ? reject(new Error('Synthetic delayed request failure')) :
                        resolve(fetch(new URL(path, local.url), options));
                });
            }
            return fetch(new URL(path, local.url), options);
        };
        class FormFields {
            constructor(target) { this.fields = target.fields; }
            get(name) { return this.fields[name] ?? null; }
        }
        const context = {
            document, fetch: localFetch, setTimeout, clearTimeout, crypto: globalThis.crypto,
            console, FormData: FormFields
        };
        runInNewContext(readFileSync(join(assetsDir, 'app.js'), 'utf8'), context);
        await loaded(view, '변경 관리 시작');
        const click = handlers.get('click');
        assert.equal(typeof click, 'function');
        // Ordinary synthetic buttons carry no attributes, matching a real button without aria-disabled.
        const press = async dataset => click({ target: { closest: () => ({ dataset,
            getAttribute: () => null }) } });
        await press({ view: 'equipment' });
        await loaded(view, 'EV-VISION-2');
        assert.match(view.innerHTML, /MA-VISION-2/);
        assert.match(view.innerHTML, /AOI-A-026/);
        assert.match(view.innerHTML, /DEF-FIDUCIAL/);
        assert.match(view.innerHTML, /AOIDEF-A-026-1/);
        assert.match(view.innerHTML, /478\.5/);
        assert.match(view.innerHTML, /960/);
        assert.match(view.innerHTML, /RUN-A-040/);
        assert.doesNotMatch(view.innerHTML, /timeline and maintenance decision screen are planned/i);
        await press({ openEquipment: 'EQ-ALIGN-B' });
        await loaded(view, 'EV-B-MODULE');
        assert.doesNotMatch(view.innerHTML, /EV-VISION-2/);
        assert.match(view.innerHTML, /고장 기록이 없어 MTBF와 MTTR을 계산하지 않습니다/);
        heldPath = '/api/equipment/EQ-ALIGN-A';
        const delayedA = press({ openEquipment: 'EQ-ALIGN-A' });
        for (let attempt = 0; !releaseHeld && attempt < 100; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(typeof releaseHeld, 'function');
        await press({ openEquipment: 'EQ-ALIGN-B' });
        releaseHeld();
        await delayedA;
        assert.match(view.innerHTML, /EV-B-MODULE/);
        assert.doesNotMatch(view.innerHTML, /EV-VISION-2/);
        db.prepare(`INSERT INTO equipment_events(id,equipment_id,module_id,event_type,occurred_at,duration_seconds)
            VALUES ('EV-REFRESH','EQ-ALIGN-B','MOD-ALIGN-B-R2','inspection-check',
            '2026-08-06T00:00:00.000Z',0)`).run();
        await context.reload();
        assert.match(view.innerHTML, /EV-REFRESH/);
        heldPath = '/api/equipment/EQ-ALIGN-A';
        releaseHeld = null;
        const pendingEquipment = press({ openEquipment: 'EQ-ALIGN-A' });
        for (let attempt = 0; !releaseHeld && attempt < 100; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(typeof releaseHeld, 'function');
        await press({ openChange: 'CHG-UI-RACE' });
        assert.match(view.innerHTML, /변경 상세/);
        releaseHeld();
        await pendingEquipment;
        assert.match(view.innerHTML, /변경 상세/);
        assert.doesNotMatch(view.innerHTML, /EV-VISION-2/);
        heldPath = '/api/equipment/EQ-ALIGN-B';
        releaseHeld = null;
        const pendingForIncident = press({ openEquipment: 'EQ-ALIGN-B' });
        for (let attempt = 0; !releaseHeld && attempt < 100; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(typeof releaseHeld, 'function');
        await press({ openIncident: 'INC-UI-RACE' });
        assert.match(view.innerHTML, /영향 추적 상세/);
        releaseHeld();
        await pendingForIncident;
        assert.match(view.innerHTML, /영향 추적 상세/);
        heldPath = '/api/incidents/INC-UI-RACE';
        releaseHeld = null;
        const pendingIncidentA = press({ openIncident: 'INC-UI-RACE' });
        for (let attempt = 0; !releaseHeld && attempt < 100; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(typeof releaseHeld, 'function');
        await press({ openIncident: 'INC-UI-RACE-B' });
        assert.match(view.innerHTML, /Second synthetic incident detail/);
        releaseHeld();
        await pendingIncidentA;
        assert.match(view.innerHTML, /Second synthetic incident detail/);
        heldPath = '/api/incidents/INC-UI-RACE';
        releaseHeld = null;
        const pendingIncidentToEquipment = press({ openIncident: 'INC-UI-RACE' });
        for (let attempt = 0; !releaseHeld && attempt < 100; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(typeof releaseHeld, 'function');
        await press({ openEquipment: 'EQ-ALIGN-B' });
        releaseHeld();
        await pendingIncidentToEquipment;
        assert.match(view.innerHTML, /EV-B-MODULE/);
        assert.doesNotMatch(view.innerHTML, /Second synthetic incident detail/);
        heldPath = '/api/bootstrap';
        releaseHeld = null;
        const bootstrapReload = context.reload();
        for (let attempt = 0; !releaseHeld && attempt < 100; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(typeof releaseHeld, 'function');
        await press({ openEquipment: 'EQ-ALIGN-A' });
        releaseHeld();
        await bootstrapReload;
        assert.match(view.innerHTML, /EV-VISION-2/);
        await press({ openEquipment: 'EQ-ALIGN-B' });
        heldPath = '/api/equipment/EQ-ALIGN-B';
        releaseHeld = null;
        const equipmentReload = context.reload();
        for (let attempt = 0; !releaseHeld && attempt < 100; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(typeof releaseHeld, 'function');
        await press({ openEquipment: 'EQ-ALIGN-A' });
        releaseHeld();
        await equipmentReload;
        assert.match(view.innerHTML, /EV-VISION-2/);
        assert.doesNotMatch(view.innerHTML, /EV-B-MODULE/);
        await press({ openChange: 'CHG-UI-RACE' });
        heldPath = '/api/changes/CHG-UI-RACE';
        releaseHeld = null;
        const changeReload = context.reload();
        for (let attempt = 0; !releaseHeld && attempt < 100; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(typeof releaseHeld, 'function');
        await press({ openEquipment: 'EQ-ALIGN-B' });
        releaseHeld();
        await changeReload;
        assert.match(view.innerHTML, /EV-B-MODULE/);

        await press({ openChange: 'CHG-UI-RACE' });
        heldPath = '/api/actions';
        releaseHeld = null;
        const pendingGate = press({ action: 'next-gate' });
        for (let attempt = 0; !releaseHeld && attempt < 100; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(typeof releaseHeld, 'function');
        await press({ openEquipment: 'EQ-ALIGN-B' });
        releaseHeld();
        await pendingGate;
        assert.match(view.innerHTML, /EV-B-MODULE/);
        assert.doesNotMatch(view.innerHTML, /변경 상세/);
        assert.doesNotMatch(elements['toast-message'].textContent, /Submit change recorded/);
        assert.equal(db.prepare("SELECT state FROM changes WHERE id='CHG-UI-RACE'").get().state, 'Submitted');
        await press({ view: 'changes' });
        assert.match(view.innerHTML, /CHG-UI-RACE/);
        assert.match(view.innerHTML, /Submitted/);

        const submit = handlers.get('submit');
        assert.equal(typeof submit, 'function');
        const changeCount = db.prepare('SELECT count(*) AS n FROM changes').get().n;
        heldPath = '/api/actions';
        releaseHeld = null;
        const pendingChangeCreation = submit({ target: { id: 'create-change-form',
            fields: { title: 'Synthetic delayed change', recipe: 'REC-ALIGN-R2',
                reason: 'Check navigation after a local write' } }, preventDefault() {} });
        for (let attempt = 0; !releaseHeld && attempt < 100; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(typeof releaseHeld, 'function');
        await press({ openEquipment: 'EQ-ALIGN-B' });
        releaseHeld();
        await pendingChangeCreation;
        assert.match(view.innerHTML, /EV-B-MODULE/);
        assert.doesNotMatch(elements['toast-message'].textContent, /Synthetic draft .* created/);
        assert.equal(db.prepare('SELECT count(*) AS n FROM changes').get().n, changeCount + 1);
        await press({ view: 'changes' });
        assert.match(view.innerHTML, /Synthetic delayed change/);
        await press({ view: 'fabtrace' });
        actorSelect.value = 'ACT-Q1';
        actorSelect.selectedOptions = [{ textContent: 'Quality Engineer' }];
        handlers.get('actor-change')();
        const incidentCount = db.prepare('SELECT count(*) AS n FROM incidents').get().n;
        heldPath = '/api/actions';
        releaseHeld = null;
        const pendingIncidentCreation = submit({ target: { id: 'create-incident-form',
            fields: { title: 'Synthetic delayed incident' } }, preventDefault() {} });
        for (let attempt = 0; !releaseHeld && attempt < 100; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(typeof releaseHeld, 'function');
        await press({ openEquipment: 'EQ-ALIGN-B' });
        releaseHeld();
        await pendingIncidentCreation;
        assert.match(view.innerHTML, /EV-B-MODULE/);
        assert.equal(db.prepare('SELECT count(*) AS n FROM incidents').get().n, incidentCount + 1);
        await press({ view: 'fabtrace' });
        assert.match(view.innerHTML, /Synthetic delayed incident/);
        await press({ openIncident: 'INC-UI-RACE' });
        heldPath = '/api/actions';
        releaseHeld = null;
        const pendingIncidentGate = press({ action: 'incident-gate' });
        for (let attempt = 0; !releaseHeld && attempt < 100; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(typeof releaseHeld, 'function');
        await press({ openEquipment: 'EQ-ALIGN-B' });
        releaseHeld();
        await pendingIncidentGate;
        assert.match(view.innerHTML, /EV-B-MODULE/);
        assert.equal(db.prepare("SELECT state FROM incidents WHERE id='INC-UI-RACE'").get().state, 'Contained');

        await press({ openIncident: 'INC-UI-RACE-B' });
        heldPath = '/api/incidents/INC-UI-RACE-B';
        releaseHeld = null;
        const incidentReload = context.reload();
        for (let attempt = 0; !releaseHeld && attempt < 100; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(typeof releaseHeld, 'function');
        await press({ openEquipment: 'EQ-ALIGN-B' });
        releaseHeld();
        await incidentReload;
        assert.match(view.innerHTML, /EV-B-MODULE/);

        await press({ openChange: 'CHG-UI-RACE' });
        heldPath = '/api/actions';
        releaseHeld = null;
        rejectHeld = true;
        const pendingFailedGate = press({ action: 'next-gate' });
        for (let attempt = 0; !releaseHeld && attempt < 100; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(typeof releaseHeld, 'function');
        await press({ openEquipment: 'EQ-ALIGN-B' });
        releaseHeld();
        await pendingFailedGate;
        rejectHeld = false;
        assert.match(view.innerHTML, /EV-B-MODULE/);
        assert.doesNotMatch(elements['toast-message'].textContent, /Synthetic delayed request failure/);
    } finally {
        if (server?.listening) await new Promise(resolve => server.close(resolve));
        db.close();
    }
});
