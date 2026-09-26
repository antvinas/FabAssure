import { createHash, randomUUID } from 'node:crypto';
import { Socket } from 'node:net';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
    readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAppliance } from './main.mjs';

const defaultRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const nodeVersion = 'v24.19.0';
const nodeArchiveHash = '57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73';
const nodeExecutableHash = '3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237';
const required = Object.freeze([
    'src/server/main.mjs', 'src/server/http.mjs', 'src/server/appliance-lock.mjs',
    'src/server/reset.mjs', 'src/server/offline-verify.mjs',
    'src/data/db.mjs', 'src/data/seed.mjs', 'src/data/schema.sql',
    'src/data/schema-v2.sql', 'src/data/schema-v3.sql', 'src/data/schema-v4.sql',
    'src/data/schema-v5.sql',
    'src/data/schema-v6.sql',
    'src/data/schema-v7.sql',
    'src/data/schema-v8.sql',
    'src/data/schema-v9.sql',
    'src/domain/capa-service.mjs', 'src/domain/document-service.mjs',
    'src/domain/change-effectiveness-service.mjs',
    'src/domain/change-effectiveness-source.mjs',
    'src/domain/incident-effectiveness-service.mjs',
    'assets/ui/index.html', 'assets/ui/app.js', 'assets/ui/styles.css',
    'start-fabassure.cmd', 'reset-demo.cmd', 'verify-offline.cmd',
    'README_FIRST_KO.md'
]);

function inside(parent, target) {
    const path = relative(parent, target);
    return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

function listFiles(directory, prefix = '') {
    return readdirSync(directory, { withFileTypes: true }).flatMap(item => {
        const name = prefix ? `${prefix}/${item.name}` : item.name;
        if (item.isSymbolicLink()) throw new Error(`Portable runtime contains a linked path: ${name}`);
        if (item.isDirectory()) return listFiles(join(directory, item.name), name);
        if (!item.isFile()) throw new Error(`Portable runtime contains an unsupported entry: ${name}`);
        return [name];
    });
}

function assertPlainFile(root, path) {
    if (!/^[A-Za-z0-9._/-]+$/.test(path) || path.startsWith('/') || path.split('/').includes('..') ||
        path.includes('//') || path.includes('\\')) throw new Error(`Unsafe runtime manifest path: ${path}`);
    const full = join(root, ...path.split('/'));
    const item = lstatSync(full, { throwIfNoEntry: false });
    if (!item?.isFile() || item.isSymbolicLink() || !inside(root, realpathSync(full))) {
        throw new Error(`Runtime file is missing, linked or outside the portable root: ${path}`);
    }
    return full;
}

function assertNoRemoteReference(path, bytes) {
    if (!/\.(?:mjs|js|html|css|cmd|sql|json|md)$/.test(path)) {
        throw new Error(`Unsupported runtime source format: ${path}`);
    }
    let content = bytes.toString('utf8');
    if (path === 'src/server/http.mjs') {
        if (!content.includes('const expectedHost = `127.0.0.1:${port}`') ||
            !content.includes("address !== '127.0.0.1'") ||
            !content.includes("server.listen({ host: '127.0.0.1', port, exclusive: true })")) {
            throw new Error('Local HTTP endpoint construction changed');
        }
        const localScheme = ['http', ':', '/', '/'].join('');
        content = content.replaceAll(localScheme + '${expectedHost}', localScheme + '127.0.0.1:4310')
            .replaceAll(localScheme + '127.0.0.1:${actualPort}', localScheme + '127.0.0.1:4310');
    }
    const urlPattern = /\b(?:https?|wss?):\/\/[^\s"'<>`]+/gi;
    const urls = content.match(urlPattern) ?? [];
    for (const value of urls) {
        let parsed;
        try { parsed = new URL(value); } catch { throw new Error(`Invalid runtime URL in ${path}`); }
        if (parsed.protocol !== ['http', ':'].join('') || parsed.hostname !== '127.0.0.1' ||
            parsed.port !== '4310' || parsed.username || parsed.password) {
            throw new Error(`External network URL in runtime file: ${path}`);
        }
    }
    const withoutLocalUrls = content.replace(urlPattern, '');
    if (/\b(?:https?|wss?):/i.test(withoutLocalUrls) ||
        /["'`]\s*\/\/[A-Za-z0-9.-]+/i.test(withoutLocalUrls) ||
        /(?:url\(\s*|@import\s+)(?:["']\s*)?\/\/[A-Za-z0-9.-]+/i.test(withoutLocalUrls)) {
        throw new Error(`External or assembled network scheme in runtime file: ${path}`);
    }
    if (/\[\s*["'`]fetch["'`]\s*\]\s*\(/i.test(content)) {
        throw new Error(`Computed network fetch call in runtime file: ${path}`);
    }
    if (/\b(?:globalThis|window|self)\s*(?:\?\.)?\s*\[/.test(content)) {
        throw new Error(`Computed global network access in runtime file: ${path}`);
    }
    const expectedFetchCount = path === 'assets/ui/app.js' ? 1 :
        path === 'src/server/offline-verify.mjs' ? 3 : 0;
    const fetchCount = (content.match(/\bfetch\s*\(/g) ?? []).length;
    if (fetchCount !== expectedFetchCount) {
        throw new Error(`Unexpected network fetch call site in runtime file: ${path}`);
    }
    if (path !== 'src/server/offline-verify.mjs') {
        const networkImports = [...content.matchAll(/from\s+['"]node:(https?|net|tls|dns|dgram|child_process)['"]/g)]
            .map(match => match[1]);
        const expectedImport = path === 'src/server/http.mjs' ? 'http' :
            path === 'src/server/appliance-lock.mjs' ? 'net' : null;
        if (JSON.stringify(networkImports) !== JSON.stringify(expectedImport ? [expectedImport] : []) ||
            /\b(?:XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/.test(content)) {
            throw new Error(`Unexpected network API in runtime file: ${path}`);
        }
    }
    if (/(?:\bsk-[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b)/.test(content)) {
        throw new Error(`Credential-shaped text in runtime file: ${path}`);
    }
}

function assertDataLayout(realRoot) {
    const data = join(realRoot, 'data');
    const state = lstatSync(data, { throwIfNoEntry: false });
    if (!state) return;
    if (!state.isDirectory() || state.isSymbolicLink()) throw new Error('Unexpected linked data directory');
    const allowed = new Set(['fabassure-demo.sqlite', 'offline-verification.json', 'backups']);
    for (const item of readdirSync(data, { withFileTypes: true })) {
        if (!allowed.has(item.name) || item.isSymbolicLink()) {
            throw new Error(`Unexpected data file in portable runtime: ${item.name}`);
        }
        if (item.name === 'backups') {
            if (!item.isDirectory()) throw new Error('SQLite backups entry is not a directory');
            for (const backup of readdirSync(join(data, 'backups'), { withFileTypes: true })) {
                if (!backup.isFile() || backup.isSymbolicLink() ||
                    !/^fabassure-demo-[A-Za-z0-9-]+\.sqlite(?:\.pending)?$/.test(backup.name)) {
                    throw new Error(`Unexpected local backup entry: ${backup.name}`);
                }
            }
        } else if (!item.isFile()) {
            throw new Error(`Unexpected data entry type: ${item.name}`);
        }
    }
}

export function auditRuntimeBundle(root = defaultRoot) {
    if (typeof root !== 'string' || !root) throw new TypeError('Portable root is required');
    const realRoot = realpathSync(resolve(root));
    const allowedTop = new Set(['src', 'assets', 'runtime', 'data', 'manifest.json',
        'start-fabassure.cmd', 'reset-demo.cmd', 'verify-offline.cmd',
        'README_FIRST_KO.md']);
    for (const item of readdirSync(realRoot, { withFileTypes: true })) {
        if (!allowedTop.has(item.name) || item.isSymbolicLink()) {
            throw new Error(`Unexpected or linked portable root entry: ${item.name}`);
        }
    }
    assertDataLayout(realRoot);
    const runtimeDir = join(realRoot, 'runtime');
    if (JSON.stringify(listFiles(runtimeDir).sort()) !== JSON.stringify(['LICENSE', 'node.exe'])) {
        throw new Error('Bundled runtime contents differ from the pinned Node release');
    }
    if (sha256(readFileSync(assertPlainFile(realRoot, 'runtime/node.exe'))) !== nodeExecutableHash ||
        !readFileSync(assertPlainFile(realRoot, 'runtime/LICENSE'), 'utf8').includes('Node.js')) {
        throw new Error('Bundled Node runtime or license failed the pinned release check');
    }
    const manifestFile = assertPlainFile(realRoot, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    if (manifest.product !== 'FabAssure' || manifest.description !== 'Synthetic offline demonstration' ||
        manifest.nodeVersion !== nodeVersion || manifest.nodeArchiveSha256 !== nodeArchiveHash ||
        !Array.isArray(manifest.files)) throw new Error('Portable runtime manifest identity is invalid');
    const entries = new Map();
    for (const entry of manifest.files) {
        if (!entry || typeof entry.path !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
            entries.has(entry.path)) throw new Error('Portable runtime manifest has duplicate or invalid entries');
        entries.set(entry.path, entry.sha256);
    }
    for (const path of required) {
        if (!entries.has(path)) throw new Error(`Required runtime file absent from manifest: ${path}`);
    }
    const shipped = [
        ...listFiles(join(realRoot, 'src'), 'src'),
        ...listFiles(join(realRoot, 'assets', 'ui'), 'assets/ui'),
        'start-fabassure.cmd', 'reset-demo.cmd', 'verify-offline.cmd',
        'README_FIRST_KO.md'
    ].sort();
    const allAssets = listFiles(join(realRoot, 'assets')).sort();
    if (JSON.stringify(allAssets) !== JSON.stringify(shipped.filter(path => path.startsWith('assets/'))
        .map(path => path.slice('assets/'.length)).sort())) {
        throw new Error('Unexpected or unlisted asset in portable runtime');
    }
    if (JSON.stringify(shipped) !== JSON.stringify([...entries.keys()].sort())) {
        throw new Error('Portable runtime contains an unlisted file or omits a listed file');
    }
    for (const [path, expected] of entries) {
        const bytes = readFileSync(assertPlainFile(realRoot, path));
        if (sha256(bytes) !== expected) throw new Error(`Runtime file digest mismatch: ${path}`);
        assertNoRemoteReference(path, bytes);
    }
    for (const forbidden of ['.harness', '.codex', 'node_modules', 'tests', 'docs', 'assets/samples']) {
        if (existsSync(join(realRoot, forbidden))) throw new Error(`Development content entered runtime: ${forbidden}`);
    }
    return { fileCount: entries.size, manifestSha256: sha256(readFileSync(manifestFile)) };
}

function installOutboundDeny() {
    const original = Socket.prototype.connect;
    let denied = 0;
    Socket.prototype.connect = function (...args) {
        const first = Array.isArray(args[0]) ? args[0][0] : args[0];
        const host = first && typeof first === 'object' ? first.host ?? first.hostname :
            typeof args[1] === 'string' ? args[1] : null;
        if (host !== '127.0.0.1') {
            denied++;
            throw new Error('Outbound socket denied by the offline verifier');
        }
        return original.apply(this, args);
    };
    return { get denied() { return denied; }, restore() { Socket.prototype.connect = original; } };
}

async function localJson(url) {
    const response = await fetch(url);
    if (response.status !== 200) throw new Error(`Local probe failed with HTTP ${response.status}`);
    return response.json();
}

async function call(local, action, input, expected = 200) {
    const response = await fetch(`${local.url}/api/actions`, { method: 'POST', headers: {
        'content-type': 'application/json', 'x-fabassure-local': '1', origin: local.url
    }, body: JSON.stringify({ action, input }) });
    const body = await response.json();
    if (response.status !== expected) throw new Error(`Local ${action} returned HTTP ${response.status}: ${body.error?.code ?? 'unknown'}`);
    return body;
}

const at = (day, time) => `2026-08-${String(day).padStart(2, '0')}T${time}.000Z`;
const suffix = day => String(day).padStart(3, '0');
const riskInputs = Object.freeze({
    severity: 2, occurrence: 1, detectability: 2, scope: 1,
    criticalCharacteristic: true, safetyRelevance: false,
    bases: {
        severity: 'Synthetic alignment impact', occurrence: 'Three synthetic baseline lots',
        detectability: 'AOI and sampled alignment', scope: 'One module and recipe',
        criticalCharacteristic: 'ALIGN-X demo critical characteristic',
        safetyRelevance: 'No synthetic safety impact'
    }
});

async function runScenarioA(local) {
    const changeId = 'CHG-OFFLINE-PROOF';
    const base = (actorId, expectedRevisionNo) => ({ changeId, actorId, expectedRevisionNo });
    await call(local, 'createChange', { id: changeId, title: 'Synthetic offline recipe verification',
        actorId: 'ACT-MFG', lineId: 'LINE-A', equipmentId: 'EQ-ALIGN-A',
        moduleId: 'MOD-ALIGN-A', recipeRevisionId: 'REC-ALIGN-R2',
        baselineRef: 'AOI-A-001', reason: 'Synthetic controlled improvement', at: at(5, '12:00:00') });
    await call(local, 'submitChange', { ...base('ACT-MFG', 1), at: at(5, '12:10:00') });
    await call(local, 'classifyChange', { ...base('ACT-Q1', 1), assessmentId: 'RISK-OFF-R1',
        riskInputs, at: at(5, '12:20:00') });
    await call(local, 'approvePlan', { ...base('ACT-Q1', 1), planId: 'PLAN-OFF-R1', at: at(5, '12:30:00') });
    await call(local, 'startVerification', { ...base('ACT-VER', 1), at: at(6, '08:00:00') });
    await call(local, 'recordBaselineSet', { ...base('ACT-VER', 1), evidenceId: 'EVID-OFF-R1-BASE', at: at(6, '08:01:00') });
    await call(local, 'addMeasurementEvidence', { ...base('ACT-VER', 1),
        evidenceId: 'EVID-OFF-R1-FAIL', measurementId: 'MEAS-A-006-07', at: at(6, '10:01:00') });
    const failed = await call(local, 'recordAlignmentResult', { ...base('ACT-VER', 1),
        resultId: 'RESULT-OFF-R1-FAIL', evidenceId: 'EVID-OFF-R1-FAIL', at: at(6, '10:02:00') });
    if (failed.result.passed !== false) throw new Error('The 0.10 mm source result did not fail');
    await call(local, 'reviseFailedChange', { ...base('ACT-MFG', 1),
        failedResultId: 'RESULT-OFF-R1-FAIL', newRecipeRevisionId: 'REC-ALIGN-R3',
        reason: 'Correct the synthetic R2 offset', at: at(7, '12:00:00') });
    await call(local, 'submitChange', { ...base('ACT-MFG', 2), at: at(7, '12:10:00') });
    await call(local, 'classifyChange', { ...base('ACT-Q1', 2), assessmentId: 'RISK-OFF-R2',
        riskInputs, at: at(7, '12:20:00') });
    await call(local, 'approvePlan', { ...base('ACT-Q1', 2), planId: 'PLAN-OFF-R2', at: at(7, '12:30:00') });
    await call(local, 'startVerification', { ...base('ACT-VER', 2), at: at(8, '08:00:00') });
    await call(local, 'recordBaselineSet', { ...base('ACT-VER', 2), evidenceId: 'EVID-OFF-R2-BASE', at: at(8, '08:01:00') });
    for (let day = 8; day <= 12; day++) {
        for (let unit = 1; unit <= 20; unit++) {
            const unitSuffix = String(unit).padStart(2, '0');
            await call(local, 'addMeasurementEvidence', { ...base('ACT-VER', 2),
                evidenceId: `EVID-OFF-R2-${suffix(day)}-${unitSuffix}`,
                measurementId: `MEAS-A-${suffix(day)}-${unitSuffix}`, at: at(day, '10:01:00') });
        }
        await call(local, 'addAoiEvidence', { ...base('ACT-VER', 2),
            evidenceId: `EVID-OFF-R2-AOI-${suffix(day)}`,
            inspectionId: `AOI-A-${suffix(day)}`, at: at(day, '10:31:00') });
    }
    await call(local, 'recordAlignmentResult', { ...base('ACT-VER', 2),
        resultId: 'RESULT-OFF-R2-ALIGN', evidenceId: 'EVID-OFF-R2-012-20', at: at(12, '12:01:00') });
    await call(local, 'recordAoiResults', { ...base('ACT-VER', 2),
        resultPrefix: 'RESULT-OFF-R2-AOI', at: at(12, '12:02:00') });
    await call(local, 'markEvidenceReady', { ...base('ACT-VER', 2), at: at(12, '12:03:00') });
    await call(local, 'beginIndependentReview', { ...base('ACT-REV', 2), at: at(12, '12:04:00') });
    await call(local, 'recordIndependentReview', { ...base('ACT-REV', 2),
        reviewId: 'REVIEW-OFF-R2', decision: 'Pass',
        reason: 'Synthetic source and criteria reconciled', at: at(12, '12:05:00') });
    await call(local, 'acceptChange', { ...base('ACT-APP', 2),
        acceptanceId: 'ACCEPT-OFF-R2', reviewId: 'REVIEW-OFF-R2',
        reason: 'Synthetic independent acceptance', at: at(12, '12:06:00'),
        acceptanceType: 'Ordinary' });
    const detail = await localJson(`${local.url}/api/changes/${changeId}`);
    if (detail.change.state !== 'Accepted' || detail.revisions.length !== 2 ||
        detail.revisions[0].results[0]?.passed !== 0 || detail.revisions[1].evidence.length !== 106 ||
        detail.revisions[1].acceptances[0]?.frozen_digest !== detail.revisions[1].reviews[0]?.evidence_set_digest) {
        throw new Error('Offline Scenario A acceptance lineage is incomplete');
    }
    return { changeId, revisionCount: 2, evidenceCount: 106,
        acceptedDigest: detail.revisions[1].acceptances[0].frozen_digest };
}

function saveReport(root, report) {
    const realRoot = realpathSync(resolve(root));
    const data = join(realRoot, 'data');
    const dataEntry = lstatSync(data, { throwIfNoEntry: false });
    if (dataEntry?.isSymbolicLink() || (dataEntry && !dataEntry.isDirectory())) {
        throw new Error('Offline report data directory must be an ordinary local directory');
    }
    if (!dataEntry) mkdirSync(data);
    if (!inside(realRoot, realpathSync(data))) throw new Error('Offline report data directory escaped portable root');
    const final = join(data, 'offline-verification.json');
    const existing = lstatSync(final, { throwIfNoEntry: false });
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
        throw new Error('Offline report path must be an ordinary local file');
    }
    const staged = join(data, `.offline-verification-${randomUUID()}.json`);
    writeFileSync(staged, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    renameSync(staged, final);
}

export async function verifyOffline({ root = defaultRoot, port = 4310 } = {}) {
    const checks = [];
    let stage = 'bundle-integrity';
    try {
        const audited = auditRuntimeBundle(root);
        checks.push({ id: stage, status: 'pass', fileCount: audited.fileCount,
            manifestSha256: audited.manifestSha256 });
        stage = 'runtime-version';
        if (process.version !== nodeVersion) throw new Error(`Expected bundled Node ${nodeVersion}`);
        checks.push({ id: stage, status: 'pass', nodeVersion: process.version });
        stage = 'outbound-denied';
        const guard = installOutboundDeny();
        let probeRoot;
        let local;
        try {
            const socket = new Socket();
            try {
                try { socket.connect({ host: 'external.invalid', port: 443 }); }
                catch (error) {
                    if (!/Outbound socket denied/.test(error.message)) throw error;
                }
            } finally { socket.destroy(); }
            if (guard.denied !== 1) throw new Error('Outbound socket denial did not engage');
            checks.push({ id: stage, status: 'pass', rejectedSocketAttempts: guard.denied });
            stage = 'loopback-assets';
            probeRoot = mkdtempSync(join(tmpdir(), 'fabassure-offline-probe-'));
            const ui = join(probeRoot, 'assets', 'ui');
            mkdirSync(ui, { recursive: true });
            for (const name of ['index.html', 'app.js', 'styles.css']) {
                copyFileSync(join(root, 'assets', 'ui', name), join(ui, name));
            }
            local = await startAppliance({ root: probeRoot, port });
            if (local.host !== '127.0.0.1') throw new Error('Appliance did not bind exact loopback host');
            for (const path of ['/', '/app.js', '/styles.css']) {
                const response = await fetch(`${local.url}${path}`).catch(error => {
                    throw new Error(`Local asset request failed: ${error.cause?.message ?? error.message}`);
                });
                if (response.status !== 200 || !(await response.text()).length) {
                    throw new Error(`Local bundled asset failed: ${path}`);
                }
            }
            const bootstrap = await localJson(`${local.url}/api/bootstrap`);
            if (bootstrap.synthetic !== true || bootstrap.offline !== true ||
                bootstrap.metrics?.inspectedUnits !== 4500) {
                throw new Error('Synthetic offline bootstrap did not reconcile');
            }
            checks.push({ id: stage, status: 'pass', host: local.host, port: local.port,
                localAssets: ['/', '/app.js', '/styles.css'] });
            stage = 'scenario-a-acceptance';
            const scenario = await runScenarioA(local);
            checks.push({ id: stage, status: 'pass', ...scenario });
        } finally {
            try { await local?.close(); } finally {
                guard.restore();
                if (probeRoot) {
                    const temp = realpathSync(tmpdir());
                    if (!inside(temp, realpathSync(probeRoot))) throw new Error('Offline probe cleanup path escaped the temporary root');
                    rmSync(probeRoot, { recursive: true, force: true });
                }
            }
        }
    } catch (error) {
        checks.push({ id: stage, status: 'fail', message: String(error?.message ?? 'Offline verification failed').slice(0, 300) });
    }
    const report = { product: 'FabAssure', synthetic: true, verifiedAtUtc: new Date().toISOString(),
        status: checks.every(check => check.status === 'pass') ? 'pass' : 'fail', checks };
    saveReport(root, report);
    return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const expected = join(defaultRoot, 'runtime', 'node.exe');
    if (process.platform !== 'win32' || !existsSync(expected) ||
        realpathSync(process.execPath).toLowerCase() !== realpathSync(expected).toLowerCase()) {
        process.stderr.write('FabAssure offline verifier requires its bundled Windows Node runtime.\n');
        process.exitCode = 2;
    } else {
        verifyOffline().then(report => {
            process.stdout.write(JSON.stringify(report) + '\n');
            process.exitCode = report.status === 'pass' ? 0 : 1;
        }).catch(error => {
            process.stderr.write(`FabAssure offline verifier failed: ${error.message}\n`);
            process.exitCode = 2;
        });
    }
}
