// Money as decimal strings (KS-002's money rule; KS-004 re-review B2, C4). A
// JSON number is a binary float: a day's sum of them drifts, and its text form
// is the part of canonical JSON another language most often spells
// differently. So every USD amount the seat records or compares is a plain
// decimal string, and the arithmetic on it is exact, on scaled BigInts.
// Credits are whole numbers and stay numbers.

/**
 * A non-negative USD amount in its one spelling: no sign, exponent, leading
 * zero or trailing fractional zero, e.g. "0", "0.0421", "12.5". Unknown is
 * null, never a number nobody measured.
 */
export type Usd = string;

/** Fractional digits an amount may carry: far below any price, and enough that rounding up at the last never matters. */
const USD_PLACES = 18;
/** The canonical spelling, bounded so an amount is always one a ledger line can carry. */
const USD_PATTERN = /^(?:0|[1-9][0-9]{0,15})(?:\.[0-9]{0,17}[1-9])?$/;
/** What a person may write in a config: the same, but trailing fractional zeros are allowed and dropped. */
const USD_TEXT_PATTERN = /^(?:0|[1-9][0-9]{0,15})(?:\.[0-9]{1,18})?$/;

export function isUsd(v: unknown): v is Usd {
  return typeof v === "string" && USD_PATTERN.test(v);
}

/** A plain decimal a person wrote, in canonical form; null when it is not one. */
export function usdFromText(text: unknown): Usd | null {
  if (typeof text !== "string" || !USD_TEXT_PATTERN.test(text)) return null;
  return canonical(text);
}

/**
 * The amount a JSON number names. A number that came out of JSON.parse
 * prints as the shortest decimal that reads back to it, which is the text a
 * JavaScript writer put in the JSON, so this recovers that text exactly. Its
 * exponent form is spelled out. A cost summed in floats can print with more
 * fractional digits than an amount carries (0.003 + 0.0004 prints as
 * 0.0034000000000000002); it is still a cost that was measured, so it is
 * rounded up to 18 places, never down, and a ceiling read from it can only
 * count high. Anything negative, non-finite, not a number, or whole dollars
 * beyond the canonical bounds is null (unknown).
 */
export function usdFromNumber(n: unknown): Usd | null {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(String(n));
  if (!m) return null;
  const digits = m[1]! + (m[2] ?? "");
  // The position of the decimal point within `digits`, after the exponent moves it.
  const point = m[1]!.length + Number(m[3] ?? "0");
  let text: string;
  if (point <= 0) text = `0.${"0".repeat(-point)}${digits}`;
  else if (point >= digits.length) text = digits + "0".repeat(point - digits.length);
  else text = `${digits.slice(0, point)}.${digits.slice(point)}`;
  text = text.replace(/^0+(?=\d)/, "");
  const [whole, frac = ""] = text.split(".");
  if (frac.length > USD_PLACES) {
    const up = /[1-9]/.test(frac.slice(USD_PLACES)) ? 1n : 0n;
    text = spell(BigInt(whole! + frac.slice(0, USD_PLACES)) + up, USD_PLACES);
  }
  const out = canonical(text);
  return isUsd(out) ? out : null;
}

/** Drop trailing fractional zeros and a bare point. */
function canonical(text: string): string {
  if (!text.includes(".")) return text;
  return text.replace(/0+$/, "").replace(/\.$/, "");
}

function scaled(a: Usd): { n: bigint; scale: number } {
  if (!isUsd(a)) throw new Error("money: not a canonical USD amount");
  const [whole, frac = ""] = a.split(".");
  return { n: BigInt(whole! + frac), scale: frac.length };
}

function align(a: Usd, b: Usd): [bigint, bigint, number] {
  const x = scaled(a);
  const y = scaled(b);
  const scale = Math.max(x.scale, y.scale);
  return [x.n * 10n ** BigInt(scale - x.scale), y.n * 10n ** BigInt(scale - y.scale), scale];
}

/** n / 10^scale as plain decimal text, not yet checked against the bounds. */
function spell(n: bigint, scale: number): string {
  const s = n.toString().padStart(scale + 1, "0");
  return canonical(scale === 0 ? s : `${s.slice(0, -scale)}.${s.slice(-scale)}`);
}

function fromScaled(n: bigint, scale: number): Usd {
  if (n < 0n) throw new Error("money: a negative amount");
  const out = spell(n, scale);
  if (!isUsd(out)) throw new Error("money: the amount is beyond the canonical bounds");
  return out;
}

export function addUsd(a: Usd, b: Usd): Usd {
  const [x, y, scale] = align(a, b);
  return fromScaled(x + y, scale);
}

/** a - b, or "0" when b is the larger: what is left under a ceiling is never negative. */
export function subUsdFloor(a: Usd, b: Usd): Usd {
  const [x, y, scale] = align(a, b);
  return x > y ? fromScaled(x - y, scale) : "0";
}

/** -1, 0 or 1. */
export function compareUsd(a: Usd, b: Usd): -1 | 0 | 1 {
  const [x, y] = align(a, b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function minUsd(a: Usd, b: Usd): Usd {
  return compareUsd(a, b) <= 0 ? a : b;
}

export function maxUsd(a: Usd, b: Usd): Usd {
  return compareUsd(a, b) >= 0 ? a : b;
}

/** Rounded down to `places` fractional digits, so a bound derived from it is never above it. */
export function floorUsd(a: Usd, places: number): Usd {
  if (!isUsd(a)) throw new Error("money: not a canonical USD amount");
  const [whole, frac = ""] = a.split(".");
  return frac.length > places ? canonical(`${whole}.${frac.slice(0, places)}`) : a;
}
