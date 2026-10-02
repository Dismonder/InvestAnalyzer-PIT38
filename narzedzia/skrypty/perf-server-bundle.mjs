import * as esbuild from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { rootDir, tmpDir } from '../projectPaths.mjs';

const root = rootDir;
const outDir = path.join(tmpDir, 'perf-server-bundle');
const maxServerBundleKb = process.env.MAX_SERVER_BUNDLE_KB ? Number(process.env.MAX_SERVER_BUNDLE_KB) : 3000;
if (!Number.isFinite(maxServerBundleKb) || maxServerBundleKb <= 0) {
  throw new Error(`MAX_SERVER_BUNDLE_KB musi być skończoną liczbą dodatnią (otrzymano: ${process.env.MAX_SERVER_BUNDLE_KB}).`);
}

mkdirSync(outDir, { recursive: true });

const result = await esbuild.build({
  entryPoints: ['aplikacje/web/server.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  metafile: true,
  external: ['esbuild', 'lightningcss', 'lightningcss-*'],
});

const outputBytes = result.outputFiles.reduce((sum, file) => sum + file.contents.length, 0);
const inputRows = Object.entries(result.metafile.inputs)
  .map(([file, meta]) => ({
    file: file.replaceAll(path.sep, '/'),
    bytes: meta.bytes,
  }))
  .sort((a, b) => b.bytes - a.bytes);
const retiredDevInputs = inputRows.filter((row) => (
  row.file.includes('/node_modules/vite/') ||
  row.file.includes('/node_modules/rollup/')
));

writeFileSync(
  path.join(outDir, 'server-bundle-metafile.json'),
  JSON.stringify(result.metafile, null, 2),
  'utf8',
);

console.log('Server bundle performance summary:');
console.log(`  output: ${(outputBytes / 1024).toFixed(1)} kB`);
console.log('  largest inputs:');
for (const row of inputRows.slice(0, 20)) {
  console.log(`  ${row.file.padEnd(72)} ${(row.bytes / 1024).toFixed(1).padStart(8)} kB`);
}
console.log(`  metafile: ${path.relative(root, path.join(outDir, 'server-bundle-metafile.json')).replaceAll(path.sep, '/')}`);

if (outputBytes / 1024 > maxServerBundleKb) {
  console.error(`Server bundle performance gate failed: ${(outputBytes / 1024).toFixed(1)} kB > ${maxServerBundleKb} kB`);
  process.exit(1);
}

if (retiredDevInputs.length > 0) {
  console.error('Server bundle performance gate failed: production bundle includes dev-only Vite/Rollup inputs.');
  for (const row of retiredDevInputs.slice(0, 10)) {
    console.error(`  ${row.file}`);
  }
  process.exit(1);
}
