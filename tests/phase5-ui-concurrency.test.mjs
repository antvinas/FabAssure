import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { openDatabase } from '../src/data/db.mjs';
import { seedDatabase } from '../src/data/seed.mjs';
import { createChange } from '../src/domain/change-service.mjs';
import { createLocalServer, listenLocal } from '../src/server/http.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

async function exerciseUi(run, { holdStartup = false } = {}) {
    const db = openDatabase(':memory:');
    let server;
    try {
        seedDatabase(db, { instanceId: 'DATASET-UI-CONCURRENCY' });
        createChange(db, { id: 'CHG-UI-CONCURRENCY', title: 'Synthetic concurrency source',
            actorId: 'ACT-MFG', lineId: 'LINE-A', equipmentId: 'EQ-ALIGN-A',
            moduleId: 'MOD-ALIGN-A', recipeRevisionId: 'REC-ALIGN-R2',
            baselineRef: 'AOI-A-001', reason: 'Exercise local UI request ordering',
            at: '2026-08-05T12:00:00.000Z' });
        server = createLocalServer(db, { assetsDir: join(root, 'assets', 'ui') });
        const local = await listenLocal(server, 0);
        const handlers = new Map();
        const view = { innerHTML: 'Loading local demo', focus() {} };
        const shellNode = () => ({ textContent: '', className: '', hidden: true, attributes: {},
            setAttribute(name, value) { this.attributes[name] = String(value); },
            addEventListener() {} });
        const toast = shellNode();
        const toastMessage = shellNode();
        const actorSelect = { innerHTML: '', value: '', addEventListener() {} };
        const elements = { view, toast, 'toast-message': toastMessage, 'actor-select': actorSelect,
            crumb: { textContent: '' }, 'toast-close': shellNode(), 'live-region': shellNode(),
            actorName: shellNode(), actorRole: shellNode() };
        const shellSelectors = { '[data-actor-name]': 'actorName', '[data-actor-role]': 'actorRole' };
        const document = {
            getElementById: id => elements[id] ?? null,
            querySelector: selector => elements[shellSelectors[selector]] ?? null,
            querySelectorAll: () => [],
            addEventListener: (name, handler) => handlers.set(name, handler)
        };
        let heldPath = holdStartup ? '/api/bootstrap' : null;
        let releaseHeld = null;
        let actionCount = 0;
        async function localResponse(path, options) {
            if (path === '/api/actions') {
                actionCount++;
                return Response.json({ result: { state: 'Recorded' } });
            }
            const response = await fetch(new URL(path, local.url), options);
            if (path !== '/api/bootstrap' || actionCount === 0) return response;
            const body = await response.json();
            body.changes.push({ ...body.changes[0], id: 'CHG-POSTED',
                title: 'Synthetic committed source set' });
            return Response.json(body);
        }
        function localFetch(path, options) {
            if (path === heldPath) {
                heldPath = null;
                return new Promise((resolve, reject) => {
                    releaseHeld = error => error ? reject(error) :
                        resolve(localResponse(path, options));
                });
            }
            return localResponse(path, options);
        }
        const context = { document, fetch: localFetch, setTimeout, clearTimeout,
            crypto: globalThis.crypto, console, FormData };
        const ui = {
            context, view, toast, toastMessage,
            get actionCount() { return actionCount; },
            start() { runInNewContext(readFileSync(join(root, 'assets', 'ui', 'app.js'), 'utf8'), context); },
            evaluate(expression) { return runInNewContext(expression, context); },
            setHold(path) { heldPath = path; releaseHeld = null; },
            async waitHeld() {
                for (let attempt = 0; !releaseHeld && attempt < 100; attempt++) {
                    await new Promise(resolve => setTimeout(resolve, 10));
                }
                assert.equal(typeof releaseHeld, 'function');
            },
            release(error = null) {
                const pending = releaseHeld;
                releaseHeld = null;
                assert.equal(typeof pending, 'function');
                pending(error);
            },
            async loaded(marker) {
                for (let attempt = 0; !view.innerHTML.includes(marker) && attempt < 100; attempt++) {
                    await new Promise(resolve => setTimeout(resolve, 10));
                }
                assert.match(view.innerHTML, new RegExp(marker));
            },
            press(dataset) {
                const click = handlers.get('click');
                assert.equal(typeof click, 'function');
                // Ordinary synthetic buttons carry no attributes, matching a real button without aria-disabled.
                return click({ target: { closest: () => ({ dataset,
                    getAttribute: () => null }) } });
            }
        };
        await run(ui);
    } finally {
        if (server?.listening) await new Promise(resolve => server.close(resolve));
        db.close();
    }
}

test('navigation during initial bootstrap still settles on the selected register', async () => {
    await exerciseUi(async ui => {
        ui.start();
        await ui.waitHeld();
        const selected = ui.press({ view: 'changes' });
        ui.release();
        await selected;
        await ui.loaded('변경 등록');
        assert.doesNotMatch(ui.view.innerHTML, /Loading local demo/);
    }, { holdStartup: true });
});

test('failed startup after navigation leaves a visible local error instead of loading forever', async () => {
    await exerciseUi(async ui => {
        ui.start();
        await ui.waitHeld();
        const selected = ui.press({ view: 'changes' });
        ui.release(new Error('Synthetic startup unavailable'));
        await selected;
        assert.doesNotMatch(ui.view.innerHTML, /Loading local demo/);
        assert.match(ui.view.innerHTML, /could not load|Synthetic startup unavailable/i);
    }, { holdStartup: true });
});

test('bulk source linking stops after navigation and refreshes later register data', async () => {
    await exerciseUi(async ui => {
        ui.start();
        await ui.loaded('변경 관리 시작');
        ui.evaluate(`state.detail = { change: { id: 'CHG-UI-CONCURRENCY', current_revision_no: 1 },
            revisions: [{ evidence: [] }] }; state.view = 'changes';`);
        ui.setHold('/api/actions');
        const originNo = ui.evaluate('state.navigationRequestNo ?? 0');
        const pending = ui.context.linkPassingSourceSet({ input: {
            changeId: 'CHG-UI-CONCURRENCY', actorId: 'ACT-MFG', expectedRevisionNo: 1
        } }, originNo);
        await ui.waitHeld();
        await ui.press({ openEquipment: 'EQ-ALIGN-B' });
        ui.release();
        await pending;
        assert.match(ui.view.innerHTML, /EV-B-MODULE/);
        assert.equal(ui.actionCount, 1, 'no later source POST should follow a changed selection');
        await ui.press({ view: 'changes' });
        await ui.loaded('CHG-POSTED');
    });
});

test('a superseded bootstrap failure cannot replace a newer equipment view', async () => {
    await exerciseUi(async ui => {
        ui.start();
        await ui.loaded('변경 관리 시작');
        ui.setHold('/api/bootstrap');
        const pendingReload = ui.context.reload();
        await ui.waitHeld();
        await ui.press({ openEquipment: 'EQ-ALIGN-B' });
        ui.release(new Error('Synthetic superseded bootstrap failure'));
        await assert.doesNotReject(pendingReload);
        assert.match(ui.view.innerHTML, /EV-B-MODULE/);
        assert.doesNotMatch(ui.toastMessage.textContent, /Synthetic superseded bootstrap failure/);
    });
});

test('a committed POST refreshes the currently selected register after navigation', async () => {
    await exerciseUi(async ui => {
        ui.start();
        await ui.loaded('변경 관리 시작');
        ui.setHold('/api/actions');
        const originNo = ui.evaluate('state.navigationRequestNo');
        const pending = ui.context.commitAndRefresh(
            ui.context.sendAction('syntheticCommit', {}), originNo);
        await ui.waitHeld();
        await ui.press({ view: 'changes' });
        assert.doesNotMatch(ui.view.innerHTML, /CHG-POSTED/);
        ui.release();
        await pending;
        await ui.loaded('CHG-POSTED');
    });
});
