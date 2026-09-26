import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

test('additive v3 SQL defines immutable trace proposals and independent lot scope review', () => {
    const db = new DatabaseSync(':memory:');
    try {
        db.exec('PRAGMA foreign_keys=ON');
        for (const file of ['schema.sql', 'schema-v2.sql', 'schema-v3.sql']) {
            db.exec(readFileSync(new URL(`../src/data/${file}`, import.meta.url), 'utf8'));
        }
        for (const name of ['legacy_incidents', 'lkg_observations', 'trace_proposals', 'trace_candidates',
            'scope_reviews', 'scope_decisions']) {
            assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?")
                .get(name).n, 1, name);
        }
        assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
        assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='scope_reviewer_separation'").get());
    } finally {
        db.close();
    }
});
