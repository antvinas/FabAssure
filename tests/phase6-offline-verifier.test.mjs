import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditRuntimeBundle, verifyOffline } from '../src/server/offline-verify.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const archiveHash = '57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73';
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');

function filesUnder(root, path = root) {
    return readdirSync(path, { withFileTypes: true }).flatMap(item => {
        const full = join(path, item.name);
        return item.isDirectory() ? filesUnder(root, full) :
            [relative(root, full).replaceAll('\\', '/')];
    });
}

function manifest(root) {
    const files = [
        ...filesUnder(join(root, 'src')).map(path => `src/${path}`),
        ...filesUnder(join(root, 'assets', 'ui')).map(path => `assets/ui/${path}`),
        'start-fabassure.cmd', 'reset-demo.cmd', 'verify-offline.cmd',
        'README_FIRST_KO.md'
    ].sort().map(path => ({ path, sha256: hash(join(root, path)) }));
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({
        product: 'FabAssure', description: 'Synthetic offline demonstration',
        nodeVersion: 'v24.19.0', nodeArchiveSha256: archiveHash, files
    }));
}

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'fabassure offline proof-'));
    cpSync(join(repository, 'src'), join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'assets'), { recursive: true });
    cpSync(join(repository, 'assets', 'ui'), join(root, 'assets', 'ui'), { recursive: true });
    for (const name of ['start-fabassure.cmd', 'reset-demo.cmd',
        'verify-offline.cmd', 'README_FIRST_KO.md']) {
        cpSync(join(repository, name), join(root, name));
    }
    mkdirSync(join(root, 'runtime'));
    try { linkSync(process.execPath, join(root, 'runtime', 'node.exe')); }
    catch { copyFileSync(process.execPath, join(root, 'runtime', 'node.exe')); }
    writeFileSync(join(root, 'runtime', 'LICENSE'), 'Node.js synthetic verifier test license fixture');
    manifest(root);
    return { root, cleanup() {
        assert.ok(relative(resolve(tmpdir()), resolve(root)) && !relative(resolve(tmpdir()), resolve(root)).startsWith('..'));
        rmSync(root, { recursive: true, force: true });
    } };
}

test('portable manifest covers the runtime files and rejects a validly hashed remote asset', () => {
    const item = fixture();
    try {
        const clean = auditRuntimeBundle(item.root);
        assert.ok(clean.fileCount > 15);
        const index = join(item.root, 'assets', 'ui', 'index.html');
        writeFileSync(index, readFileSync(index, 'utf8') + '\n<script src="https://remote.invalid/app.js"></script>');
        manifest(item.root);
        assert.throws(() => auditRuntimeBundle(item.root), /external|remote|network|URL/i);
    } finally {
        item.cleanup();
    }
});

test('portable Korean guide is included in the manifest and cannot add a remote link', () => {
    const item = fixture();
    try {
        const guide = join(item.root, 'README_FIRST_KO.md');
        assert.match(readFileSync(guide, 'utf8'), /127\.0\.0\.1:4310/);
        writeFileSync(guide, readFileSync(guide, 'utf8') +
            '\n[remote](https://remote.invalid/help)\n');
        manifest(item.root);
        assert.throws(() => auditRuntimeBundle(item.root), /external|network|URL/i);
    } finally {
        item.cleanup();
    }
});

test('runtime bundle cannot omit the active CAPA migration schema', () => {
    const item = fixture();
    try {
        const relativePath = 'src/data/schema-v4.sql';
        unlinkSync(join(item.root, relativePath));
        manifest(item.root);
        assert.throws(() => auditRuntimeBundle(item.root), /schema-v4|missing|required/i);
    } finally {
        item.cleanup();
    }
});

test('runtime bundle cannot omit the active Change effectiveness source guard', () => {
    const item = fixture();
    try {
        unlinkSync(join(item.root, 'src/data/schema-v7.sql'));
        manifest(item.root);
        assert.throws(() => auditRuntimeBundle(item.root),
            /schema-v7|missing|required/i);
    } finally {
        item.cleanup();
    }
});

test('runtime bundle cannot omit the active Incident closure migration', () => {
    const item = fixture();
    try {
        unlinkSync(join(item.root, 'src/data/schema-v9.sql'));
        manifest(item.root);
        assert.throws(() => auditRuntimeBundle(item.root),
            /schema-v9|missing|required/i);
    } finally {
        item.cleanup();
    }
});

test('runtime bundle cannot omit CAPA, Change/Incident effectiveness, or controlled-document decision services', () => {
    for (const relativePath of ['src/domain/capa-service.mjs',
        'src/domain/document-service.mjs', 'src/domain/incident-effectiveness-service.mjs',
        'src/domain/change-effectiveness-service.mjs',
        'src/domain/change-effectiveness-source.mjs']) {
        const item = fixture();
        try {
            unlinkSync(join(item.root, relativePath));
            manifest(item.root);
            assert.throws(() => auditRuntimeBundle(item.root),
                /required|missing|CAPA|document|service/i);
        } finally {
            item.cleanup();
        }
    }
});

test('manifest cannot omit a shipped source module even when remaining hashes are valid', () => {
    const item = fixture();
    try {
        const path = join(item.root, 'manifest.json');
        const data = JSON.parse(readFileSync(path, 'utf8'));
        data.files = data.files.filter(file => file.path !== 'src/server/main.mjs');
        writeFileSync(path, JSON.stringify(data));
        assert.throws(() => auditRuntimeBundle(item.root), /manifest|main\.mjs|unlisted/i);
    } finally {
        item.cleanup();
    }
});

test('static audit rejects configured endpoints in JSON and split scheme strings', () => {
    const item = fixture();
    try {
        const config = join(item.root, 'src', 'config.json');
        writeFileSync(config, JSON.stringify({ endpoint: 'https://remote.invalid/api' }));
        manifest(item.root);
        assert.throws(() => auditRuntimeBundle(item.root), /external|network|URL|unsupported/i);
        unlinkSync(config);
        const main = join(item.root, 'src', 'server', 'main.mjs');
        writeFileSync(main, readFileSync(main, 'utf8') + "\nconst configuredEndpoint = 'https:' + '//remote.invalid/api';\n");
        manifest(item.root);
        assert.throws(() => auditRuntimeBundle(item.root), /external|network|scheme|endpoint/i);
    } finally {
        item.cleanup();
    }
});

test('static audit rejects undeclared asset and data configuration files', () => {
    const item = fixture();
    try {
        const asset = join(item.root, 'assets', 'config.json');
        writeFileSync(asset, '{"endpoint":"remote"}');
        assert.throws(() => auditRuntimeBundle(item.root), /unlisted|unexpected|asset/i);
        unlinkSync(asset);
        mkdirSync(join(item.root, 'data'));
        writeFileSync(join(item.root, 'data', 'config.json'), '{"endpoint":"remote"}');
        assert.throws(() => auditRuntimeBundle(item.root), /unlisted|unexpected|data/i);
    } finally {
        item.cleanup();
    }
});

test('static audit rejects an added network call even when its address is assembled', () => {
    const item = fixture();
    try {
        const main = join(item.root, 'src', 'server', 'main.mjs');
        writeFileSync(main, readFileSync(main, 'utf8') + "\nfetch('ht' + 'tps://remote.invalid/api');\n");
        manifest(item.root);
        assert.throws(() => auditRuntimeBundle(item.root), /network|fetch|call site|sink/i);
    } finally {
        item.cleanup();
    }
});

test('static audit rejects a protocol-relative CSS import', () => {
    const item = fixture();
    try {
        const stylesheet = join(item.root, 'assets', 'ui', 'styles.css');
        writeFileSync(stylesheet, readFileSync(stylesheet, 'utf8') + '\n@import url(//remote.invalid/theme.css);\n');
        manifest(item.root);
        assert.throws(() => auditRuntimeBundle(item.root), /network|remote|scheme|import/i);
    } finally {
        item.cleanup();
    }
});

test('static audit rejects a computed browser fetch call', () => {
    const item = fixture();
    try {
        const app = join(item.root, 'assets', 'ui', 'app.js');
        writeFileSync(app, readFileSync(app, 'utf8') + "\nglobalThis['fetch']('ht' + 'tps://remote.invalid/api');\n");
        manifest(item.root);
        assert.throws(() => auditRuntimeBundle(item.root), /network|fetch|call site|sink/i);
    } finally {
        item.cleanup();
    }
});

test('static audit rejects a split computed browser fetch call', () => {
    const item = fixture();
    try {
        const app = join(item.root, 'assets', 'ui', 'app.js');
        writeFileSync(app, readFileSync(app, 'utf8') +
            "\nglobalThis['fe' + 'tch']('ht' + 'tps:' + '/' + '/remote.invalid/api');\n");
        manifest(item.root);
        assert.throws(() => auditRuntimeBundle(item.root), /network|fetch|call site|sink/i);
    } finally {
        item.cleanup();
    }
});

test('static audit rejects optional or aliased computed global network access', () => {
    const item = fixture();
    try {
        const app = join(item.root, 'assets', 'ui', 'app.js');
        const original = readFileSync(app, 'utf8');
        for (const expression of [
            "globalThis?.['fe' + 'tch']('ht' + 'tps:' + '/' + '/remote.invalid/api')",
            "const remote = globalThis['fe' + 'tch']; remote('ht' + 'tps:' + '/' + '/remote.invalid/api')"
        ]) {
            writeFileSync(app, `${original}\n${expression};\n`);
            manifest(item.root);
            assert.throws(() => auditRuntimeBundle(item.root), /network|computed|global/i);
        }
    } finally {
        item.cleanup();
    }
});

test('offline verifier proves loopback assets, denied outbound sockets and an accepted synthetic change', async () => {
    const item = fixture();
    try {
        const report = await verifyOffline({ root: item.root, port: 0 });
        assert.equal(report.status, 'pass', JSON.stringify(report));
        assert.equal(report.synthetic, true);
        assert.ok(report.checks.some(check => check.id === 'outbound-denied' && check.status === 'pass'));
        assert.ok(report.checks.some(check => check.id === 'scenario-a-acceptance' && check.status === 'pass'));
        assert.ok(report.checks.some(check => check.id === 'loopback-assets' && check.status === 'pass'));
        const onDisk = JSON.parse(readFileSync(join(item.root, 'data', 'offline-verification.json'), 'utf8'));
        assert.equal(onDisk.status, 'pass');
        assert.equal(readdirSync(join(item.root, 'data')).includes('fabassure-demo.sqlite'), false,
            'The verifier must not change the appliance demo dataset');
    } finally {
        item.cleanup();
    }
});

test('verify-offline.cmd uses bundled Node from a spaced path and reports a 4310 conflict', () => {
    const item = fixture();
    try {
        const run = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', join(item.root, 'verify-offline.cmd')], {
            cwd: tmpdir(), env: { ...process.env, PATH: '' }, encoding: 'utf8', timeout: 60000
        });
        const report = JSON.parse(readFileSync(join(item.root, 'data', 'offline-verification.json'), 'utf8'));
        assert.ok([0, 1].includes(run.status), `${run.stdout}\n${run.stderr}`);
        if (run.status === 0) {
            assert.equal(report.status, 'pass');
            assert.ok(report.checks.some(check => check.id === 'scenario-a-acceptance' && check.status === 'pass'));
        } else {
            assert.equal(report.status, 'fail');
            assert.ok(report.checks.some(check => check.id === 'loopback-assets' &&
                check.status === 'fail' && /port 4310 is already in use/.test(check.message)));
            assert.ok(report.checks.some(check => check.id === 'outbound-denied' && check.status === 'pass'));
        }
    } finally {
        item.cleanup();
    }
});
