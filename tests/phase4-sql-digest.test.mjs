import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openDatabase } from '../src/data/db.mjs';

test('FabAssure SQLite handle registers deterministic local SHA-256 for evidence gates', () => {
    const db = openDatabase(':memory:');
    try {
        const expected = createHash('sha256').update('synthetic source', 'utf8').digest('hex');
        assert.equal(db.prepare('SELECT fab_sha256(?) AS digest').get('synthetic source').digest,
            expected);
    } finally {
        db.close();
    }
});
