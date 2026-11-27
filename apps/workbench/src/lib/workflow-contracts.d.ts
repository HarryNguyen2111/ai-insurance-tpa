// The shared package currently exports a CommonJS validator without a declaration.
// Keep this adapter local to the designer; the generated schemas/types remain authoritative.
declare module '*.cjs' {
  export function validate(name: string, value: unknown): boolean;
}
