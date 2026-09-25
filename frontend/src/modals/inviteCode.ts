/** Accept "AbCd1234", "https://host/invite/AbCd1234" or "host/invite/AbCd1234". */
export function extractCode(raw: string): string {
  const text = raw.trim();
  const m = /\/invite\/([A-Za-z0-9]+)/.exec(text);
  if (m) return m[1];
  return /^[A-Za-z0-9]{2,32}$/.test(text) ? text : '';
}
