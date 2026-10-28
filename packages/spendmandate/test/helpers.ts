import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
// Never let a test reach the owner's real Claude Code or Codex config.
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;
delete process.env.TAPVOW_HOME;
delete process.env.SPENDMANDATE_HOME;


const dirs: string[] = [];

export function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "tapvow-"));
  dirs.push(d);
  return d;
}

export function cleanupTmp(): void {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
}

export function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const s = statSync(path);
    if (s.isDirectory()) out.push(...walkFiles(path));
    else if (s.isFile()) out.push(path);
  }
  return out;
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function fileHash(path: string): string {
  return sha256(readFileSync(path));
}

export function treeHash(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of walkFiles(dir)) out[relative(dir, file)] = fileHash(file);
  return out;
}

export function envValue(file: string, name: string): string | null {
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    const plain = `${name}=`;
    const exported = `export ${name}=`;
    if (line.startsWith(plain)) return line.slice(plain.length);
    if (line.startsWith(exported)) return line.slice(exported.length);
  }
  return null;
}
