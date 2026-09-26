import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/data/db.mjs';
import { seedDatabase } from '../src/data/seed.mjs';
import { createChange } from '../src/domain/change-service.mjs';
import { resetDemo } from '../src/server/reset.mjs';

const resetEntry = fileURLToPath(new URL('../src/server/reset.mjs', import.meta.url));
const dbEntry = fileURLToPath(new URL('../src/data/db.mjs', import.meta.url));
const changeEntry = fileURLToPath(new URL('../src/domain/change-service.mjs', import.meta.url));
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'fabassure-reset-'));
    mkdirSync(join(root, 'data'));
    return {
        root,
        dbFile: join(root, 'data', 'fabassure-demo.sqlite'),
        cleanup() {
            assert.ok(resolve(root).startsWith(resolve(tmpdir())), 'Cleanup escaped temporary root');
            rmSync(root, { recursive: true, force: true });
        }
    };
}

function seedOld(file) {
    const db = openDatabase(file);
    try {
        seedDatabase(db, { instanceId: 'DATASET-BEFORE-RESET' });
        createChange(db, {
            id: 'CHG-RESET', title: 'Synthetic pre-reset decision', actorId: 'ACT-MFG',
            lineId: 'LINE-A', equipmentId: 'EQ-ALIGN-A', moduleId: 'MOD-ALIGN-A',
            recipeRevisionId: 'REC-ALIGN-R2', baselineRef: 'AOI-A-001',
            reason: 'Preserve this synthetic history in the local backup', at: '2026-08-05T12:00:00.000Z'
        });
    } finally {
        db.close();
    }
}

function summary(file) {
    const db = openDatabase(file);
    try {
        return {
            datasetId: db.prepare('SELECT id FROM dataset_instances WHERE slot=1').get().id,
            changes: db.prepare('SELECT COUNT(*) AS n FROM changes').get().n,
            lots: db.prepare('SELECT COUNT(*) AS n FROM lots').get().n,
            measurements: db.prepare('SELECT COUNT(*) AS n FROM measurements').get().n
        };
    } finally {
        db.close();
    }
}

test('reset preserves old audited history in a local backup and recreates the same synthetic source rows', async () => {
    const item = fixture();
    try {
        seedOld(item.dbFile);
        const oldHash = sha256(item.dbFile);
        const first = await resetDemo({ root: item.root });
        assert.match(first.datasetInstanceId, /^DATASET-[A-F0-9-]+$/);
        assert.notEqual(first.datasetInstanceId, 'DATASET-BEFORE-RESET');
        assert.ok(existsSync(first.backupFile));
        assert.equal(sha256(first.backupFile), oldHash, 'The previous SQLite bytes changed in backup');
        assert.ok(resolve(first.backupFile).startsWith(resolve(join(item.root, 'data', 'backups'))));
        assert.deepEqual(summary(first.backupFile), {
            datasetId: 'DATASET-BEFORE-RESET', changes: 1, lots: 45, measurements: 825
        });
        assert.deepEqual(summary(item.dbFile), {
            datasetId: first.datasetInstanceId, changes: 0, lots: 45, measurements: 825
        });
        const second = await resetDemo({ root: item.root });
        assert.notEqual(second.datasetInstanceId, first.datasetInstanceId);
        assert.equal(summary(second.backupFile).datasetId, first.datasetInstanceId);
        assert.equal(summary(item.dbFile).changes, 0);
        assert.equal(readdirSync(join(item.root, 'data', 'backups')).length, 2);
    } finally {
        item.cleanup();
    }
});

test('reset refuses to replace an SQLite file still open by the appliance', { skip: process.platform !== 'win32' }, async () => {
    const item = fixture();
    const db = openDatabase(item.dbFile);
    try {
        seedDatabase(db, { instanceId: 'DATASET-OPEN' });
        await assert.rejects(() => resetDemo({ root: item.root }), /EBUSY|EPERM|close|in use/i);
        assert.equal(db.prepare('SELECT id FROM dataset_instances WHERE slot=1').get().id, 'DATASET-OPEN');
        assert.ok(existsSync(item.dbFile));
        const staged = readdirSync(join(item.root, 'data')).filter(name => name.startsWith('.fabassure-reset-'));
        assert.equal(staged.length, 1, 'Keep the prepared replacement after an uncertain rename failure');
        assert.equal(summary(join(item.root, 'data', staged[0])).changes, 0);
        const backups = readdirSync(join(item.root, 'data', 'backups'));
        assert.equal(backups.length, 1, 'Failed replacement must preserve a local copy of the old dataset');
        assert.equal(summary(join(item.root, 'data', 'backups', backups[0])).datasetId, 'DATASET-OPEN');
    } finally {
        db.close();
        item.cleanup();
    }
});

test('a second cooperating reset cannot write during backup and replacement', async () => {
    const item = fixture();
    let child;
    try {
        seedOld(item.dbFile);
        const oldHash = sha256(item.dbFile);
        const script = join(item.root, 'pause-before-replace.mjs');
        const ready = join(item.root, 'ready');
        const release = join(item.root, 'release');
        writeFileSync(script, `import fs from 'node:fs';\nimport { syncBuiltinESMExports } from 'node:module';\nimport { join } from 'node:path';\nimport { pathToFileURL } from 'node:url';\nconst active = join(process.argv[3], 'data', 'fabassure-demo.sqlite');\nconst original = fs.renameSync;\nfs.renameSync = (from, to) => {\n    if (to === active) {\n        fs.writeFileSync(process.argv[4], 'ready');\n        const cell = new Int32Array(new SharedArrayBuffer(4));\n        for (let n = 0; !fs.existsSync(process.argv[5]) && n < 100; n++) Atomics.wait(cell, 0, 0, 100);\n        if (!fs.existsSync(process.argv[5])) throw new Error('Cooperating reset pause timed out');\n    }\n    return original(from, to);\n};\nsyncBuiltinESMExports();\nconst { resetDemo } = await import(pathToFileURL(process.argv[2]).href);\nprocess.stdout.write(JSON.stringify(await resetDemo({ root: process.argv[3] })));\n`);
        child = spawn(process.execPath, [script, resetEntry, item.root, ready, release], { stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        let errors = '';
        child.stdout.on('data', data => { output += data; });
        child.stderr.on('data', data => { errors += data; });
        const started = Date.now();
        while (!existsSync(ready) && Date.now() - started < 10000) {
            if (child.exitCode !== null) break;
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.ok(existsSync(ready), `First reset did not reach replacement: ${errors}`);
        const backupsBefore = readdirSync(join(item.root, 'data', 'backups'));
        assert.equal(backupsBefore.length, 1);
        await assert.rejects(() => resetDemo({ root: item.root }), /another FabAssure process.*active/i);
        assert.equal(sha256(item.dbFile), oldHash);
        assert.deepEqual(readdirSync(join(item.root, 'data', 'backups')), backupsBefore);
        writeFileSync(release, 'go');
        const exitCode = await new Promise(resolve => child.once('exit', resolve));
        assert.equal(exitCode, 0, errors);
        const result = JSON.parse(output);
        const backup = openDatabase(result.backupFile);
        try {
            assert.equal(backup.prepare("SELECT COUNT(*) AS n FROM changes WHERE id='CHG-RESET'").get().n, 1);
        } finally {
            backup.close();
        }
        assert.equal(sha256(result.backupFile), oldHash);
        assert.equal(summary(item.dbFile).changes, 0);
    } finally {
        if (child?.exitCode === null) child.kill();
        item.cleanup();
    }
});

test('a corrupted backup candidate is visibly pending and cannot replace the active dataset', () => {
    const item = fixture();
    try {
        seedOld(item.dbFile);
        const oldHash = sha256(item.dbFile);
        const script = join(item.root, 'damage-backup-copy.mjs');
        writeFileSync(script, `import fs from 'node:fs';\nimport { syncBuiltinESMExports } from 'node:module';\nimport { pathToFileURL } from 'node:url';\nconst original = fs.copyFileSync;\nfs.copyFileSync = (from, to, mode) => { original(from, to, mode); fs.writeFileSync(to, 'damaged'); };\nsyncBuiltinESMExports();\nconst { resetDemo } = await import(pathToFileURL(process.argv[2]).href);\ntry { await resetDemo({ root: process.argv[3] }); process.exitCode = 9; } catch (error) { process.stderr.write(error.message); }\n`);
        const child = spawnSync(process.execPath, [script, resetEntry, item.root], {
            encoding: 'utf8', timeout: 30000
        });
        assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
        assert.match(child.stderr, /backup.*match/i);
        assert.equal(sha256(item.dbFile), oldHash);
        const backups = readdirSync(join(item.root, 'data', 'backups'));
        assert.equal(backups.length, 1);
        assert.match(backups[0], /\.pending$/);
        assert.equal(summary(item.dbFile).changes, 1);
    } finally {
        item.cleanup();
    }
});

test('an uninitialized old SQLite file cannot become a promoted backup', async () => {
    const item = fixture();
    try {
        const db = openDatabase(item.dbFile);
        db.close();
        const oldHash = sha256(item.dbFile);
        await assert.rejects(() => resetDemo({ root: item.root }), /initialized instance identity/i);
        assert.equal(sha256(item.dbFile), oldHash);
        assert.deepEqual(readdirSync(join(item.root, 'data', 'backups')), []);
        assert.deepEqual(readdirSync(join(item.root, 'data')).filter(name => name.startsWith('.fabassure-reset-')), []);
    } finally {
        item.cleanup();
    }
});

test('reset rejects a dangling SQLite journal link', async t => {
    const item = fixture();
    const sidecar = item.dbFile + '-wal';
    try {
        seedOld(item.dbFile);
        try {
            symlinkSync(join(item.root, 'data', 'missing-wal'), sidecar, 'junction');
        } catch (error) {
            if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
                t.skip(`Windows junction unavailable: ${error.code}`);
                return;
            }
            throw error;
        }
        await assert.rejects(() => resetDemo({ root: item.root }), /journal sidecar|recover/i);
        assert.equal(summary(item.dbFile).datasetId, 'DATASET-BEFORE-RESET');
    } finally {
        if (existsSync(sidecar) || readdirSync(join(item.root, 'data')).includes('fabassure-demo.sqlite-wal')) unlinkSync(sidecar);
        item.cleanup();
    }
});

test('an abrupt exit during the replacement step never leaves the active dataset missing', async () => {
    const item = fixture();
    try {
        seedOld(item.dbFile);
        const crashScript = join(item.root, 'crash-after-first-rename.mjs');
        writeFileSync(crashScript, `import fs from 'node:fs';\nimport { syncBuiltinESMExports } from 'node:module';\nimport { join } from 'node:path';\nimport { pathToFileURL } from 'node:url';\nconst active = join(process.argv[3], 'data', 'fabassure-demo.sqlite');\nconst original = fs.renameSync;\nfs.renameSync = (...args) => { const result = original(...args); if (args[1] === active) process.exit(77); return result; };\nsyncBuiltinESMExports();\nconst { resetDemo } = await import(pathToFileURL(process.argv[2]).href);\nresetDemo({ root: process.argv[3] });\n`);
        const child = spawnSync(process.execPath, [crashScript, resetEntry, item.root], {
            encoding: 'utf8', timeout: 30000
        });
        assert.equal(child.status, 77, `${child.stdout}\n${child.stderr}`);
        assert.ok(existsSync(item.dbFile), 'Abrupt exit left no active SQLite dataset');
        assert.doesNotThrow(() => summary(item.dbFile));
        const backups = readdirSync(join(item.root, 'data', 'backups'));
        assert.equal(backups.length, 1);
        assert.equal(summary(join(item.root, 'data', 'backups', backups[0])).changes, 1);
    } finally {
        item.cleanup();
    }
});

test('reset refuses an internal backups junction instead of silently changing the backup location', async t => {
    const item = fixture();
    const other = join(item.root, 'data', 'other');
    const junction = join(item.root, 'data', 'backups');
    try {
        seedOld(item.dbFile);
        mkdirSync(other);
        try {
            symlinkSync(other, junction, 'junction');
        } catch (error) {
            if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
                t.skip(`Windows junction unavailable: ${error.code}`);
                return;
            }
            throw error;
        }
        await assert.rejects(() => resetDemo({ root: item.root }), /backup.*link|backup.*junction|backup.*location/i);
        assert.equal(summary(item.dbFile).datasetId, 'DATASET-BEFORE-RESET');
        assert.deepEqual(readdirSync(other), []);
    } finally {
        if (existsSync(junction)) unlinkSync(junction);
        item.cleanup();
    }
});

test('reset rejects a data junction outside the portable folder', async t => {
    const root = mkdtempSync(join(tmpdir(), 'fabassure-reset-link-'));
    const external = mkdtempSync(join(tmpdir(), 'fabassure-reset-external-'));
    const junction = join(root, 'data');
    try {
        try {
            symlinkSync(external, junction, 'junction');
        } catch (error) {
            if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
                t.skip(`Windows junction unavailable: ${error.code}`);
                return;
            }
            throw error;
        }
        await assert.rejects(() => resetDemo({ root }), /data.*root|outside|linked/i);
        assert.deepEqual(readdirSync(external), []);
    } finally {
        if (existsSync(junction)) unlinkSync(junction);
        assert.ok(resolve(root).startsWith(resolve(tmpdir())) && resolve(external).startsWith(resolve(tmpdir())));
        rmSync(root, { recursive: true, force: true });
        rmSync(external, { recursive: true, force: true });
    }
});
