import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createServer } from 'node:net';

export async function acquireApplianceLock(root) {
    if (process.platform !== 'win32') throw new Error('Portable appliance lock supports Windows only');
    if (typeof root !== 'string' || !root) throw new TypeError('Portable root is required');
    const realRoot = realpathSync(root).toLowerCase();
    const digest = createHash('sha256').update(realRoot).digest('hex').slice(0, 32);
    const slash = String.fromCharCode(92);
    const endpoint = slash + slash + '.' + slash + 'pipe' + slash + 'FabAssure-' + digest;
    const server = createServer(socket => socket.destroy());
    try {
        await new Promise((resolve, reject) => {
            const onError = error => {
                server.off('listening', onListening);
                reject(error);
            };
            const onListening = () => {
                server.off('error', onError);
                resolve();
            };
            server.once('error', onError);
            server.once('listening', onListening);
            server.listen(endpoint);
        });
    } catch (error) {
        if (error.code === 'EADDRINUSE') {
            throw new Error('Another FabAssure process is already active for this portable folder');
        }
        throw error;
    }
    let closePromise;
    return Object.freeze({
        close() {
            if (!closePromise) {
                closePromise = server.listening
                    ? new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
                    : Promise.resolve();
            }
            return closePromise;
        }
    });
}
