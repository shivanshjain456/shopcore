/**
 * GSTIN validation per Indian format:
 *   - 15 characters
 *   - chars 1-2  : state code (digits, 01-37)
 *   - chars 3-12 : PAN of entity (5 letters, 4 digits, 1 letter)
 *   - char  13   : entity number for the PAN (alphanumeric)
 *   - char  14   : 'Z' (fixed)
 *   - char  15   : checksum (alphanumeric)
 *
 * We also verify the GSTIN checksum using NPCI/GSTN algorithm.
 *
 * PAN validation per format: 5 letters, 4 digits, 1 letter (10 chars total).
 */

const STATE_CODES = new Set(
  Array.from({ length: 37 }, (_, i) => String(i + 1).padStart(2, '0')),
);

const CODEPOINT_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function gstinChecksum(first14: string): string {
  // Reference: https://docs.ewaybillgst.gov.in/Documents/checksumalgorithm.pdf
  const factors = [1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2];
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const c = first14[i];
    const idx = CODEPOINT_CHARS.indexOf(c);
    if (idx < 0) return '';
    const prod = idx * factors[i];
    sum += Math.floor(prod / 36) + (prod % 36);
  }
  const remainder = sum % 36;
  const checkIdx = (36 - remainder) % 36;
  return CODEPOINT_CHARS[checkIdx];
}

export function isValidGstin(raw: string): boolean {
  if (typeof raw !== 'string') return false;
  const s = raw.trim().toUpperCase();
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(s)) return false;
  if (!STATE_CODES.has(s.slice(0, 2))) return false;
  const expected = gstinChecksum(s.slice(0, 14));
  return expected === s[14];
}

export function isValidPan(raw: string): boolean {
  if (typeof raw !== 'string') return false;
  return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(raw.trim().toUpperCase());
}

export function panFromGstin(gstin: string): string {
  // chars 3-12 of a GSTIN are the PAN of the holder
  return gstin.trim().toUpperCase().slice(2, 12);
}

export function normaliseGstin(raw: string): string { return raw.trim().toUpperCase(); }
export function normalisePan(raw: string):  string { return raw.trim().toUpperCase(); }
