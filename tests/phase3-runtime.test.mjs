import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAppliance } from '../src/server/main.mjs';

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'fabassure-appliance-'));
    const assets = join(root, 'assets', 'ui');
    mkdirSync(assets, { recursive: true });
    for (const [name, content] of [
        ['index.html', '<!doctype html><title>FabAssure synthetic</title>'],
        ['app.js', 'window.fabDemo = true;'], ['styles.css', 'body{color:#123}']
    ]) writeFileSync(join(assets, name), content);
    return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('the shipped UI bundle starts from a portable copy and serves every local asset', async () => {
    const { root, cleanup } = fixture();
    let started;
    try {
        const source = fileURLToPath(new URL('../assets/ui/', import.meta.url));
        for (const name of ['index.html', 'app.js', 'styles.css']) {
            copyFileSync(join(source, name), join(root, 'assets', 'ui', name));
        }
        started = await startAppliance({ root, port: 0 });
        for (const path of ['/', '/app.js', '/styles.css']) {
            const response = await fetch(`${started.url}${path}`);
            assert.equal(response.status, 200);
            assert.ok((await response.text()).length > 100);
        }
    } finally {
        await started?.close();
        cleanup();
    }
});

test('portable appliance seeds a local SQLite file once and restarts on loopback without network', async () => {
    const { root, cleanup } = fixture();
    let first;
    let second;
    try {
        first = await startAppliance({ root, port: 0 });
        assert.equal(first.host, '127.0.0.1');
        const initial = await (await fetch(`${first.url}/api/bootstrap`)).json();
        assert.equal(initial.synthetic, true);
        assert.equal(initial.metrics.inspectedUnits, 4500);
        assert.match(initial.datasetInstanceId, /^DATASET-[A-Z0-9-]+$/);
        assert.ok(existsSync(join(root, 'data', 'fabassure-demo.sqlite')));
        assert.equal((await fetch(first.url)).status, 200);
        await first.close(); first = null;
        second = await startAppliance({ root, port: 0 });
        const restarted = await (await fetch(`${second.url}/api/bootstrap`)).json();
        assert.equal(restarted.datasetInstanceId, initial.datasetInstanceId);
        assert.equal(restarted.metrics.inspectedUnits, 4500);
    } finally {
        await second?.close();
        await first?.close();
        cleanup();
    }
});

test('port conflict fails clearly and leaves the original local appliance serving', async () => {
    const original = fixture();
    const contender = fixture();
    let first;
    try {
        first = await startAppliance({ root: original.root, port: 0 });
        await assert.rejects(() => startAppliance({ root: contender.root, port: first.port }), /already in use.*127\.0\.0\.1/i);
        assert.equal((await fetch(`${first.url}/api/health`)).status, 200);
    } finally {
        await first?.close();
        contender.cleanup();
        original.cleanup();
    }
});

test('portable root rejects a linked UI asset or data directory outside its folder', async t => {
    const { root, cleanup } = fixture();
    const external = mkdtempSync(join(tmpdir(), 'fabassure-external-'));
    let started;
    try {
        const externalUi = join(external, 'ui');
        mkdirSync(externalUi);
        for (const name of ['index.html', 'app.js', 'styles.css']) {
            writeFileSync(join(externalUi, name), '<title>Outside portable root</title>');
        }
        rmSync(join(root, 'assets', 'ui'), { recursive: true, force: true });
        try {
            symlinkSync(externalUi, join(root, 'assets', 'ui'), 'junction');
        } catch (error) {
            if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
                t.skip(`Windows symlink privilege unavailable: ${error.code}`);
                return;
            }
            throw error;
        }
        try {
            started = await startAppliance({ root, port: 0 });
            assert.fail('External linked UI asset was accepted');
        } catch (error) {
            assert.match(error.message, /asset.*root|symbolic link|outside/i);
        } finally {
            await started?.close(); started = null;
        }
        unlinkSync(join(root, 'assets', 'ui'));
        mkdirSync(join(root, 'assets', 'ui'));
        for (const name of ['index.html', 'app.js', 'styles.css']) {
            writeFileSync(join(root, 'assets', 'ui', name), '<title>FabAssure synthetic</title>');
        }
        symlinkSync(external, join(root, 'data'), 'junction');
        try {
            started = await startAppliance({ root, port: 0 });
            assert.fail('External linked data directory was accepted');
        } catch (error) {
            assert.match(error.message, /data.*root|symbolic link|outside/i);
        } finally {
            await started?.close(); started = null;
        }
    } finally {
        await started?.close();
        cleanup();
        rmSync(external, { recursive: true, force: true });
    }
});
