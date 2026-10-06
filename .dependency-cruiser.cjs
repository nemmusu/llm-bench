/**
 * Architecture boundaries (checked by `npm run depcruise`):
 *  - contract: pure schemas, imports nothing but zod
 *  - core: never imports electron, main, preload or renderer
 *  - renderer: only contract + its own files (talks to the core over HTTP)
 *  - main/preload: never import core or renderer code (the core runs in its own process)
 */
module.exports = {
  forbidden: [
    {
      name: 'contract-is-pure',
      severity: 'error',
      from: { path: '^src/contract' },
      to: { path: '^src/(core|main|preload|renderer)' },
    },
    {
      name: 'core-no-electron',
      severity: 'error',
      from: { path: '^src/core' },
      to: { path: '(^src/(main|preload|renderer))|(^electron$)|node_modules/electron/' },
    },
    {
      name: 'renderer-only-contract',
      severity: 'error',
      from: { path: '^src/renderer' },
      to: { path: '^src/(core|main|preload)' },
    },
    {
      name: 'shell-no-core',
      severity: 'error',
      from: { path: '^src/(main|preload)' },
      to: { path: '^src/(core|renderer)' },
    },
    { name: 'no-circular', severity: 'warn', from: {}, to: { circular: true } },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    exclude: { path: '\\.d\\.ts$' },
  },
};
