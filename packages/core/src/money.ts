const USD_RE = /^\d{1,9}(\.\d{1,6})?$/;

const MICROS_PER_USD = 1_000_000;

export function parseUsd(s: string): number {
  if (typeof s !== "string" || !USD_RE.test(s)) {
    throw new TypeError(`invalid USD string: ${JSON.stringify(s)}`);
  }
  const dot = s.indexOf(".");
  const whole = dot === -1 ? s : s.slice(0, dot);
  const frac = dot === -1 ? "" : s.slice(dot + 1);
  const micros = BigInt(whole) * BigInt(MICROS_PER_USD) + BigInt((frac + "000000").slice(0, 6));
  const result = Number(micros);
  if (!Number.isSafeInteger(result)) {
    throw new TypeError(`USD value out of range: ${s}`);
  }
  return result;
}

export function formatUsd(micros: number): string {
  if (!Number.isInteger(micros)) {
    throw new TypeError("micros must be an integer");
  }
  const negative = micros < 0;
  const abs = Math.abs(micros);
  const whole = Math.floor(abs / MICROS_PER_USD);
  const frac = abs % MICROS_PER_USD;
  return `${negative ? "-" : ""}${whole}.${String(frac).padStart(6, "0")}`;
}
