import { withValidatedTransaction } from './db.mjs';

const GENERATED_AT = '2026-09-10T00:00:00.000Z';
const OBSERVATION_START = '2026-08-01T00:00:00.000Z';
const OBSERVATION_END = '2026-09-10T00:00:00.000Z';

function timestamp(dayNumber, clock) {
    const day = new Date(Date.UTC(2026, 7, dayNumber)).toISOString().slice(0, 10);
    return `${day}T${clock}.000Z`;
}

function addRows(db, sql, rows) {
    const statement = db.prepare(sql);
    for (const row of rows) statement.run(...row);
}

function lotSuffix(index) {
    return String(index).padStart(3, '0');
}

export function seedDatabase(db, { instanceId } = {}) {
    if (typeof instanceId !== 'string' || !/^DATASET-[A-Z0-9-]+$/.test(instanceId)) {
        throw new TypeError('A synthetic DATASET-* instance ID is required');
    }
    return withValidatedTransaction(db, (tx) => {
        addRows(tx, 'INSERT INTO dataset_instances(id,code,version,seed,generated_at) VALUES (?,?,?,?,?)', [
            [instanceId, 'camera-demo', 1, 'fabassure-camera-v1', GENERATED_AT]
        ]);
        addRows(tx, 'INSERT INTO lines(id,code,name) VALUES (?,?,?)', [
            ['LINE-A', 'A', 'Demo camera assembly line A'],
            ['LINE-B', 'B', 'Demo camera assembly line B']
        ]);
        addRows(tx, 'INSERT INTO equipment(id,line_id,code,name) VALUES (?,?,?,?)', [
            ['EQ-ALIGN-A', 'LINE-A', 'ALIGN-A', 'Integrated alignment and vision cell A'],
            ['EQ-AOI-A', 'LINE-A', 'AOI-A', 'Vision inspection station A'],
            ['EQ-ALIGN-B', 'LINE-B', 'ALIGN-B', 'Alignment station B'],
            ['EQ-AOI-B', 'LINE-B', 'AOI-B', 'Vision inspection station B']
        ]);
        addRows(tx, 'INSERT INTO modules(id,equipment_id,code,name) VALUES (?,?,?,?)', [
            ['MOD-ALIGN-A', 'EQ-ALIGN-A', 'ALIGN-VISION', 'Alignment and vision module A'],
            ['MOD-VISION-A', 'EQ-AOI-A', 'VISION', 'Vision module A'],
            ['MOD-ALIGN-B', 'EQ-ALIGN-B', 'ALIGN', 'Alignment module B'],
            ['MOD-ALIGN-B-R2', 'EQ-ALIGN-B', 'ALIGN-R2', 'Revised alignment module B'],
            ['MOD-VISION-B', 'EQ-AOI-B', 'VISION', 'Vision module B']
        ]);
        addRows(tx, 'INSERT INTO recipe_revisions(id,recipe_code,revision,effective_at) VALUES (?,?,?,?)', [
            ['REC-ALIGN-R1', 'ALIGN-A', 1, timestamp(1, '00:00:00')],
            ['REC-ALIGN-R2', 'ALIGN-A', 2, timestamp(6, '00:00:00')],
            ['REC-ALIGN-R3', 'ALIGN-A', 3, timestamp(8, '00:00:00')],
            ['REC-B-R1', 'ALIGN-B', 1, timestamp(3, '00:00:00')],
            ['REC-B-R2', 'ALIGN-B', 2, timestamp(5, '00:00:00')]
        ]);
        addRows(tx, 'INSERT INTO product_families(id,code,name) VALUES (?,?,?)', [
            ['PF-CAMERA', 'CAM-DEMO-1', 'Synthetic camera module']
        ]);
        addRows(tx, 'INSERT INTO characteristics(id,product_family_id,code,name,unit) VALUES (?,?,?,?,?)', [
            ['CHAR-ALIGN-X', 'PF-CAMERA', 'ALIGN-X', 'Absolute alignment offset', 'mm']
        ]);
        addRows(tx, 'INSERT INTO defect_codes(id,code,name,severity) VALUES (?,?,?,?)', [
            ['DEF-ALIGN', 'DC-ALIGN', 'Alignment reject', 'critical'],
            ['DEF-FIDUCIAL', 'DC-FIDUCIAL', 'Vision fiducial miss', 'major'],
            ['DEF-COSMETIC', 'DC-COSMETIC', 'Cosmetic reject', 'minor']
        ]);

        const insertLot = tx.prepare('INSERT INTO lots(id,product_family_id,code,quantity,start_at,end_at) VALUES (?,?,?,?,?,?)');
        const insertRun = tx.prepare('INSERT INTO process_runs(id,lot_id,equipment_id,module_id,recipe_revision_id,start_at,end_at,processed_units) VALUES (?,?,?,?,?,?,?,?)');
        const insertSample = tx.prepare('INSERT INTO inspection_samples(id,lot_id,process_run_id,sampled_at,sample_size) VALUES (?,?,?,?,?)');
        const insertMeasurement = tx.prepare('INSERT INTO measurements(id,inspection_sample_id,characteristic_id,value,unit,method,recorded_at) VALUES (?,?,?,?,?,?,?)');
        const insertAoi = tx.prepare('INSERT INTO aoi_inspections(id,lot_id,process_run_id,inspected_at,inspected_units,rejected_units) VALUES (?,?,?,?,?,?)');
        const insertDefect = tx.prepare('INSERT INTO aoi_defects(id,aoi_inspection_id,defect_code_id,defect_count,location) VALUES (?,?,?,?,?)');

        function seedLot(line, index) {
            const suffix = lotSuffix(index);
            const lotId = `LOT-${line}-${suffix}`;
            const runId = `RUN-${line}-${suffix}`;
            const sampleId = `SAMPLE-${line}-${suffix}`;
            const aoiId = `AOI-${line}-${suffix}`;
            const dayNumber = line === 'A' ? index : index + 2;
            const equipmentId = line === 'A' ? 'EQ-ALIGN-A' : 'EQ-ALIGN-B';
            const moduleId = line === 'A' ? 'MOD-ALIGN-A' : (index < 3 ? 'MOD-ALIGN-B' : 'MOD-ALIGN-B-R2');
            const recipeId = line === 'A'
                ? (index < 6 ? 'REC-ALIGN-R1' : index < 8 ? 'REC-ALIGN-R2' : 'REC-ALIGN-R3')
                : (index < 3 ? 'REC-B-R1' : 'REC-B-R2');
            const sampleSize = line === 'A' ? 20 : 5;
            insertLot.run(lotId, 'PF-CAMERA', lotId, 100, timestamp(dayNumber, '08:00:00'), timestamp(dayNumber, '12:00:00'));
            insertRun.run(runId, lotId, equipmentId, moduleId, recipeId, timestamp(dayNumber, '09:00:00'), timestamp(dayNumber, '11:00:00'), 100);
            insertSample.run(sampleId, lotId, runId, timestamp(dayNumber, '10:00:00'), sampleSize);
            for (let sample = 1; sample <= sampleSize; sample++) {
                const value = line === 'A' && index === 6 && sample === 7
                    ? 0.10
                    : Number((0.012 + ((index * 7 + sample * 3) % 11) * 0.004).toFixed(3));
                insertMeasurement.run(`MEAS-${line}-${suffix}-${String(sample).padStart(2, '0')}`, sampleId,
                    'CHAR-ALIGN-X', value, 'mm', 'synthetic vision gauge', timestamp(dayNumber, '10:00:00'));
            }

            const defects = [];
            if (line === 'A' && index === 6) defects.push(['DEF-ALIGN', 2]);
            else if (line === 'A' && index === 26) defects.push(['DEF-FIDUCIAL', 5]);
            else if (line === 'A' && index === 27) defects.push(['DEF-FIDUCIAL', 4]);
            else if (line === 'A' && index === 39) defects.push(['DEF-FIDUCIAL', 1]);
            else if (index % 5 === 0) defects.push(['DEF-COSMETIC', 1]);
            const rejected = defects.reduce((total, [, count]) => total + count, 0);
            insertAoi.run(aoiId, lotId, runId, timestamp(dayNumber, '10:30:00'), 100, rejected);
            defects.forEach(([code, count], position) => {
                insertDefect.run(`AOIDEF-${line}-${suffix}-${position + 1}`, aoiId, code, count, 'synthetic primary code');
            });
        }

        for (let index = 1; index <= 40; index++) seedLot('A', index);
        for (let index = 1; index <= 5; index++) seedLot('B', index);

        addRows(tx, 'INSERT INTO equipment_events(id,equipment_id,module_id,event_type,occurred_at,duration_seconds) VALUES (?,?,?,?,?,?)', [
            ['EV-VISION-1', 'EQ-ALIGN-A', 'MOD-ALIGN-A', 'failure', timestamp(10, '12:00:00'), 3600],
            ['EV-VISION-2', 'EQ-ALIGN-A', 'MOD-ALIGN-A', 'failure', timestamp(24, '18:00:00'), 7200],
            ['EV-RECIPE-2', 'EQ-ALIGN-A', 'MOD-ALIGN-A', 'recipe-change', timestamp(6, '00:00:00'), 0],
            ['EV-RECIPE-3', 'EQ-ALIGN-A', 'MOD-ALIGN-A', 'recipe-change', timestamp(8, '00:00:00'), 0],
            ['EV-LKG-EARLIEST', 'EQ-ALIGN-A', 'MOD-ALIGN-A', 'lkg-earliest-bound', timestamp(25, '08:00:00'), 0],
            ['EV-LKG-LATEST', 'EQ-ALIGN-A', 'MOD-ALIGN-A', 'lkg-latest-bound', timestamp(25, '12:00:00'), 0],
            ['EV-DETECTION', 'EQ-ALIGN-A', 'MOD-ALIGN-A', 'defect-detected', timestamp(27, '10:00:00'), 0],
            ['EV-B-MODULE', 'EQ-ALIGN-B', 'MOD-ALIGN-B-R2', 'module-change', timestamp(5, '00:00:00'), 0]
        ]);
        addRows(tx, 'INSERT INTO maintenance_actions(id,equipment_id,module_id,code,summary,start_at,end_at) VALUES (?,?,?,?,?,?,?)', [
            ['MA-VISION-1', 'EQ-ALIGN-A', 'MOD-ALIGN-A', 'REPAIR', 'Synthetic integrated vision module repair', timestamp(10, '12:00:00'), timestamp(10, '13:00:00')],
            ['MA-VISION-2', 'EQ-ALIGN-A', 'MOD-ALIGN-A', 'REPAIR', 'Synthetic integrated vision module maintenance before excursion', timestamp(24, '18:00:00'), timestamp(24, '20:00:00')]
        ]);
        addRows(tx, `INSERT INTO controlled_documents(id,doc_type,scope_equipment_id,
            defect_code_id,code,title) VALUES (?,?,?,?,?,?)`, [
            ['DOC-CAM-CP', 'Control Plan', 'EQ-ALIGN-A', 'DEF-FIDUCIAL',
                'FA-CP-01', 'Synthetic camera alignment control plan'],
            ['DOC-CAM-PFMEA', 'PFMEA', 'EQ-ALIGN-A', 'DEF-FIDUCIAL',
                'FA-PFMEA-01', 'Synthetic camera alignment process FMEA'],
            ['DOC-CAM-WI', 'WI', 'EQ-ALIGN-A', 'DEF-FIDUCIAL',
                'FA-WI-01', 'Synthetic alignment and vision work instruction']
        ]);
        addRows(tx, `INSERT INTO document_revisions(id,document_id,revision_no,
            summary,approved_by,approved_at) VALUES (?,?,?,?,?,?)`, [
            ['DOC-CAM-CP-R1', 'DOC-CAM-CP', 1,
                'Synthetic baseline: AOI fiducial check and recorded lot disposition.',
                'ACT-APP', '2026-08-01T13:00:00.000Z'],
            ['DOC-CAM-PFMEA-R1', 'DOC-CAM-PFMEA', 1,
                'Synthetic baseline: module shift failure mode and detection control.',
                'ACT-APP', '2026-08-01T13:01:00.000Z'],
            ['DOC-CAM-WI-R1', 'DOC-CAM-WI', 1,
                'Synthetic baseline: alignment setup, vision check and escalation steps.',
                'ACT-APP', '2026-08-01T13:02:00.000Z']
        ]);
        const sampleGap = tx.prepare('SELECT s.id FROM inspection_samples s LEFT JOIN measurements m ON m.inspection_sample_id=s.id GROUP BY s.id HAVING COUNT(m.id)<>s.sample_size LIMIT 1').get();
        if (sampleGap) throw new Error(`Synthetic sample-size mismatch: ${sampleGap.id}`);
        return { instanceId, sourceVersion: 1 };
    });
}

export function getDemoMetrics(db) {
    const aoi = db.prepare('SELECT COALESCE(SUM(inspected_units),0) AS inspected, COALESCE(SUM(rejected_units),0) AS rejected FROM aoi_inspections').get();
    const failureRows = db.prepare(`
        SELECT e.id, e.duration_seconds, COUNT(m.id) AS repair_count,
            COALESCE(SUM(strftime('%s',m.end_at)-strftime('%s',m.start_at)),0) AS repair_seconds
        FROM equipment_events e
        LEFT JOIN maintenance_actions m ON m.equipment_id=e.equipment_id
            AND m.module_id=e.module_id AND m.start_at=e.occurred_at
            AND m.code='REPAIR' AND m.end_at<=?
        WHERE e.equipment_id='EQ-ALIGN-A' AND e.module_id='MOD-ALIGN-A' AND e.event_type='failure'
            AND e.occurred_at>=? AND e.occurred_at<?
        GROUP BY e.id ORDER BY e.id
    `).all(OBSERVATION_END, OBSERVATION_START, OBSERVATION_END);
    for (const row of failureRows) {
        if (row.repair_count !== 1 || row.repair_seconds !== row.duration_seconds) {
            throw new Error(`Unreconciled failure and repair: ${row.id}`);
        }
    }
    const failures = failureRows.length;
    const repair = failureRows.reduce((total, row) => total + row.repair_seconds, 0);
    const observationHours = (Date.parse(OBSERVATION_END) - Date.parse(OBSERVATION_START)) / 3_600_000;
    const downtimeHours = repair / 3600;
    return {
        inspectedUnits: aoi.inspected,
        rejectedUnits: aoi.rejected,
        rejectRate: aoi.inspected ? aoi.rejected / aoi.inspected : null,
        rejectDppm: aoi.inspected ? 1_000_000 * aoi.rejected / aoi.inspected : null,
        failureCount: failures,
        observationHours,
        downtimeHours,
        mttrHours: failures ? downtimeHours / failures : null,
        mtbfHours: failures ? (observationHours - downtimeHours) / failures : null
    };
}
