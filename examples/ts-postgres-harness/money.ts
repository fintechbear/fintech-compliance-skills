// FCS-MONEY-001: parse an amount string into integer minor units for its ISO 4217
// currency. Reject zero/negative/over-precision/overflow and unsupported currencies.
// Never use a binary float for money — parse the decimal string ourselves.

const MINOR_UNITS: Record<string, number> = {
  // exponent (number of decimal places) per ISO 4217 for the currencies this reference supports
  USD: 2, EUR: 2, GBP: 2, TRY: 2,
  JPY: 0,
  KWD: 3, BHD: 3, OMR: 3,
};

export class MoneyError extends Error {
  constructor(public readonly kind: string, msg: string) { super(msg); }
}

// Max money we allow, well inside a JS safe integer (2^53-1). An amount past this throws
// rather than silently wrapping — the .NET side uses checked long arithmetic for the same reason.
const MAX_MINOR = 9_000_000_000_000; // 9e12 minor units

export function toMinorUnits(amount: string, currency: string): number {
  const exp = MINOR_UNITS[currency];
  if (exp === undefined) throw new MoneyError('unsupported_currency', `unsupported currency ${currency}`);

  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!m) throw new MoneyError('bad_amount', `not a decimal: ${amount}`);
  const neg = m[1] === '-';
  const whole = m[2];
  const frac = m[3] ?? '';

  if (frac.length > exp) throw new MoneyError('over_precision', `${amount} has more precision than ${currency} allows (${exp})`);
  // pad fractional part to the currency exponent
  const fracPadded = frac.padEnd(exp, '0');
  const digits = whole + fracPadded;

  // overflow: refuse anything that would exceed our safe ceiling
  if (digits.length > 16) throw new MoneyError('overflow', `${amount} too large`);
  let minor = Number(digits);
  if (!Number.isSafeInteger(minor) || minor > MAX_MINOR) throw new MoneyError('overflow', `${amount} exceeds max`);
  if (neg) minor = -minor;

  if (minor <= 0) throw new MoneyError('non_positive', `amount must be positive: ${amount}`);
  return minor;
}

export function isSupported(currency: string): boolean {
  return MINOR_UNITS[currency] !== undefined;
}
