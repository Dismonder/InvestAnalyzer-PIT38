import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const credentialDir = process.env.FREEDOM24_CREDENTIALS_DIR || path.join(root, 'dane', 'API');
const pairs = [['public', 'private'], ['public key.txt', 'private key.txt']];
const pair = pairs.find(([pub, priv]) => fs.existsSync(path.join(credentialDir, pub)) && fs.existsSync(path.join(credentialDir, priv)));
if (!pair) {
  console.log('secret_scan_hits=0 (credentials unavailable; scan skipped)');
  process.exit(0);
}

// Values remain in this process only and are never interpolated into output.
const secrets = pair.map((name) => fs.readFileSync(path.join(credentialDir, name), 'utf8').trim()).filter(Boolean);
const candidates = new Set(execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean));
const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
for (const row of status.split(/\r?\n/)) if (row.startsWith('?? ')) candidates.add(row.slice(3));

function collect(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(full);
    else if (entry.isFile()) candidates.add(path.relative(root, full));
  }
}
collect(path.join(root, 'logs'));
collect(path.join(root, 'dane', 'logi'));
collect(path.join(root, 'jakosc'));

const excluded = new Set(pair.map((name) => path.resolve(credentialDir, name)));
const hits = [];
for (const relative of candidates) {
  const absolute = path.resolve(root, relative);
  if (excluded.has(absolute)) continue;
  try {
    const content = fs.readFileSync(absolute, 'utf8');
    if (secrets.some((secret) => content.includes(secret))) hits.push(relative.replaceAll('\\', '/'));
  } catch {
    // Non-text or unreadable files cannot disclose a value through this script.
  }
}
console.log(`secret_scan_hits=${hits.length}`);
for (const hit of hits) console.log(hit);
process.exit(hits.length === 0 ? 0 : 1);
