import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'miniprogram');
const dist = join(root, 'dist');
const output = join(dist, 'miniprogram');
const config = JSON.parse(await readFile(join(source, 'app.json'), 'utf8'));

const componentFiles = await readdir(join(source, 'components'), { recursive: true, withFileTypes: true });
const componentEntries = [];
for (const file of componentFiles) {
  if (!file.isFile() || !file.name.endsWith('.json')) continue;
  const path = join(file.parentPath, file.name);
  if (JSON.parse(await readFile(path, 'utf8')).component === true) {
    componentEntries.push(path.replace(/\.json$/, '.ts'));
  }
}

const apiBaseUrl = (process.env.SCANNER_API_BASE_URL ?? '').trim();
if (apiBaseUrl) {
  const url = new URL(apiBaseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('SCANNER_API_BASE_URL must be an HTTPS base URL without credentials, query or fragment');
  }
}

await mkdir(dist, { recursive: true });
const staging = await mkdtemp(join(dist, '.miniprogram-'));
try {
  await cp(source, staging, {
    recursive: true,
    filter: (path) => !path.endsWith('.ts'),
  });

  await build({
    absWorkingDir: root,
    entryPoints: [
      join(source, 'app.ts'),
      ...config.pages.map((page) => join(source, `${page}.ts`)),
      ...componentEntries,
      join(source, config.workers, 'image', 'index.ts'),
    ],
    outbase: source,
    outdir: staging,
    bundle: true,
    platform: 'browser',
    format: 'cjs',
    target: 'es2018',
    define: { SCANNER_API_BASE_URL: JSON.stringify(apiBaseUrl) },
    legalComments: 'eof',
    logLevel: 'info',
  });

  await rm(output, { recursive: true, force: true });
  await rename(staging, output);
} finally {
  await rm(staging, { recursive: true, force: true });
}
