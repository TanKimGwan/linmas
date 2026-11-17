// Untrusted text (from capsules, receipts, manifests, policy packs, provider
// responses) is printed to a terminal only after unsafe characters are shown as
// visible \uXXXX escapes, so embedded text cannot drive the terminal, forge
// output lines, or visually disguise itself. Unsafe characters are:
// - C0 controls, DEL and C1 controls (ESC, BEL, CR, LF, CSI U+009B, NEL ...);
// - the line and paragraph separators U+2028/U+2029;
// - bidi controls (U+061C, U+200E/U+200F, U+202A-U+202E, U+2066-U+2069);
// - zero-width and invisible characters (U+00AD, U+034F, U+180E, U+200B-U+200D,
//   U+2060-U+2064, U+3164, U+FEFF, U+FFF9-U+FFFB);
// - tag characters (U+E0000-U+E007F) and lone surrogates.
// Other non-ASCII text, including paired surrogates (emoji, astral CJK), is
// printed as is. A ZWJ emoji sequence is shown as its parts with a visible
// \u200d between them, and a tag-based flag (for example England) as the black
// flag followed by its escaped tags. Astral characters are shown as \u{XXXXX}.
const INVISIBLE = '\\u00ad\\u034f\\u061c\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\u3164\\ufeff\\ufff9-\\ufffb\\u{e0000}-\\u{e007f}\\ud800-\\udfff';
const UNSAFE = new RegExp(`[\\u0000-\\u001f\\u007f-\\u009f${INVISIBLE}]`, 'gu');
// Multi-line free text (for example review evidence) keeps LF and TAB.
const UNSAFE_MULTILINE = new RegExp(`[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f${INVISIBLE}]`, 'gu');

export function terminalSafe(value, { multiline = false } = {}) {
  return String(value).replaceAll(multiline ? UNSAFE_MULTILINE : UNSAFE, escapeCharacter);
}

// Escape each line of a text report separately, so a value that carries its
// own line break shows it as \u000a instead of starting a new report line.
// Linmas's constant text never contains unsafe characters.
export function terminalSafeLines(lines) {
  return lines.map((line) => terminalSafe(line)).join('\n');
}

function escapeCharacter(character) {
  // With the u flag a lone surrogate matches on its own; a pair never does.
  const codePoint = character.codePointAt(0);
  return codePoint > 0xffff ? `\\u{${codePoint.toString(16)}}` : `\\u${codePoint.toString(16).padStart(4, '0')}`;
}
