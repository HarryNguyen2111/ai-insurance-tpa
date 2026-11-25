import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import openapiTS, { astToString } from 'openapi-typescript';
import SwaggerParser from '@apidevtools/swagger-parser';
import { openapiSchemaToJsonSchema } from '@openapi-contrib/openapi-schema-to-json-schema';
const root = new URL('../', import.meta.url);
const source = new URL('../../../docs/ai-specs/02-openapi-contracts.yaml', import.meta.url);
const document = await SwaggerParser.validate(fileURLToPath(source));
const dereferenced = await SwaggerParser.dereference(structuredClone(document));
const headerParameters = dereferenced.paths['/internal/v1/webhooks/ai-result'].post.parameters;
const headerSchema = { type: 'object', additionalProperties: false, required: headerParameters.filter(p => p.required).map(p => p.name), properties: Object.fromEntries(headerParameters.map(p => [p.name, p.schema])) };
const schemas = Object.fromEntries(Object.entries(dereferenced.components.schemas)
  .filter(([name]) => name !== 'ExplainableEOBResponse')
  .map(([name, schema]) => [name, openapiSchemaToJsonSchema(schema)]));
schemas.AiCallbackHeaders = openapiSchemaToJsonSchema(headerSchema);
const files = {
  'src/generated.d.ts': astToString(await openapiTS(source)),
  'src/schemas.json': JSON.stringify(schemas, null, 2) + '\n',
};
for (const [name, value] of Object.entries(files)) {
  const target = new URL(name, root);
  if (process.argv.includes('--check')) {
    if (await readFile(target, 'utf8') !== value) throw new Error(`Generated drift: ${name}; run pnpm generate`);
  } else await writeFile(target, value);
}
