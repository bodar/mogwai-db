import { GraphQLTranslationError } from './translate.ts';

// ---------- GraphQL variables → Gremlin bound parameters (§6) ----------
//
// A GraphQL variable is the user's own statement that a value CHANGES — which is exactly what a Gremlin
// bound parameter is for, and what CLAUDE.md's bind rule asks (`docs/2026-08-07-graphql-front-end-plan.md`
// §6): a variable BINDS, a literal typed inline in the document INLINES. So `where: { age: { gt: $min } }`
// with `variables: { min: 30 }` emits `has('age', P.gt(gqv0))` and carries `{ gqv0: 30 }` in the params
// map the compiler already binds — never inlines 30, so two calls with different `min` share one cached
// plan, and the value spends one of the DO's 100 parameters (its purpose).
//
// The identifier emitted into the Gremlin string is a FRESH minted name (`gqv0`, `gqv1`, …), not the
// GraphQL variable name: a user's `$order` or `$select` could collide with a Gremlin keyword or a step
// name, and a minted `gqv<n>` cannot (the grammar's identifier rule admits it and nothing else uses the
// prefix). The value is looked up in the request's `variables` map at translation time — an undeclared
// or unsupplied variable is a clear refusal, never a silent null.

/** A per-translation collector: resolves a GraphQL variable name to a fresh Gremlin identifier and
 *  records its value, accumulating the params map the translation hands the compiler. */
export class Bindings {
  private readonly out: Record<string, unknown> = {};
  private n = 0;
  constructor(private readonly variables: Record<string, unknown>) {}

  /** The Gremlin identifier for a GraphQL variable `$name` — minting a fresh binding and recording its
   *  value. Raises if the request supplied no such variable (a declared-but-unsupplied variable is a
   *  wrong answer waiting to happen, not a null). */
  reference(name: string): string {
    if (!(name in this.variables))
      throw new GraphQLTranslationError(`variable $${name} was used but not supplied in 'variables'`);
    const id = `gqv${this.n++}`;
    this.out[id] = this.variables[name];
    return id;
  }

  /** The accumulated params map — what `Translation.params` becomes, handed to the compiler as the
   *  bindings a Gremlin client would have sent. */
  params(): Record<string, unknown> { return this.out; }
}
