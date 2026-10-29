// Search boxes accept literal text. PostgreSQL LIKE metacharacters in a client
// name or code must not broaden the user's search to unrelated companies.
export const literalContains = (value: string) =>
  `%${value.trim().replace(/[\\%_]/g, "\\$&")}%`;
