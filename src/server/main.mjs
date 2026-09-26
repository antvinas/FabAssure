import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../data/db.mjs';
import { seedDatabase } from '../data/seed.mjs';
import { acquireApplianceLock } from './appliance-lock.mjs';
import { createLocalServer, listenLocal } from './http.mjs';

const defaultRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

function inside(parent, target) {
    const path = relative(parent, target);
    return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export async function startAppliance({ root = defaultRoot, port = 4310 } = {}) {
    if (typeof root !== 'string' || !root) throw new TypeError('Appliance root is required');
    const localRoot = resolve(root);
    const realRoot = realpathSync(localRoot);
    const assetsDir = join(localRoot, 'assets', 'ui');
    const realAssetsDir = realpathSync(assetsDir);
    if (!inside(realRoot, realAssetsDir)) throw new Error('Bundled UI assets must stay inside the portable root');
    for (const name of ['index.html', 'app.js', 'styles.css']) {
        if (!existsSync(join(assetsDir, name))) {
            throw new Error(`Bundled UI asset is missing: ${name}`);
        }
        if (!inside(realAssetsDir, realpathSync(join(assetsDir, name)))) {
            throw new Error(`Bundled UI asset must stay inside the portable root: ${name}`);
        }
    }
    let lock;
    let db;
    let server;
    try {
        lock = await acquireApplianceLock(realRoot);
        const dataDir = join(localRoot, 'data');
        mkdirSync(dataDir, { recursive: true });
        const realDataDir = realpathSync(dataDir);
        if (!inside(realRoot, realDataDir)) throw new Error('SQLite data directory must stay inside the portable root');
        const dbFile = join(dataDir, 'fabassure-demo.sqlite');
        if (existsSync(dbFile) && !inside(realDataDir, realpathSync(dbFile))) {
            throw new Error('SQLite database file must stay inside the portable root');
        }
        db = openDatabase(dbFile);
        if (!db.prepare('SELECT id FROM dataset_instances WHERE slot=1').get()) {
            seedDatabase(db, { instanceId: `DATASET-${randomUUID().toUpperCase()}` });
        }
        server = createLocalServer(db, { assetsDir });
        const local = await listenLocal(server, port);
        let closePromise;
        return {
            ...local,
            close() {
                if (!closePromise) {
                    closePromise = (async () => {
                        try {
                            if (server.listening) await new Promise((done, fail) => server.close(error => error ? fail(error) : done()));
                        } finally {
                            try {
                                db.close();
                            } finally {
                                await lock.close();
                            }
                        }
                    })();
                }
                return closePromise;
            }
        };
    } catch (error) {
        const cleanupErrors = [];
        if (server?.listening) {
            try { await new Promise((done, fail) => server.close(closeError => closeError ? fail(closeError) : done())); }
            catch (closeError) { cleanupErrors.push(closeError); }
        }
        try { db?.close(); }
        catch (closeError) { cleanupErrors.push(closeError); }
        try { await lock?.close(); }
        catch (closeError) { cleanupErrors.push(closeError); }
        if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], 'FabAssure startup and cleanup failed');
        throw error;
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    startAppliance().then(local => {
        process.stdout.write(`FabAssure synthetic offline demo: ${local.url}\n`);
        const stop = () => { local.close().catch(error => {
            process.stderr.write(`${error.message}\n`);
            process.exitCode = 1;
        }); };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
    }).catch(error => {
        process.stderr.write(`FabAssure startup failed: ${error.message}\n`);
        process.exitCode = 1;
    });
}
