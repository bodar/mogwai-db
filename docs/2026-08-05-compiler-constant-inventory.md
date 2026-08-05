# Compiler-constant inventory

**Status: IN PROGRESS.** Companion audit for
`2026-08-05-compiler-constant-sql-hygiene-plan.md`. The count is intentionally not pinned here:
run `rg -n '\\blit\\(' src/compiler/rel src/rel -g '*.ts'` for the current surface. The first audit
found 120 construction sites.

`C-text`, `C-int`, and `C-null` mean compiler syntax; `Q` means query/store data and must remain a
bind. `Trace` means the local expression does not settle provenance and must be followed to its
caller before changing it. A line may contain several sites with different classifications.

| Module | C-text | C-int / C-null | Q | Trace / decision needed |
|---|---|---|---|---|
| `src/rel/passes/land.ts` | `46` JSON path | — | `36` landed JSON rows | — |
| `compiler/rel/reducer.ts` | — | `67` aggregate NULL guard | — | — |
| `compiler/rel/history.ts` | `50`, `71` type tag/path | `40` shape code | — | `50`: static tag is compiler-owned; per-row tag already is an expression |
| `compiler/rel/element.ts` | `225` element tag | — | — | — |
| `compiler/rel/path.ts` | `141`, `144`, `199` JSON syntax | `151`, `164`, `181`, `182`, `248` | — | `181`/`182` are lowering-generated positions, not Gremlin arguments |
| `compiler/rel/map.ts` | `101`, `311`, `314`, `334` JSON/type tags | `319` count argument | — | — |
| `compiler/rel/alias.ts` | `88` JSON path | `75`, `76` | — | `88` must prove `endPath()` is compiler-built |
| `compiler/rel/build.ts` | already migrated type vocabulary | `190` internal limit | `136` caller-supplied name set | — |
| `compiler/rel/predicate.ts` | `303` LIKE escape | `38`, `41`, internal NULL arms | `58`, `212`, `221`, `225`, LIKE pattern | `221`/`225` type arguments originate at the query boundary, so stay Q even when canonicalized |
| `compiler/rel/transform.ts` | — | `132`, `133` NULL propagation | `63`, `64`, `121` transform arguments | — |
| `compiler/rel/modulator.ts` | `292` fixed `string` tag | `273`, `274`, `282`, `312` NULL handling | `242`, `303` property key | `292`: only the label arm is compiler-owned |
| `compiler/rel/list.ts` | `124`, `125`, `145`, `202`–`213`, `345`, `504`, `536` fixed type/JSON syntax | `204`, `208`, `209`, `228`, `301`, `304`, `335`, `537`, `538`, `664`, `700` | `278`, `279`, `345` separator, `597`, `781` | `124`/`125` helpers are mixed: call sites decide whether their string comes from syntax or an argument |
| `compiler/rel/lower.ts` | — | `443`, `472`, `488`, `497`, `627`, `876`, `883`, `948`, `953`, `1041`, `1724`, `1998`, `2006`, `2016`, `2050` | `440`, `441`, `529`, `530`, `704`, `769`, `770`, `823`, `824`, `828`, `829`, `1084`, `1118`, `1363`, `1534`, `1570`, `1771`–`1773` | The fixed `1`/`0` sites are the likely `compilerInt` candidates; all traversal arguments remain Q. |
| `compiler/rel/write.ts` | `104` fixed owner enum | `494`, `630`, `681`, `812`, `938`, `1153`, `1157`, `1242` internal bulk/shape syntax | `264`, `278`, `441`, `442` write values, keys, metadata and type supplied by the write | `104` is schema vocabulary; no property value may move to compiler syntax. |

## Decisions already settled

1. Existing `compilerText()` migrations for type lists and collection type tags are correct.
2. JSON paths and type/shape tags are compiler text only when their source is a fixed lowering helper;
   a JSON document constructed from a Gremlin collection remains one bound value.
3. Predicate `typeOf()` names are query data. Canonicalizing a user spelling does not change its
   provenance.
4. Write keys, values, metadata and externally supplied type names are query/store data. The only
   likely write-side compiler text is a closed schema enum such as `node` / `edge`.

## Next audit pass

Resolve every `Trace` row to a line-level disposition, beginning with list helpers and generated JSON
paths. Then add narrow integer/null constructors only if the completed audit has at least two distinct
safe call sites for each; a one-off should stay a local spelling rather than widening the algebra.
