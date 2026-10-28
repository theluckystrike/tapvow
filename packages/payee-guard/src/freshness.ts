import type { DatabaseSync } from "node:sqlite";

/**
 * Remembers the newest binding issued_at seen for each origin, so an older
 * signed binding cannot be replayed after the payee has rotated.
 */
export interface BindingFreshnessStore {
  newestIssuedAt(origin: string): string | null;
  record(origin: string, issuedAt: string): void;
}

export function isIssuedAtValid(issuedAt: string): boolean {
  return !Number.isNaN(Date.parse(issuedAt));
}

// A current value that does not parse is corrupt, not "newer": treat it as
// empty so the next record repairs it.
function isNewer(issuedAt: string, current: string | null): boolean {
  if (current === null || !isIssuedAtValid(current)) return true;
  return Date.parse(issuedAt) > Date.parse(current);
}

export class MemoryBindingFreshness implements BindingFreshnessStore {
  private readonly newest = new Map<string, string>();

  newestIssuedAt(origin: string): string | null {
    return this.newest.get(origin) ?? null;
  }

  record(origin: string, issuedAt: string): void {
    if (isNewer(issuedAt, this.newestIssuedAt(origin))) {
      this.newest.set(origin, issuedAt);
    }
  }
}

export class SqliteBindingFreshness implements BindingFreshnessStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS payee_binding_freshness (origin TEXT PRIMARY KEY, newest_issued_at TEXT NOT NULL)",
    );
  }

  newestIssuedAt(origin: string): string | null {
    const row = this.db
      .prepare("SELECT newest_issued_at AS newest FROM payee_binding_freshness WHERE origin = ?")
      .get(origin) as { newest: unknown } | undefined;
    if (row === undefined || typeof row.newest !== "string") return null;
    return row.newest;
  }

  record(origin: string, issuedAt: string): void {
    // One statement, so two gateway processes on the same database cannot
    // regress the value: the upsert raises it and never lowers it. julianday()
    // compares instants rather than strings ("...:00.5Z" > "...:00Z"). A stored
    // value that does not parse has a NULL julianday and is overwritten, which
    // repairs a corrupt row when a verified binding is recorded.
    this.db
      .prepare(
        "INSERT INTO payee_binding_freshness (origin, newest_issued_at) VALUES (?, ?) " +
          "ON CONFLICT(origin) DO UPDATE SET newest_issued_at = excluded.newest_issued_at " +
          "WHERE julianday(excluded.newest_issued_at) > julianday(payee_binding_freshness.newest_issued_at) " +
          "OR julianday(payee_binding_freshness.newest_issued_at) IS NULL",
      )
      .run(origin, issuedAt);
  }
}
