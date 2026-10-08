export type ParsedQuery<T = string> = Record<string, T | null | (T | null)[]>;
export function stringify(params: Record<string, unknown>, options?: { sort?: false }): string;
export function parse(query: string): ParsedQuery;
