// Row-mapping helpers. PostgreSQL drivers differ in how they return JSONB and timestamp
// columns (node-pg parses JSONB to objects and timestamps to Date; some in-memory
// drivers hand back strings), so coerce defensively rather than assume one shape.

export function toJson<T = Record<string, unknown>>(value: unknown): T {
  if (value === null || value === undefined) return {} as T;
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

export function toJsonArray<T = unknown>(value: unknown): T[] {
  if (value === null || value === undefined) return [];
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

export function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(value as string);
}

export function orUndefined<T>(value: T | null | undefined): T | undefined {
  return value === null || value === undefined ? undefined : value;
}
