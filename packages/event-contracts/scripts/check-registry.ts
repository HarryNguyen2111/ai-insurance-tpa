// CI gate for the event schema registry (EVT-01 #23): immutable published versions,
// subject compatibility (BACKWARD_TRANSITIVE within a major), closed envelopes, no
// free-text strings, and exact parity with the OpenAPI-derived event components.
// Prints only registry coordinates and rule names, never event data.
import { readFileSync } from 'node:fs';
import { verifyRegistry } from '../src/index.ts';

const openapi = JSON.parse(readFileSync(new URL('../../shared-contracts/src/schemas.json', import.meta.url), 'utf8'));
const issues = verifyRegistry(undefined, openapi);
if (issues.length > 0) {
  for (const issue of issues) console.error(`event registry: ${issue.eventType}${issue.version ? '@' + issue.version : ''}: ${issue.problem}`);
  process.exitCode = 1;
} else {
  console.log('event registry: schemas immutable, compatible, closed, free-text-free and in OpenAPI parity');
}
