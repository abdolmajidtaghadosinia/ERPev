// Starts an isolated copy of the server: random free port, temp DATA_DIR (own database + uploads). Never touches live/readiness.db.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SERVER_JS, LIVE } from './bundle.mjs';

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function startServer({ env = {}, dataDir, port } = {}) {
  const ownsDir = !dataDir;
  dataDir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-test-'));
  port = port || await freePort();
  const srv = { port, dataDir, base: `http://127.0.0.1:${port}`, log: '', child: null };

  srv.start = async () => {
    srv.child = spawn(process.execPath, [SERVER_JS], {
      cwd: LIVE, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, ...env }
    });
    srv.child.stdout.on('data', d => { srv.log += d; });
    srv.child.stderr.on('data', d => { srv.log += d; });
    for (let i = 0; i < 100; i++) {
      if (srv.child.exitCode !== null) throw new Error('server exited early:\n' + srv.log);
      try { if ((await fetch(srv.base + '/api/health')).ok) return; } catch { /* not up yet */ }
      await sleep(150);
    }
    throw new Error('server did not start:\n' + srv.log);
  };
  srv.kill = async () => {
    const c = srv.child; if (!c || c.exitCode !== null) return;
    await new Promise(r => { c.once('exit', r); c.kill(); });
  };
  srv.restart = async () => { await srv.kill(); await srv.start(); };
  srv.stop = async () => { await srv.kill(); if (ownsDir) fs.rmSync(dataDir, { recursive: true, force: true }); };
  srv.db = () => new DatabaseSync(path.join(dataDir, 'readiness.db')); // direct access to the TEST database
  await srv.start();
  return srv;
}
