import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/data/db.mjs';
import { seedDatabase } from '../src/data/seed.mjs';
import { createLocalServer, listenLocal } from '../src/server/http.mjs';

async function fixture(run) {
    const db = openDatabase(':memory:');
    const assetsDir = mkdtempSync(join(tmpdir(), 'fabassure-equipment-http-'));
    for (const name of ['index.html', 'app.js', 'styles.css']) {
        writeFileSync(join(assetsDir, name), `Synthetic ${name}`);
    }
    let server;
    try {
        seedDatabase(db, { instanceId: 'DATASET-EQUIPMENT-HTTP' });
        server = createLocalServer(db, { assetsDir });
        const local = await listenLocal(server, 0);
        return await run({ db, local });
    } finally {
        if (server?.listening) await new Promise(resolve => server.close(resolve));
        db.close();
        rmSync(assetsDir, { recursive: true, force: true });
    }
}

test('equipment list exposes only seeded synthetic assets and their module ownership', () => fixture(async ({ local }) => {
    const response = await fetch(`${local.url}/api/equipment`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.synthetic, true);
    assert.ok(body.equipment.some(item => item.id === 'EQ-ALIGN-A' &&
        item.modules.some(module => module.id === 'MOD-ALIGN-A' && module.equipmentId === item.id)));
    assert.ok(body.equipment.some(item => item.id === 'EQ-ALIGN-B'));
    assert.equal(body.equipment.some(item => 'endpoint' in item || 'ipAddress' in item), false);
}));

test('equipment detail links repairs, events, runs and AOI to the selected tool', () => fixture(async ({ db, local }) => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n;
    const response = await fetch(`${local.url}/api/equipment/EQ-ALIGN-A`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.equipment.id, 'EQ-ALIGN-A');
    assert.equal(body.observationWindow.hours, 960);
    assert.equal(body.reliability.mtbfHours, 478.5);
    assert.equal(body.reliability.mttrHours, 1.5);
    assert.ok(body.timeline.some(item => item.id === 'EV-VISION-2'));
    assert.ok(body.timeline.some(item => item.id === 'MA-VISION-2'));
    assert.ok(body.recentRuns.every(run => run.moduleId === 'MOD-ALIGN-A'));
    assert.equal(body.aoi.inspectedUnits, 4000);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n, before);
    const other = await (await fetch(`${local.url}/api/equipment/EQ-ALIGN-B`)).json();
    assert.equal(other.reliability.mtbfHours, null);
    assert.equal(other.timeline.some(item => item.id === 'MA-VISION-2'), false);
}));

test('equipment API rejects malformed and unknown IDs without reflecting input or SQL', () => fixture(async ({ local }) => {
    const invalid = await fetch(`${local.url}/api/equipment/%27%20OR%201%3D1`);
    assert.equal(invalid.status, 400);
    const invalidBody = await invalid.text();
    assert.doesNotMatch(invalidBody, /OR 1=1|SELECT|SQLITE/i);
    const unknown = await fetch(`${local.url}/api/equipment/EQ-UNKNOWN`);
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error.code, 'NOT_FOUND');
    const method = await fetch(`${local.url}/api/equipment`, { method: 'POST' });
    assert.equal(method.status, 405);
}));
