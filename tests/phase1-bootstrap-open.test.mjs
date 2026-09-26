import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, SCHEMA_VERSION } from '../src/data/db.mjs';

test('fresh and reopened databases use the supported schema', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fabassure-open-'));
    const filename = join(directory, 'demo.sqlite');
    let db;
    try {
        db = openDatabase(filename);
        assert.equal(SCHEMA_VERSION, 9);
        assert.equal(db.prepare('PRAGMA user_version').get().user_version, 9);
        assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
        assert.deepEqual(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(({ version }) => version), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
        assert.throws(() => db.prepare("INSERT INTO lines(id,code,name) VALUES ('LINE-1','L1','Demo line')").run(), /dataset instance required/i);
        db.prepare("INSERT INTO dataset_instances(id,code,version,seed,generated_at) VALUES ('DATA-1','camera-demo',1,'fixed-seed','2026-09-01T00:00:00.000Z')").run();
        db.prepare("INSERT INTO lines(id,code,name) VALUES ('LINE-1','L1','Demo line')").run();
        db.close();
        db = undefined;
        db = openDatabase(filename);
        assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM lines').get().n, 1);
        db.close();
        db = undefined;
    } finally {
        if (db) db.close();
        rmSync(directory, { recursive: true, force: true });
    }
});

test('unknown and unversioned nonempty databases are rejected', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fabassure-open-'));
    try {
        for (const [name, sql] of [
            ['unknown', 'CREATE TABLE rogue(id TEXT); PRAGMA user_version = 99'],
            ['unversioned', 'CREATE TABLE rogue(id TEXT)']
        ]) {
            const filename = join(directory, `${name}.sqlite`);
            const db = new DatabaseSync(filename);
            db.exec(sql);
            db.close();
            assert.throws(() => openDatabase(filename), /version|schema|incompatible/i);
        }
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('claimed current version still requires the exact supported schema', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fabassure-schema-shape-'));
    const expectRejectedOpen = (filename) => {
        let opened;
        try {
            assert.throws(() => { opened = openDatabase(filename); }, /schema|incompatible/i);
        } finally {
            if (opened) opened.close();
        }
    };
    try {
        const missingView = join(directory, 'missing-view.sqlite');
        let db = openDatabase(missingView);
        db.exec('DROP VIEW aoi_integrity_gaps');
        db.close();
        expectRejectedOpen(missingView);

        const addedObject = join(directory, 'added-object.sqlite');
        db = openDatabase(addedObject);
        db.exec('CREATE TABLE rogue (id TEXT)');
        db.close();
        expectRejectedOpen(addedObject);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
