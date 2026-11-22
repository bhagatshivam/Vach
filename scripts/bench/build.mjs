// Bundles a benchmark entry (TypeScript, extensionless imports) into one ESM
// file that plain `node` can run. Dependencies stay external and are resolved
// from the repo's node_modules.
//
//   node scripts/bench/build.mjs <tree-root> <entry-name> <out-dir>
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const [treeRoot, entryName, outDir] = process.argv.slice(2).map((p, i) => (i === 1 ? p : resolve(p)));
const require = createRequire(resolve(treeRoot, 'package.json'));
const { build } = await import(pathToFileURL(require.resolve('vite')).href);
const react = (await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href)).default;

await build({
  root: treeRoot,
  configFile: false,
  logLevel: 'warn',
  plugins: [react()],
  build: {
    ssr: resolve(treeRoot, 'scripts/bench', `${entryName}.${entryName === 'entry-render' ? 'tsx' : 'ts'}`),
    outDir,
    emptyOutDir: true,
    minify: false,
    target: 'node22',
    rollupOptions: { output: { entryFileNames: `${entryName}.mjs`, format: 'es' } },
  },
});
console.log(`built ${entryName} -> ${outDir}`);
