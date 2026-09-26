import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/data/db.mjs';
import { seedDatabase } from '../src/data/seed.mjs';

test('synthetic PFMEA, Control Plan and WI baselines seed reproducibly', () => {
    const snapshots = [];
    for (const instanceId of ['DATASET-DOC-SEED-A', 'DATASET-DOC-SEED-B']) {
        const db = openDatabase(':memory:');
        try {
            seedDatabase(db, { instanceId });
            const rows = db.prepare(`SELECT d.id,d.doc_type,d.scope_equipment_id,
                d.defect_code_id,d.code,d.title,v.id AS revision_id,v.revision_no,
                v.approved_by,v.approved_at,v.summary
                FROM controlled_documents d JOIN document_revisions v ON v.document_id=d.id
                ORDER BY d.doc_type`).all();
            assert.deepEqual(rows.map(row => row.doc_type), ['Control Plan', 'PFMEA', 'WI']);
            assert.ok(rows.every(row => row.scope_equipment_id === 'EQ-ALIGN-A' &&
                row.defect_code_id === 'DEF-FIDUCIAL' && row.revision_no === 1 &&
                row.approved_by === 'ACT-APP' && row.summary.includes('Synthetic')));
            assert.ok(rows.every(row => !/SK hynix|실제 회사|고객사/i.test(
                `${row.code} ${row.title} ${row.summary}`)));
            snapshots.push(rows);
        } finally {
            db.close();
        }
    }
    assert.deepEqual(snapshots[0], snapshots[1]);
});
