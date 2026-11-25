import { pgSchema } from 'drizzle-orm/pg-core';

// No business tables until their domain/RLS/constraints are implemented together.
export const applicationSchema = pgSchema('tpa');
