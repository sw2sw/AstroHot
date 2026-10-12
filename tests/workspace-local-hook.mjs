// Test-only: resolve workspace exports in this checkout when node_modules is shared.
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const packages = ['packages/backend', 'packages/contracts', 'industry'].map(dir => ({
  dir, pkg: JSON.parse(readFileSync(path.join(root, dir, 'package.json'), 'utf8')),
}));
registerHooks({ resolve(specifier, context, nextResolve) {
  for (const { dir, pkg } of packages) {
    if (!specifier.startsWith(pkg.name + '/')) continue;
    const key = './' + specifier.slice(pkg.name.length + 1);
    let target = pkg.exports[key];
    if (!target) for (const [pattern, value] of Object.entries(pkg.exports)) {
      if (pattern.endsWith('*') && key.startsWith(pattern.slice(0, -1))) target = value.replace('*', key.slice(pattern.length - 1));
    }
    if (typeof target === 'string') return nextResolve(pathToFileURL(path.join(root, dir, target)).href, context);
  }
  return nextResolve(specifier, context);
}});
