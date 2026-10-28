/**
 * Reads a TAPVOW_<suffix> environment variable first and falls back to the old
 * SPENDMANDATE_<suffix> name, so an existing install keeps working after the
 * rename. Returns undefined when neither is set or both are empty.
 */
export function envVar(name: string): string | undefined {
  for (const prefix of ["TAPVOW_", "SPENDMANDATE_"]) {
    const value = process.env[prefix + name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}
