/**
 * Java's whitespace set — `Character.isWhitespace(char)`, the exact code units the Gremlin `trim` family
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/util/StringLocalStep.java:75-94`)
 * strips and `split(null)` splits on (`StringUtil.split` → Commons `StringUtils.splitByWholeSeparator(s, null)`,
 * whose worker tests `Character.isWhitespace` per char; `.../gremlin/util/StringUtil.java:42-52`). Excludes
 * the non-breaking spaces (U+00A0 NBSP, U+2007 figure, U+202F narrow NBSP) and U+FEFF, which Java also
 * excludes; includes U+001C..U+001F and U+3000 ideographic space (the suite's fullwidth-space case). Every
 * member is in the BMP, as `isWhitespace(char)` is per UTF-16 unit. Built from explicit code points so the
 * source carries no literal control/space chars. ONE list for both consumers: a second, re-derived one is
 * how `split(null)` came to split on NBSP (JS `\s`) while `trim()` did not.
 */
export const JAVA_WHITESPACE = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x205f, 0x3000,
].map((c) => String.fromCharCode(c)).join('');
