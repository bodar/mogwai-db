// ---------- math(): a scalar arithmetic expression → SQL ----------
//
// TinkerPop's `math("<formula>")` compiles a small arithmetic expression to a
// single scalar. It stays true to locked decision #3 (compile to SQL, never
// interpret): the formula becomes ONE SQL expression evaluated by SQLite, no
// per-row JS. `_` is the current traverser's value; a bare identifier (`a`, `b`,
// `expectedWeight`) is a variable bound by an as()/by() modulator — resolved by
// the caller through `resolveVar`. TinkerPop uses exp4j, whose function names are
// fixed and whose `log` is the NATURAL log; the operator/function surface below
// mirrors it. `math()` always yields a Double, so every leaf is coerced to REAL
// (literals emit `100.0`, variables wrap `CAST(… AS REAL)`) — that makes `/` real
// division (SQLite's `/` is integer division on integer operands) and `^`/`%` fall
// out via `POW`/`MOD` with no per-operator special-casing.

import { q, raw, type Expression } from './q.ts';

/** exp4j's built-in functions → SQL. All unary. `log` = natural log (→ `LN`);
 *  `signum`/`cbrt` have no SQLite builtin, so they expand inline. The math
 *  functions are provided by SQLite's math extension (verified present on both DO
 *  SQLite 3.47 and Bun 3.53). */
const FN: Record<string, (a: Expression) => Expression> = {
  abs: (a) => q`ABS(${a})`,
  ceil: (a) => q`CEIL(${a})`,
  floor: (a) => q`FLOOR(${a})`,
  round: (a) => q`ROUND(${a})`,
  sqrt: (a) => q`SQRT(${a})`,
  // POW domain-errors (→NULL) on a negative base with a fractional exponent, but a
  // real cube root of a negative is defined (cbrt(-8)=-2) — split on sign like signum.
  cbrt: (a) => q`(CASE WHEN ${a} < 0 THEN -POW(-(${a}), 1.0/3.0) WHEN ${a} >= 0 THEN POW(${a}, 1.0/3.0) ELSE NULL END)`,
  exp: (a) => q`EXP(${a})`,
  log: (a) => q`LN(${a})`,   // exp4j `log` is the natural log; SQLite `log()` is log10
  log10: (a) => q`LOG10(${a})`,
  log2: (a) => q`LOG2(${a})`,
  sin: (a) => q`SIN(${a})`,
  cos: (a) => q`COS(${a})`,
  tan: (a) => q`TAN(${a})`,
  asin: (a) => q`ASIN(${a})`,
  acos: (a) => q`ACOS(${a})`,
  atan: (a) => q`ATAN(${a})`,
  sinh: (a) => q`SINH(${a})`,
  cosh: (a) => q`COSH(${a})`,
  tanh: (a) => q`TANH(${a})`,
  signum: (a) => q`(CASE WHEN ${a} > 0 THEN 1.0 WHEN ${a} < 0 THEN -1.0 WHEN ${a} = 0 THEN 0.0 ELSE NULL END)`,
};

type Tok = { t: 'num' | 'id' | 'op' | 'lp' | 'rp'; v: string };

const NUM = /[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/y;
const ID = /[A-Za-z_][A-Za-z0-9_]*/y;

function lex(s: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(') { toks.push({ t: 'lp', v: c }); i++; continue; }
    if (c === ')') { toks.push({ t: 'rp', v: c }); i++; continue; }
    if ('+-*/%^'.includes(c)) { toks.push({ t: 'op', v: c }); i++; continue; }
    if (c >= '0' && c <= '9') {
      NUM.lastIndex = i; const m = NUM.exec(s)!;
      toks.push({ t: 'num', v: m[0] }); i = NUM.lastIndex; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      ID.lastIndex = i; const m = ID.exec(s)!;
      toks.push({ t: 'id', v: m[0] }); i = ID.lastIndex; continue;
    }
    throw new Error(`math(): unexpected character '${c}' in "${s}"`);
  }
  return toks;
}

/** Distinct variable names in first-seen order (idents that are not function
 *  names). `_` counts as a variable. Drives which by() modulator binds each. */
export function mathVars(formula: string): string[] {
  const seen: string[] = [];
  for (const tk of lex(formula))
    if (tk.t === 'id' && !(tk.v in FN) && !seen.includes(tk.v)) seen.push(tk.v);
  return seen;
}

/** A numeric literal as a REAL SQL fragment (`5` → `5.0`), so all arithmetic is
 *  floating (matching TinkerPop's all-double math). The text is lexer-validated
 *  numeric, so raw splicing is injection-safe. */
const realLit = (v: string): Expression => raw(/[.eE]/.test(v) ? v : `${v}.0`);

/**
 * Parse `formula` and build one SQL scalar Expression. `resolveVar(name)` supplies
 * the SQL expression for each variable (already the right element/property lookup);
 * this wraps it `CAST(… AS REAL)`. Precedence: `+ -` < `* / %` < unary `-` <
 * `^` (right-assoc) < function-application/primary. Functions accept a
 * parenthesised argument (`ceil(_ * 100)`) or bind to a single primary by
 * juxtaposition (`sin _`, `ceil _`).
 */
export function mathToSql(formula: string, resolveVar: (name: string) => Expression): Expression {
  const toks = lex(formula);
  let pos = 0;
  const peek = () => toks[pos];
  const next = () => toks[pos++];
  const expect = (t: Tok['t']) => { const k = next(); if (!k || k.t !== t) throw new Error(`math("${formula}"): expected '${t}'`); };

  const parseExpr = (): Expression => {         // + -
    let e = parseTerm();
    while (peek()?.t === 'op' && (peek().v === '+' || peek().v === '-')) {
      const op = next().v; e = q`(${e} ${raw(op)} ${parseTerm()})`;
    }
    return e;
  };
  const parseTerm = (): Expression => {         // * / %
    let e = parseUnary();
    while (peek()?.t === 'op' && (peek().v === '*' || peek().v === '/' || peek().v === '%')) {
      const op = next().v; const r = parseUnary();
      e = op === '%' ? q`MOD(${e}, ${r})` : q`(${e} ${raw(op)} ${r})`;
    }
    return e;
  };
  const parseUnary = (): Expression => {        // unary + -
    if (peek()?.t === 'op' && peek().v === '-') { next(); return q`(-${parseUnary()})`; }
    if (peek()?.t === 'op' && peek().v === '+') { next(); return parseUnary(); }
    return parsePow();
  };
  const parsePow = (): Expression => {          // ^ (right-assoc)
    const b = parsePrimary();
    if (peek()?.t === 'op' && peek().v === '^') { next(); return q`POW(${b}, ${parseUnary()})`; }
    return b;
  };
  const parsePrimary = (): Expression => {
    const tk = peek();
    if (!tk) throw new Error(`math("${formula}"): unexpected end of expression`);
    if (tk.t === 'lp') { next(); const e = parseExpr(); expect('rp'); return e; }
    if (tk.t === 'num') { next(); return realLit(tk.v); }
    if (tk.t === 'id') {
      next();
      if (tk.v in FN) {
        let arg: Expression;
        if (peek()?.t === 'lp') { next(); arg = parseExpr(); expect('rp'); }
        else arg = parsePrimary();   // juxtaposition: `sin _`, `ceil _`
        return FN[tk.v](arg);
      }
      return q`CAST(${resolveVar(tk.v)} AS REAL)`;
    }
    throw new Error(`math("${formula}"): unexpected '${tk.v}'`);
  };

  const e = parseExpr();
  if (pos !== toks.length) throw new Error(`math("${formula}"): unexpected trailing input`);
  return e;
}
