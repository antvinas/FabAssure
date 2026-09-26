import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAppliance } from '../src/server/main.mjs';

const mainEntry = fileURLToPath(new URL('../src/server/main.mjs', import.meta.url));

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'fabassure-start-lock-'));
    const ui = join(root, 'assets', 'ui');
    mkdirSync(ui, { recursive: true });
    for (const name of ['index.html', 'app.js', 'styles.css']) {
        writeFileSync(join(ui, name), name === 'index.html' ? '<!doctype html><title>FabAssure synthetic</title>' : '/* synthetic */');
    }
    return {
        root,
        cleanup() {
            assert.ok(resolve(root).startsWith(resolve(tmpdir())), 'Cleanup escaped temporary root');
            rmSync(root, { recursive: true, force: true });
        }
    };
}

test('a second appliance cannot open the same portable dataset while the first is active', async () => {
    const item = fixture();
    let first;
    let reopened;
    try {
        first = await startAppliance({ root: item.root, port: 0 });
        await assert.rejects(async () => {
            const duplicate = await startAppliance({ root: item.root, port: 0 });
            await duplicate.close();
        }, /already active|already using/i);
        assert.equal((await fetch(`${first.url}/api/health`)).status, 200);
        await first.close(); first = null;
        reopened = await startAppliance({ root: item.root, port: 0 });
        assert.equal((await fetch(`${reopened.url}/api/health`)).status, 200);
    } finally {
        await reopened?.close();
        await first?.close();
        item.cleanup();
    }
});

test('startup cleanup releases the folder lock even if SQLite close throws', () => {
    const firstItem = fixture();
    const secondItem = fixture();
    try {
        const script = join(firstItem.root, 'close-failure.mjs');
        writeFileSync(script, `import { DatabaseSync } from 'node:sqlite';\nimport { pathToFileURL } from 'node:url';\nconst { startAppliance } = await import(pathToFileURL(process.argv[2]).href);\nconst first = await startAppliance({ root: process.argv[3], port: 0 });\nconst original = DatabaseSync.prototype.close;\nlet injected = false;\nDatabaseSync.prototype.close = function () {\n    if (!injected) { injected = true; throw new Error('Injected SQLite close failure'); }\n    return original.call(this);\n};\ntry { await startAppliance({ root: process.argv[4], port: first.port }); } catch {}\nDatabaseSync.prototype.close = original;\nlet second;\ntry {\n    second = await startAppliance({ root: process.argv[4], port: 0 });\n    process.stdout.write('lock-released-after-close-error');\n} catch (error) {\n    process.stderr.write(error.message);\n    process.exitCode = 1;\n}\nawait second?.close();\nawait first.close();\nprocess.exit();\n`);
        const child = spawnSync(process.execPath, [script, mainEntry, firstItem.root, secondItem.root], {
            encoding: 'utf8', timeout: 30000
        });
        assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
        assert.match(child.stdout, /lock-released-after-close-error/);
    } finally {
        secondItem.cleanup();
        firstItem.cleanup();
    }
});

test('two appliance close callers both wait for the server and folder lock to finish closing', async () => {
    const item = fixture();
    const originalClose = HttpServer.prototype.close;
    let started;
    let reopened;
    let firstClose;
    HttpServer.prototype.close = function (callback) {
        return originalClose.call(this, error => setTimeout(() => callback?.(error), 80));
    };
    try {
        started = await startAppliance({ root: item.root, port: 0 });
        firstClose = started.close();
        await started.close();
        reopened = await startAppliance({ root: item.root, port: 0 });
        assert.equal((await fetch(`${reopened.url}/api/health`)).status, 200);
    } finally {
        await firstClose;
        await reopened?.close();
        await started?.close();
        HttpServer.prototype.close = originalClose;
        item.cleanup();
    }
});

test('startup port conflict releases the second portable folder lock', async () => {
    const firstItem = fixture();
    const secondItem = fixture();
    let first;
    let second;
    try {
        first = await startAppliance({ root: firstItem.root, port: 0 });
        await assert.rejects(() => startAppliance({ root: secondItem.root, port: first.port }), /already in use/i);
        second = await startAppliance({ root: secondItem.root, port: 0 });
        assert.equal((await fetch(`${second.url}/api/health`)).status, 200);
    } finally {
        await second?.close();
        await first?.close();
        secondItem.cleanup();
        firstItem.cleanup();
    }
});
