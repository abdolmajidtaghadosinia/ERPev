// Loads the question bank and scoring module from the bundle, the same way server.js does, so tests exercise the real data.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const LIVE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SERVER_JS = path.join(LIVE, 'server.js');
const SOURCE = fs.readFileSync(path.join(LIVE, 'source.html'), 'utf8');

export function readAsset(uuid) {
  const tag = '<script type="__bundler/manifest">';
  const i = SOURCE.lastIndexOf(tag);
  const manifest = JSON.parse(SOURCE.slice(i + tag.length, SOURCE.indexOf('</script>', i)));
  const e = manifest[uuid];
  const raw = Buffer.from(e.data, 'base64');
  return (e.compressed ? zlib.gunzipSync(raw) : raw).toString('utf8');
}

export const BANK = JSON.parse(readAsset('e2df9d42-6527-44d8-ade3-e860f0aea4c6'));
export const SC = await import('data:text/javascript;base64,' + Buffer.from(readAsset('435712ec-76cb-45de-b1f1-56cd1a06843f')).toString('base64'));
export const QIDS = BANK.questions.map(q => q.id);

// Initial password given to new users, read from the server so tests never hard-code it.
export const DEFAULT_PW = /const DEFAULT_PW = '([^']+)'/.exec(fs.readFileSync(SERVER_JS, 'utf8'))[1];
