/**
 * Money helpers. All prices stored as integer PAISE to avoid float errors.
 * Display formatting uses Intl with en-IN locale.
 */
export const rupees = (paise: number): string =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(paise / 100);

export const paiseFromRupees = (rupeeStr: string | number): number => {
  const n = typeof rupeeStr === 'string' ? parseFloat(rupeeStr) : rupeeStr;
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
};
