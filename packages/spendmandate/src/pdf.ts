import { formatUsd } from "@mandate/core";

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const MARGIN = 54;
const FONT_SIZE = 10;
const LEADING = 13.5;

function escapeText(s: string): string {
  let out = "";
  for (const ch of s) {
    if (ch === "\\") out += "\\\\";
    else if (ch === "(") out += "\\(";
    else if (ch === ")") out += "\\)";
    else {
      const code = ch.codePointAt(0) ?? 63;
      out += code < 32 || code > 126 ? "?" : ch;
    }
  }
  return out;
}

function num(n: number): string {
  return n.toFixed(2);
}

export interface PackViewEntry {
  seq: number;
  ts: string;
  kind: string;
  payload: string;
}

export interface PackView {
  mandate: { mandate: { id: string; budget: { total: string; period: string }; store_id?: string } };
  store_id: string;
  created_at: string;
  head: { seq: number; hash: string };
  totals: { settled_micros: number; calls_settled: number; calls_denied: number; approvals: number };
  entries: PackViewEntry[];
}

function payloadOf(payload: string): Record<string, unknown> {
  try {
    const v = JSON.parse(payload);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function amountMicrosOf(kind: string, p: Record<string, unknown>): number | null {
  if (kind.endsWith(".settle")) {
    const charged = p.charged_micros;
    return typeof charged === "number" ? charged : null;
  }
  const amount = p.amount_micros;
  return typeof amount === "number" ? amount : null;
}

function entryLine(entry: PackViewEntry): string {
  const p = payloadOf(entry.payload);
  const agent = text(p.agent_id) ?? "-";
  const target = text(p.payee) ?? text(p.provider) ?? text(p.model) ?? text(p.asset) ?? "-";
  const amount = amountMicrosOf(entry.kind, p);
  const usd = amount === null ? "-" : `${formatUsd(amount)} USD`;
  const detail = text(p.outcome) ?? text(p.code) ?? text(p.decision) ?? "";
  return `#${entry.seq} ${entry.ts} ${entry.kind} ${agent} ${target} ${usd}${detail ? " " + detail : ""}`;
}

export function pdfLinesForPack(pack: PackView, sha256: string): string[] {
  const mandate = pack.mandate.mandate;
  const lines: string[] = [
    "TapVow receipt pack",
    "",
    `Mandate ${mandate.id}`,
    `Store ${pack.store_id}`,
    `Budget ${mandate.budget.total} USD per ${mandate.budget.period}`,
    `Created ${pack.created_at}`,
    `Head seq ${pack.head.seq} hash ${pack.head.hash}`,
    `Totals settled ${formatUsd(pack.totals.settled_micros)} USD, calls settled ${pack.totals.calls_settled}, ` +
      `denials logged ${pack.totals.calls_denied}, approvals ${pack.totals.approvals}`,
    `SHA-256 of the JSON pack ${sha256}`,
    "",
    "Entries",
  ];
  for (const entry of pack.entries) lines.push(entryLine(entry));
  lines.push("");
  lines.push("The JSON pack is the verifiable record. This PDF is a human-readable summary.");
  return lines;
}

export function buildPdf(lines: string[]): Buffer {
  const usable = A4_HEIGHT - 2 * MARGIN;
  const perPage = Math.max(1, Math.floor(usable / LEADING));
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));
  if (pages.length === 0) pages.push([]);

  const firstBaseline = A4_HEIGHT - MARGIN - FONT_SIZE;
  const pageIds = pages.map((_, i) => 4 + 2 * i);
  const contentIds = pages.map((_, i) => 5 + 2 * i);
  const objectCount = 3 + 2 * pages.length;

  const chunks: Buffer[] = [];
  let offset = 0;
  const offsets: number[] = [];
  const push = (s: string): void => {
    const b = Buffer.from(s, "latin1");
    chunks.push(b);
    offset += b.length;
  };
  const beginObject = (id: number): void => {
    offsets[id] = offset;
    push(`${id} 0 obj\n`);
  };
  const endObject = (): void => {
    push("endobj\n");
  };

  push("%PDF-1.4\n");

  beginObject(1);
  push("<< /Type /Catalog /Pages 2 0 R >>\n");
  endObject();

  beginObject(2);
  push(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>\n`);
  endObject();

  beginObject(3);
  push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\n");
  endObject();

  pages.forEach((pageLines, i) => {
    const pageId = pageIds[i]!;
    const contentId = contentIds[i]!;
    const body: string[] = ["BT", `/F1 ${FONT_SIZE} Tf`, `${num(LEADING)} TL`, `${num(MARGIN)} ${num(firstBaseline)} Td`];
    pageLines.forEach((line, n) => {
      body.push(`(${escapeText(line)}) Tj`);
      if (n < pageLines.length - 1) body.push("T*");
    });
    body.push("ET");
    const content = body.join("\n") + "\n";

    beginObject(pageId);
    push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(A4_WIDTH)} ${num(A4_HEIGHT)}] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>\n`,
    );
    endObject();

    beginObject(contentId);
    push(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n`);
    push(content);
    push("endstream\n");
    endObject();
  });

  const xrefOffset = offset;
  push("xref\n");
  push(`0 ${objectCount + 1}\n`);
  push("0000000000 65535 f \n");
  for (let id = 1; id <= objectCount; id++) {
    push(`${String(offsets[id] ?? 0).padStart(10, "0")} 00000 n \n`);
  }
  push("trailer\n");
  push(`<< /Size ${objectCount + 1} /Root 1 0 R >>\n`);
  push("startxref\n");
  push(`${xrefOffset}\n`);
  push("%%EOF\n");

  return Buffer.concat(chunks);
}
