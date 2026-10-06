#!/usr/bin/env node
// Standalone fake Hugging Face Hub for E2E runs:
//   node test/fakes/fake-hub/fake-hub.mjs [--port N] [--repos repos.json] [--token T]...
//        [--throttle BYTES_PER_SEC] [--drop-after BYTES --drop-times N] [--ttl MS]
// Prints one JSON line {"url": "...", "cdnUrl": "..."} on stdout when ready; stops on SIGINT/SIGTERM.
import { readFileSync } from 'node:fs';
import { startFakeHub } from './hub.mjs';

const args = process.argv.slice(2);
const opts = { behavior: {}, tokens: [] };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const next = () => args[++i];
  if (a === '--port') opts.port = Number(next());
  else if (a === '--repos') opts.repos = JSON.parse(readFileSync(next(), 'utf8'));
  else if (a === '--token') opts.tokens.push(next());
  else if (a === '--throttle') opts.behavior.throttleBytesPerSec = Number(next());
  else if (a === '--drop-after') opts.behavior.dropAfterBytes = Number(next());
  else if (a === '--drop-times') opts.behavior.dropTimes = Number(next());
  else if (a === '--ttl') opts.behavior.tokenTtlMs = Number(next());
  else {
    process.stderr.write(`unknown argument ${a}\n`);
    process.exit(2);
  }
}
if (opts.tokens.length === 0) delete opts.tokens;

const hub = await startFakeHub(opts);
process.stdout.write(`${JSON.stringify({ url: hub.url, cdnUrl: hub.cdnUrl })}\n`);
const stop = () => {
  void hub.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
