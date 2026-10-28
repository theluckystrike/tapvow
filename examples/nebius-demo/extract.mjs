// Reads the files out of a model reply for the Nebius demo agent. No
// dependencies, so the agent stays a single `node agent.mjs`.
//
// Nemotron on Nebius Token Factory does not always answer in Markdown. In the
// replies recorded on 27 Oct 2026 it often wrote the files with no ``` fence
// at all, each one starting with a "// file: name" line. Other replies use
// fences with or without a language, a file name in the info string, or a
// label line above the fence. This parser accepts all of those.
import { basename } from "node:path";

const HEADER = /^[ \t]*(?:\/\/|#)[ \t]*file(?:name)?[ \t]*:[ \t]*`?([\w./-]+?)`?[ \t]*$/im;
const NAME_IN_TEXT = /([\w-]+(?:\.[\w-]+)*\.(?:mjs|cjs|js|ts|mts))\b/;

/**
 * The files in a reply, keyed by base name. Only names in `allowed` are kept.
 * `truncated` is true when a fenced block was opened and never closed (the
 * reply was cut, for example at max_tokens); such a block is not returned, so
 * a cut reply never overwrites a good file with half of one.
 *
 * @param {string} reply the assistant message content
 * @param {string[]} allowed file names the caller wants, in answer order
 * @returns {{ files: Record<string, string>, truncated: boolean }}
 */
export function extractFiles(reply, allowed) {
  const text = stripReasoning(String(reply ?? "")).replace(/\r\n?/g, "\n");
  const fenced = fencedBlocks(text, allowed);
  if (Object.keys(fenced.files).length > 0 || fenced.truncated) return fenced;
  return { files: headerSections(text, allowed), truncated: false };
}

/** Reasoning that leaked into the content, as <think>...</think> or a lone closing tag. */
export function stripReasoning(text) {
  let out = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  const close = out.lastIndexOf("</think>");
  if (close !== -1) out = out.slice(close + "</think>".length);
  return out.replace(/<think>[\s\S]*$/, "");
}

function fencedBlocks(text, allowed) {
  const files = {};
  const lines = text.split("\n");
  let truncated = false;
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^[ \t]*(`{3,}|~{3,})(.*)$/);
    if (!open) continue;
    const fence = open[1];
    const info = open[2];
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].trim();
      if (t.startsWith(fence[0].repeat(fence.length)) && /^(`{3,}|~{3,})$/.test(t)) {
        end = j;
        break;
      }
    }
    if (end === -1) {
      truncated = true;
      break;
    }
    const body = lines.slice(i + 1, end).join("\n") + "\n";
    const name = pickName(body, info, lines[i - 1] ?? "", lines[i - 2] ?? "", allowed, n);
    if (name) files[name] = body;
    n++;
    i = end;
  }
  return { files, truncated };
}

function pickName(body, info, above, above2, allowed, n) {
  const candidates = [body.match(HEADER)?.[1], info.match(NAME_IN_TEXT)?.[1], above.match(NAME_IN_TEXT)?.[1]];
  if (above.trim() === "") candidates.push(above2.match(NAME_IN_TEXT)?.[1]);
  for (const c of candidates) {
    if (!c) continue;
    const b = basename(c);
    if (allowed.includes(b)) return b;
  }
  // No usable name. Fall back to the answer order the prompt asked for, but
  // only for code, never for a shell or text block.
  if (/^\s*(sh|bash|shell|console|text|txt|json|diff)\b/i.test(info)) return null;
  return allowed[n] ?? null;
}

function headerSections(text, allowed) {
  const files = {};
  const lines = text.split("\n");
  const starts = [];
  lines.forEach((line, i) => {
    const m = line.match(HEADER);
    if (m) starts.push({ i, name: basename(m[1]) });
  });
  starts.forEach((s, k) => {
    if (!allowed.includes(s.name)) return;
    const stop = k + 1 < starts.length ? starts[k + 1].i : lines.length;
    const body = lines.slice(s.i, stop).join("\n").replace(/\s+$/, "") + "\n";
    files[s.name] = body;
  });
  return files;
}
