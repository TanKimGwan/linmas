// Untrusted text (from capsules, receipts, manifests) is printed to a terminal
// only after control characters are shown as visible \uXXXX escapes, so an
// embedded ESC/BEL/newline cannot drive the terminal or forge output lines.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

export function terminalSafe(value) {
  return String(value).replaceAll(CONTROL, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
