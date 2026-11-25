const Ajv = require('ajv-draft-04').default;
const addFormats = require('ajv-formats').default;
const schemas = require('./schemas.json');
const ajv = new Ajv({ allErrors: true, strict: true, coerceTypes: false, removeAdditional: false, useDefaults: false });
addFormats(ajv);
const validators = new Map(Object.entries(schemas).map(([name, schema]) => [name, ajv.compile(schema)]));
/** Validate without coercion, mutation, logging or echoing input. Authorization and business checks remain server obligations.
 * @param {keyof typeof schemas} name
 * @param {unknown} value
 * @returns {boolean}
 */
function validate(name, value) {
  const validator = validators.get(name);
  if (!validator) throw new Error('Unknown contract schema');
  return Boolean(validator(value));
}
exports.validate = validate;
