/**
 * Floating-number bounds at run time. A Gremlin `Float` rides as the Double of its decimal (`0.1f` is the
 * REAL 0.1, `src/gremlin/float.ts`) and is rounded to float32 only by the wire framer, so nothing here
 * spells single precision; a BigDecimal widening of a Double is the JS framer's (`bigDecimalOfCarrier`).
 */

/** `Float.MAX_VALUE`. */
export const FLOAT_MAX = 3.4028234663852886e38;
/** The least magnitude `Math.fround` carries to an infinity: `Float.MAX_VALUE` plus half its ulp. A Float
 *  result at or past it frames as a Double (`commonNumberClass`), never as an infinity. */
export const FLOAT_OVERFLOW = 3.4028235677973366e38;
