// ---------- math(): a scalar arithmetic expression → a target algebra ----------
//
// TinkerPop's `math("<formula>")` compiles a small arithmetic expression to a
// single scalar. It stays true to locked decision #3 (compile to SQL, never
// interpret): the formula becomes ONE expression evaluated by SQLite, no per-row
// JS. `_` is the current traverser's value; a bare identifier (`a`, `b`,
// `expectedWeight`) is a variable resolved by the caller. TinkerPop uses exp4j,
// whose function names are fixed and whose `log` is the NATURAL log; the
// operator/function surface below mirrors it. `math()` always yields a Double, so
// every leaf is coerced to REAL (`MathOps.real`/`MathOps.variable` say so) — that
// makes `/` real division (SQLite's `/` is integer division on integer operands)
// and `^`/`%` fall out via `POW`/`MOD` with no per-operator special-casing.
//
// ## Why an OPS RECORD and not an AST (§6·4)
//
// This file is a PARSE plus a table of non-derivable SQL facts, and the two spines
// need the parse but construct different things — legacy composes a `q` kernel
// `Expression`, RelIR composes a `Rel` `Expr`. The obvious separation is an AST
// (`parseMath(formula): MathNode`, each spine folding it) and it is the WRONG one
// here: three of the twenty `FN` entries are SQL facts rather than operator names.
// `log` is exp4j's NATURAL log and maps to `LN` while SQLite's own `log()` is
// log10; `cbrt` splits on sign because `POW` domain-errors to NULL on a negative
// base with a fractional exponent, and a real cube root of a negative is defined;
// `signum` is a three-way `CASE`. An AST whose nodes are `{fn: 'cbrt'}` makes each
// spine re-derive that expansion — a non-derivable fact re-implemented, which is a
// second chance to get it wrong and no test names the difference.
//
// So the layer supplies only PRIMITIVES and `FN` stays ONE table. The `conditional`
// primitive is what makes that possible at all, and it is exactly what an ops record
// has and an AST does not.

/**
 * The target algebra's primitives — everything the builder below needs to CONSTRUCT
 * a value, and nothing else. Total: a layer that implements these seven gets the whole
 * `math()` surface, including the three expansions that are SQL facts rather than
 * operator names.
 */
export interface MathOps<T> {
  /** A variable's value AS A REAL. `math()` is all-double arithmetic, so the layer casts. */
  readonly variable: (name: string) => T;
  /** A numeric literal AS A REAL (`5` → `5.0`), so `/` is real division and not SQLite's
   *  integer division. `text` is the lexer-validated numeral (possibly signed here — the
   *  FN table writes `-1`), never user text. */
  readonly real: (text: string) => T;
  /** The four operators that STAY operators. `%` and `^` are `call`s (`MOD`/`POW`), which is
   *  why they are absent: SQLite spells neither infix. */
  readonly binary: (op: '+' | '-' | '*' | '/', left: T, right: T) => T;
  readonly negate: (a: T) => T;
  readonly call: (fn: string, args: readonly T[]) => T;
  /** `CASE WHEN <cond> THEN <value> … ELSE <otherwise> END`. The conditions come from
   *  `compare`, so a layer whose boolean and numeric spaces differ can still implement both. */
  readonly conditional: (whens: readonly (readonly [T, T])[], otherwise: T) => T;
  readonly compare: (op: '<' | '>' | '=' | '>=', left: T, right: T) => T;
  /** SQL NULL — the ELSE of a sign split, reached only when the argument is itself NULL. */
  readonly nul: () => T;
}

/** One of exp4j's built-in functions, expressed in the target algebra's primitives. All unary. */
type MathFn = <T>(a: T, ops: MathOps<T>) => T;

/** exp4j's built-in functions → SQL. `log` = natural log (→ `LN`); `signum`/`cbrt` have no
 *  SQLite builtin, so they expand through `conditional`. The math functions are provided by
 *  SQLite's math extension (verified present on both DO SQLite 3.47 and Bun 3.53). */
const FN: Record<string, MathFn> = {
  abs: (a, ops) => ops.call('ABS', [a]),
  ceil: (a, ops) => ops.call('CEIL', [a]),
  floor: (a, ops) => ops.call('FLOOR', [a]),
  round: (a, ops) => ops.call('ROUND', [a]),
  sqrt: (a, ops) => ops.call('SQRT', [a]),
  // POW domain-errors (→NULL) on a negative base with a fractional exponent, but a
  // real cube root of a negative is defined (cbrt(-8)=-2) — split on sign like signum.
  cbrt: (a, ops) => {
    const third = ops.binary('/', ops.real('1'), ops.real('3'));
    return ops.conditional([
      [ops.compare('<', a, ops.real('0')), ops.negate(ops.call('POW', [ops.negate(a), third]))],
      [ops.compare('>=', a, ops.real('0')), ops.call('POW', [a, third])],
    ], ops.nul());
  },
  exp: (a, ops) => ops.call('EXP', [a]),
  log: (a, ops) => ops.call('LN', [a]),   // exp4j `log` is the natural log; SQLite `log()` is log10
  log10: (a, ops) => ops.call('LOG10', [a]),
  log2: (a, ops) => ops.call('LOG2', [a]),
  sin: (a, ops) => ops.call('SIN', [a]),
  cos: (a, ops) => ops.call('COS', [a]),
  tan: (a, ops) => ops.call('TAN', [a]),
  asin: (a, ops) => ops.call('ASIN', [a]),
  acos: (a, ops) => ops.call('ACOS', [a]),
  atan: (a, ops) => ops.call('ATAN', [a]),
  sinh: (a, ops) => ops.call('SINH', [a]),
  cosh: (a, ops) => ops.call('COSH', [a]),
  tanh: (a, ops) => ops.call('TANH', [a]),
  signum: (a, ops) => ops.conditional([
    [ops.compare('>', a, ops.real('0')), ops.real('1')],
    [ops.compare('<', a, ops.real('0')), ops.real('-1')],
    [ops.compare('=', a, ops.real('0')), ops.real('0')],
  ], ops.nul()),
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
 *  names). `_` counts as a variable. Drives which by() modulator binds each —
 *  the reference reads the same set in the same order (`MathStep`'s
 *  `TinkerExpression.getVariables`, a `LinkedHashSet` over its variable pattern)
 *  and advances its `TraversalRing` once per member. */
export function mathVars(formula: string): string[] {
  const seen: string[] = [];
  for (const tk of lex(formula))
    if (tk.t === 'id' && !(tk.v in FN) && !seen.includes(tk.v)) seen.push(tk.v);
  return seen;
}

/**
 * Parse `formula` and build one scalar value in the algebra `ops` describes.
 * `ops.variable(name)` supplies each variable's value (already the right
 * element/property lookup, already coerced). Precedence: `+ -` < `* / %` <
 * unary `-` < `^` (right-assoc) < function-application/primary. Functions accept a
 * parenthesised argument (`ceil(_ * 100)`) or bind to a single primary by
 * juxtaposition (`sin _`, `ceil _`).
 */
export function compileMath<T>(formula: string, ops: MathOps<T>): T {
  const toks = lex(formula);
  let pos = 0;
  const peek = () => toks[pos];
  const next = () => toks[pos++];
  const expect = (t: Tok['t']) => { const k = next(); if (!k || k.t !== t) throw new Error(`math("${formula}"): expected '${t}'`); };

  const parseExpr = (): T => {                  // + -
    let e = parseTerm();
    while (peek()?.t === 'op' && (peek().v === '+' || peek().v === '-')) {
      const op = next().v as '+' | '-'; e = ops.binary(op, e, parseTerm());
    }
    return e;
  };
  const parseTerm = (): T => {                  // * / %
    let e = parseUnary();
    while (peek()?.t === 'op' && (peek().v === '*' || peek().v === '/' || peek().v === '%')) {
      const op = next().v; const r = parseUnary();
      e = op === '%' ? ops.call('MOD', [e, r]) : ops.binary(op as '*' | '/', e, r);
    }
    return e;
  };
  const parseUnary = (): T => {                 // unary + -
    if (peek()?.t === 'op' && peek().v === '-') { next(); return ops.negate(parseUnary()); }
    if (peek()?.t === 'op' && peek().v === '+') { next(); return parseUnary(); }
    return parsePow();
  };
  const parsePow = (): T => {                   // ^ (right-assoc)
    const b = parsePrimary();
    if (peek()?.t === 'op' && peek().v === '^') { next(); return ops.call('POW', [b, parseUnary()]); }
    return b;
  };
  const parsePrimary = (): T => {
    const tk = peek();
    if (!tk) throw new Error(`math("${formula}"): unexpected end of expression`);
    if (tk.t === 'lp') { next(); const e = parseExpr(); expect('rp'); return e; }
    if (tk.t === 'num') { next(); return ops.real(tk.v); }
    if (tk.t === 'id') {
      next();
      if (tk.v in FN) {
        let arg: T;
        if (peek()?.t === 'lp') { next(); arg = parseExpr(); expect('rp'); }
        else arg = parsePrimary();   // juxtaposition: `sin _`, `ceil _`
        return FN[tk.v](arg, ops);
      }
      return ops.variable(tk.v);
    }
    throw new Error(`math("${formula}"): unexpected '${tk.v}'`);
  };

  const e = parseExpr();
  if (pos !== toks.length) throw new Error(`math("${formula}"): unexpected trailing input`);
  return e;
}
