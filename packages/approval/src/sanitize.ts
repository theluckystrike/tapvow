// Control characters (C0/C1) and the bidi overrides that can reorder text in a
// Telegram message or on the approval page. Stripped so an attacker-supplied
// summary cannot spoof what the owner reads.
// Also format characters (zero-width, direction marks, BOM), line and
// paragraph separators, and the blank Hangul filler, which could fake extra
// lines such as "Amount 0.01 USD" inside an agent-supplied URL.
const UNSAFE_RE = /[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}\u3164\u115f\u1160\uffa0]/gu;
export const FIELD_MAX = 64;

export function sanitize(input: unknown, max: number = FIELD_MAX): string {
  const out = String(input ?? "").replace(UNSAFE_RE, "");
  return [...out].slice(0, max).join("");
}
