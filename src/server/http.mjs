import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { getDemoMetrics } from '../data/seed.mjs';
import { getEquipmentRegister, getEquipmentTimeline } from '../domain/equipment-timeline.mjs';
import {
    createChange, submitChange, classifyChange, approvePlan, startVerification,
    recordBaselineSet, addMeasurementEvidence, recordAlignmentResult,
    addAoiEvidence, recordAoiResults, reviseFailedChange, markEvidenceReady,
    beginIndependentReview, recordIndependentReview, acceptChange,
    classifyLegacyAcceptance, getAcceptanceStatus, reconcileConditionalAcceptances,
    reviseExpiredChange, reviseFailedEffectivenessChange
} from '../domain/change-service.mjs';
import { createIncident, containIncident, recordIncidentLkg,
    proposeIncidentTrace, reviewIncidentScope, reviseIncidentTrace } from '../domain/incident-service.mjs';
import { startIncidentCapa, assessIncidentCause, planCapaAction, reviewCapaAction }
    from '../domain/capa-service.mjs';
import { proposeDocumentFeedback, reviewDocumentFeedback, approveDocumentRevision }
    from '../domain/document-service.mjs';
import { evaluateIncidentEffectiveness, closeIncidentCycle, reopenIncidentCycle }
    from '../domain/incident-effectiveness-service.mjs';
import { evaluateChangeEffectiveness, closeChangeMonitoring,
    reopenChangeMonitoring }
    from '../domain/change-effectiveness-service.mjs';

const MAX_BODY_BYTES = 65_536;
const staticFiles = Object.freeze({
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/index.html': ['index.html', 'text/html; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/styles.css': ['styles.css', 'text/css; charset=utf-8']
});
const actions = Object.freeze({
    createChange, submitChange, classifyChange, approvePlan, startVerification,
    recordBaselineSet, addMeasurementEvidence, recordAlignmentResult,
    addAoiEvidence, recordAoiResults, reviseFailedChange, markEvidenceReady,
    beginIndependentReview, recordIndependentReview, acceptChange,
    classifyLegacyAcceptance, reviseExpiredChange,
    reviseFailedEffectivenessChange,
    evaluateChangeEffectiveness, closeChangeMonitoring,
    reopenChangeMonitoring,
    createIncident, containIncident, recordIncidentLkg,
    proposeIncidentTrace, reviewIncidentScope, reviseIncidentTrace,
    startIncidentCapa, assessIncidentCause, planCapaAction, reviewCapaAction,
    proposeDocumentFeedback, reviewDocumentFeedback, approveDocumentRevision,
    evaluateIncidentEffectiveness, closeIncidentCycle, reopenIncidentCycle
});

const securityHeaders = Object.freeze({
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY'
});

function send(res, status, body, contentType = 'application/json; charset=utf-8') {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(
        typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    res.writeHead(status, {
        ...securityHeaders,
        'content-type': contentType,
        'content-length': String(bytes.length)
    });
    res.end(bytes);
}

function reject(res, status, code, message) {
    send(res, status, { error: { code, message } });
}

function safeGateMessage(message) {
    for (const label of ['Unknown incident', 'Held lot lacks incident source context',
        'Unknown change', 'Unknown simulated actor']) {
        if (message.startsWith(`${label}: `)) return `${label}: supplied ID omitted`;
    }
    return message;
}

function rejectActionError(res, error) {
    const message = String(error?.message ?? '');
    if (error?.code || error?.name === 'SqliteError' ||
        message.length > 500 || /SQLITE|constraint failed|\b(?:INSERT|UPDATE|DELETE|SELECT)\s|[A-Za-z]:\\|\/src\//i.test(message)) {
        reject(res, 409, 'LOCAL_DATA_CONFLICT', 'Local data integrity or duplicate-record rule rejected the action');
    } else if (error instanceof Error) {
        reject(res, 409, 'GATE_DENIED', safeGateMessage(message));
    } else {
        reject(res, 500, 'LOCAL_ERROR', 'A local request failed');
    }
}

async function readAction(req) {
    if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        const error = new TypeError('JSON content type is required');
        error.status = 415;
        throw error;
    }
    const statedLength = Number(req.headers['content-length'] ?? 0);
    if (!Number.isSafeInteger(statedLength) || statedLength < 0 || statedLength > MAX_BODY_BYTES) {
        const error = new RangeError('Action body exceeds the local size limit');
        error.status = 413;
        throw error;
    }
    let length = 0;
    const chunks = [];
    for await (const chunk of req) {
        length += chunk.length;
        if (length > MAX_BODY_BYTES) {
            const error = new RangeError('Action body exceeds the local size limit');
            error.status = 413;
            throw error;
        }
        chunks.push(chunk);
    }
    let parsed;
    try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        const error = new TypeError('Malformed JSON action');
        error.status = 400;
        throw error;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        typeof parsed.action !== 'string' || !Object.hasOwn(actions, parsed.action) ||
        !parsed.input || typeof parsed.input !== 'object' || Array.isArray(parsed.input)) {
        const error = new TypeError('Unsupported local action or input');
        error.status = 400;
        throw error;
    }
    return parsed;
}

const sourceQueries = Object.freeze({
    measurements: `SELECT m.*,s.lot_id,s.process_run_id,s.sampled_at,s.sample_size,
        r.equipment_id,r.module_id,r.recipe_revision_id
        FROM measurements m JOIN inspection_samples s ON s.id=m.inspection_sample_id
        JOIN process_runs r ON r.id=s.process_run_id WHERE m.id=?`,
    aoi_inspections: `SELECT a.*,r.equipment_id,r.module_id,r.recipe_revision_id
        FROM aoi_inspections a JOIN process_runs r ON r.id=a.process_run_id WHERE a.id=?`,
    aoi_defects: 'SELECT * FROM aoi_defects WHERE id=?',
    inspection_samples: 'SELECT * FROM inspection_samples WHERE id=?',
    process_runs: 'SELECT * FROM process_runs WHERE id=?',
    lots: 'SELECT * FROM lots WHERE id=?',
    equipment_events: 'SELECT * FROM equipment_events WHERE id=?',
    maintenance_actions: 'SELECT * FROM maintenance_actions WHERE id=?',
    recipe_revisions: 'SELECT * FROM recipe_revisions WHERE id=?'
});

function evidenceDetail(db, item) {
    const source = item.source_table === 'embedded_note' ? null :
        (Object.hasOwn(sourceQueries, item.source_table)
            ? db.prepare(sourceQueries[item.source_table]).get(item.source_id) ?? null : null);
    if (source && item.source_table === 'aoi_inspections') {
        source.defects = db.prepare('SELECT * FROM aoi_defects WHERE aoi_inspection_id=? ORDER BY id')
            .all(item.source_id);
    }
    return { ...item, payload: JSON.parse(item.payload_json), payload_json: undefined, source };
}

function changeDetail(db, id, now) {
    const change = db.prepare('SELECT * FROM changes WHERE id=?').get(id);
    if (!change) return null;
    const revisions = db.prepare('SELECT * FROM change_revisions WHERE change_id=? ORDER BY revision_no')
        .all(id).map(revision => {
            const revisionId = revision.id;
            const risk = db.prepare('SELECT * FROM risk_assessments WHERE change_revision_id=? ORDER BY rowid DESC LIMIT 1').get(revisionId) ?? null;
            const plans = db.prepare('SELECT * FROM verification_plans WHERE change_revision_id=? ORDER BY revision_no').all(revisionId);
            const planIds = plans.map(plan => plan.id);
            const criteria = planIds.flatMap(planId => db.prepare('SELECT * FROM plan_criteria WHERE plan_id=? ORDER BY code').all(planId));
            const results = planIds.flatMap(planId => db.prepare('SELECT * FROM criterion_results WHERE plan_id=? ORDER BY criterion_code').all(planId));
            const deviations = planIds.flatMap(planId => db.prepare('SELECT * FROM deviations WHERE plan_id=? ORDER BY recorded_at,id').all(planId));
            const evidence = db.prepare('SELECT * FROM evidence_items WHERE change_revision_id=? ORDER BY recorded_at,id')
                .all(revisionId).map(item => evidenceDetail(db, item));
            const overrides = risk ? db.prepare('SELECT * FROM risk_overrides WHERE assessment_id=? ORDER BY recorded_at,id')
                .all(risk.id) : [];
            const reviews = db.prepare('SELECT * FROM reviews WHERE change_revision_id=? ORDER BY reviewed_at,id').all(revisionId);
            const acceptances = db.prepare('SELECT * FROM acceptances WHERE change_revision_id=? ORDER BY accepted_at,id')
                .all(revisionId).map(acceptance => ({ ...acceptance,
                    status: getAcceptanceStatus(db, acceptance.id, now),
                    classification: db.prepare('SELECT * FROM legacy_acceptance_classifications WHERE acceptance_id=?')
                        .get(acceptance.id) ?? null,
                    expiryEvent: db.prepare('SELECT * FROM conditional_acceptance_expiries WHERE acceptance_id=?')
                        .get(acceptance.id) ?? null }));
            const effectivenessChecks = db.prepare(`SELECT * FROM effectiveness_checks
                WHERE change_revision_id=? ORDER BY recorded_at,id`).all(revisionId);
            return { revision, risk, overrides, plans, criteria, results,
                deviations, evidence, reviews, acceptances, effectivenessChecks };
        });
    const current = revisions.find(item => item.revision.revision_no === change.current_revision_no);
    const audit = db.prepare(`
        SELECT sequence,id,dataset_instance_id,actor_id,system_principal_id,simulated_role,entity_type,
            entity_id,entity_revision_id,action,recorded_at,prior_state,new_state,
            reason,payload_json,payload_sha256,previous_digest,digest FROM audit_events
        WHERE entity_type='change' AND entity_id=? ORDER BY sequence
    `).all(id).map(row => ({ ...row, payload: JSON.parse(row.payload_json), payload_json: undefined }));
    return { change, ...current, revisions, audit, serverNowUtc: now };
}

function incidentDetail(db, id) {
    const incident = db.prepare('SELECT * FROM incidents WHERE id=?').get(id);
    if (!incident) return null;
    const revisions = db.prepare('SELECT * FROM incident_revisions WHERE incident_id=? ORDER BY revision_no')
        .all(id);
    const audit = db.prepare(`SELECT sequence,id,dataset_instance_id,actor_id,simulated_role,
        entity_type,entity_id,entity_revision_id,action,recorded_at,prior_state,new_state,
        reason,payload_json,payload_sha256,previous_digest,digest FROM audit_events
        WHERE entity_type='incident' AND entity_id=? ORDER BY sequence`).all(id)
        .map(row => ({ ...row, payload: JSON.parse(row.payload_json), payload_json: undefined }));
    const origin = audit.find(item => item.action === 'incident-created')?.payload ?? null;
    const detectionEvent = origin?.detectionEventId ?
        db.prepare('SELECT * FROM equipment_events WHERE id=?').get(origin.detectionEventId) ?? null : null;
    const lkgObservations = db.prepare(`SELECT l.* FROM lkg_observations l
        JOIN incident_revisions r ON r.id=l.incident_revision_id
        WHERE r.incident_id=? ORDER BY l.recorded_at,l.id`).all(id);
    const traceProposals = db.prepare(`SELECT p.* FROM trace_proposals p
        JOIN incident_revisions r ON r.id=p.incident_revision_id
        WHERE r.incident_id=? ORDER BY p.proposed_at,p.id`).all(id).map(row => {
        const candidates = db.prepare('SELECT * FROM trace_candidates WHERE proposal_id=? ORDER BY lot_id')
            .all(row.id).map(candidate => ({ ...candidate,
                details: JSON.parse(candidate.details_json), details_json: undefined }));
        const scopeReview = db.prepare('SELECT * FROM scope_reviews WHERE proposal_id=?')
            .get(row.id) ?? null;
        const scopeDecisions = scopeReview ? db.prepare(`SELECT * FROM scope_decisions
            WHERE review_id=? ORDER BY lot_id`).all(scopeReview.id) : [];
        return { ...row, query: JSON.parse(row.query_json), result: JSON.parse(row.result_json),
            resultDigest: row.result_digest, query_json: undefined, result_json: undefined,
            candidates, scopeReview, scopeDecisions };
    });
    const proposal = traceProposals.at(-1) ?? null;
    const containment = audit.filter(item => item.action === 'incident-contained')
        .map(item => ({ recordedAt: item.recorded_at, actorId: item.actor_id,
            reason: item.reason, ...item.payload }));
    const capaCycles = db.prepare('SELECT * FROM incident_cycles WHERE incident_id=? ORDER BY cycle_no').all(id);
    const effectivenessChecks = db.prepare(`SELECT * FROM incident_effectiveness_checks
        WHERE incident_id=? ORDER BY evaluated_at,id`).all(id).map(row => ({ ...row,
            source: JSON.parse(row.source_json), source_json: undefined }));
    const cycleDecisions = db.prepare(`SELECT * FROM incident_cycle_decisions
        WHERE incident_id=? ORDER BY decided_at,id`).all(id);
    const recurrenceEvidence = db.prepare(`SELECT c.cycle_id,
        c.id AS prior_close_id,d.id AS defect_id,d.defect_count,
        a.id AS aoi_inspection_id,a.inspected_at,r.id AS process_run_id,r.lot_id
        FROM incident_cycle_decisions c
        JOIN aoi_defects d ON d.defect_code_id=? AND d.defect_count>0
        JOIN aoi_inspections a ON a.id=d.aoi_inspection_id
        JOIN process_runs r ON r.id=a.process_run_id
        WHERE c.incident_id=? AND c.decision='Closed'
            AND r.equipment_id=? AND r.module_id=?
            AND a.inspected_at>c.decided_at
            AND NOT EXISTS (SELECT 1 FROM incident_cycle_decisions later
                WHERE later.incident_id=c.incident_id AND later.decision='Closed'
                    AND later.decided_at>c.decided_at
                    AND later.decided_at<a.inspected_at)
        ORDER BY c.cycle_id,a.inspected_at,d.id`)
        .all(incident.defect_code_id, id, incident.equipment_id, incident.module_id);
    const causeAssessments = db.prepare('SELECT * FROM cause_assessments WHERE incident_id=? ORDER BY assessed_at,id').all(id);
    const capaActions = db.prepare('SELECT * FROM capa_actions WHERE incident_id=? ORDER BY created_at,id').all(id)
        .map(row => ({ ...row, review: db.prepare('SELECT * FROM capa_action_reviews WHERE action_id=?')
            .get(row.id) ?? null }));
    const documentFeedback = db.prepare('SELECT * FROM feedback_actions WHERE incident_id=? ORDER BY proposed_at,id').all(id)
        .map(row => ({ ...row, review: db.prepare('SELECT * FROM feedback_reviews WHERE feedback_id=?')
            .get(row.id) ?? null }));
    const controlledDocuments = db.prepare(`SELECT * FROM controlled_documents
        WHERE scope_equipment_id=? AND defect_code_id=? ORDER BY doc_type,id`)
        .all(incident.equipment_id, incident.defect_code_id).map(row => ({ ...row,
            revisions: db.prepare(`SELECT v.*,f.incident_id AS source_incident_id,
                f.cycle_id AS source_cycle_id FROM document_revisions v
                LEFT JOIN feedback_actions f ON f.id=v.source_feedback_id
                WHERE v.document_id=? ORDER BY v.revision_no`)
                .all(row.id) }));
    return { incident, revisions, detectionEvent,
        observedLotId: origin?.observedLotId ?? null,
        observedRunId: origin?.observedRunId ?? null,
        recipeRevisionId: origin?.recipeRevisionId ?? null,
        containment, lkg: lkgObservations.at(-1) ?? null, lkgObservations,
        proposal, traceProposals, candidates: proposal?.candidates ?? [],
        scopeReview: proposal?.scopeReview ?? null,
        scopeDecisions: proposal?.scopeDecisions ?? [], capaCycles,
        effectivenessChecks, cycleDecisions, recurrenceEvidence, causeAssessments,
        capaActions, documentFeedback, controlledDocuments, audit };
}

export function createLocalServer(db, { assetsDir, clock = () => new Date().toISOString() } = {}) {
    if (!db || typeof db.prepare !== 'function') throw new TypeError('Local SQLite database is required');
    if (typeof assetsDir !== 'string' || !isAbsolute(assetsDir)) {
        throw new TypeError('An absolute bundled-assets directory is required');
    }
    if (typeof clock !== 'function') throw new TypeError('A server clock function is required');
    const serverNow = () => {
        const now = clock();
        if (typeof now !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(now) ||
            !Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now) {
            throw new Error('Server clock must provide canonical UTC');
        }
        return now;
    };
    const bundledStatic = Object.freeze(Object.fromEntries(
        Object.entries(staticFiles).map(([path, [filename, contentType]]) => [
            path, [readFileSync(join(assetsDir, filename)), contentType]
        ])
    ));
    return createServer(async (req, res) => {
        try {
            const address = req.socket.localAddress;
            const port = req.socket.localPort;
            const expectedHost = `127.0.0.1:${port}`;
            if (address !== '127.0.0.1' || req.headers.host !== expectedHost) {
                reject(res, 403, 'LOCAL_ONLY', 'FabAssure accepts loopback requests only');
                return;
            }
            if (typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.startsWith('//')) {
                reject(res, 400, 'BAD_PATH', 'A local path is required');
                return;
            }
            const url = new URL(req.url, `http://${expectedHost}`);
            const pathname = url.pathname;
            if (req.method === 'POST' && pathname === '/api/actions') {
                if (req.headers['x-fabassure-local'] !== '1' ||
                    (req.headers.origin && req.headers.origin !== `http://${expectedHost}`)) {
                    reject(res, 403, 'LOCAL_ACTION_REQUIRED', 'A same-origin local action is required');
                    return;
                }
                const { action, input } = await readAction(req);
                const now = serverNow();
                let result;
                try {
                    reconcileConditionalAcceptances(db, now);
                    const serverInput = { ...input, serverNow: now };
                    result = actions[action](db, serverInput);
                } catch (error) {
                    rejectActionError(res, error);
                    return;
                }
                send(res, 200, { result });
                return;
            }
            if (req.method !== 'GET') {
                reject(res, 405, 'METHOD_NOT_ALLOWED', 'This local route does not support that method');
                return;
            }
            const now = serverNow();
            if (pathname === '/api/health') {
                const dataset = db.prepare('SELECT id FROM dataset_instances WHERE slot=1').get();
                send(res, 200, { status: 'ok', offline: true,
                    datasetInstanceId: dataset?.id ?? null, host: '127.0.0.1' });
                return;
            }
            if (pathname === '/api/bootstrap') {
                reconcileConditionalAcceptances(db, now);
                const dataset = db.prepare('SELECT id FROM dataset_instances WHERE slot=1').get();
                const actors = db.prepare('SELECT id,role,display_name FROM demo_actors ORDER BY role,id').all();
                const changes = db.prepare(`
                    SELECT id,title,state,current_revision_no,equipment_id,module_id,
                        recipe_revision_id,updated_at FROM changes ORDER BY updated_at DESC,id
                `).all();
                const incidents = db.prepare(`SELECT id,title,state,defect_code_id,equipment_id,
                    module_id,detected_at,updated_at FROM incidents ORDER BY updated_at DESC,id`).all();
                send(res, 200, { datasetInstanceId: dataset?.id ?? null,
                    synthetic: true, offline: true, actors, metrics: getDemoMetrics(db),
                    changes, incidents, incidentCount: incidents.length });
                return;
            }
            if (pathname === '/api/equipment') {
                send(res, 200, { synthetic: true, equipment: getEquipmentRegister(db) });
                return;
            }
            if (pathname.startsWith('/api/equipment/')) {
                const id = pathname.slice('/api/equipment/'.length);
                if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(id)) {
                    reject(res, 400, 'BAD_EQUIPMENT_ID', 'A valid synthetic equipment ID is required');
                    return;
                }
                const detail = getEquipmentTimeline(db, id);
                if (!detail) reject(res, 404, 'NOT_FOUND', 'Equipment record was not found');
                else send(res, 200, detail);
                return;
            }
            if (pathname.startsWith('/api/changes/')) {
                reconcileConditionalAcceptances(db, now);
                const id = pathname.slice('/api/changes/'.length);
                if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(id)) {
                    reject(res, 400, 'BAD_CHANGE_ID', 'A valid synthetic change ID is required');
                    return;
                }
                const detail = changeDetail(db, id, now);
                if (!detail) reject(res, 404, 'NOT_FOUND', 'Change record was not found');
                else send(res, 200, detail);
                return;
            }
            if (pathname.startsWith('/api/incidents/')) {
                const id = pathname.slice('/api/incidents/'.length);
                if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(id)) {
                    reject(res, 400, 'BAD_INCIDENT_ID', 'A valid synthetic incident ID is required');
                    return;
                }
                const detail = incidentDetail(db, id);
                if (!detail) reject(res, 404, 'NOT_FOUND', 'Incident record was not found');
                else send(res, 200, detail);
                return;
            }
            const asset = Object.hasOwn(bundledStatic, pathname) ? bundledStatic[pathname] : null;
            if (asset) {
                send(res, 200, asset[0], asset[1]);
                return;
            }
            reject(res, 404, 'NOT_FOUND', 'Local route was not found');
        } catch (error) {
            if ([400, 413, 415].includes(error?.status)) {
                reject(res, error.status, 'BAD_REQUEST', error.message);
            } else {
                reject(res, 500, 'LOCAL_ERROR', 'A local request failed');
            }
        }
    });
}

export function listenLocal(server, port = 4310) {
    if (!server || typeof server.listen !== 'function') throw new TypeError('HTTP server is required');
    if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new RangeError('Port is invalid');
    return new Promise((resolve, reject) => {
        const onError = error => {
            server.off('listening', onListening);
            reject(error.code === 'EADDRINUSE'
                ? new Error(`FabAssure port ${port} is already in use on 127.0.0.1`) : error);
        };
        const onListening = () => {
            server.off('error', onError);
            const actualPort = server.address().port;
            resolve({ host: '127.0.0.1', port: actualPort,
                url: `http://127.0.0.1:${actualPort}` });
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen({ host: '127.0.0.1', port, exclusive: true });
    });
}
