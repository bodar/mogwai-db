import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { evidenceOf, receiverProvably } from '../../src/compiler/rel/receiver.ts';
import { col, compilerText } from '../../src/rel/expr.ts';
import { raisedMessage } from '../../src/rel/raise.ts';
import { relId } from '../../src/rel/types.ts';
import { PER_ROW, STATIC, UNKNOWN } from '../../src/sql/kernel/render.ts';

// The receiver authority's three answers (src/compiler/rel/receiver.ts): a static tag PROVES or REFUTES,
// anything else is decided per row — and a host's literal tag is the static case, not the per-row one.
describe('receiverProvably', () => {
  test('a static tag proves its own kind and refutes the other', () => {
    expect(receiverProvably('number', evidenceOf(STATIC('long')))).toBe(true);
    expect(receiverProvably('string', evidenceOf(STATIC('string')))).toBe(true);
    expect(receiverProvably('number', evidenceOf(STATIC('boolean')))).toBe(false);
    expect(receiverProvably('string', evidenceOf(STATIC('int')))).toBe(false);
  });
  test('a literal per-row tag is static; a column tag and an unknown type are per row', () => {
    expect(receiverProvably('number', evidenceOf(undefined, compilerText('boolean')))).toBe(false);
    expect(receiverProvably('number', evidenceOf(PER_ROW('vtype'), col(relId('r'), 'vtype')))).toBe('runtime');
    expect(receiverProvably('string', evidenceOf(UNKNOWN))).toBe('runtime');
  });
});

// A raise message travels verbatim through SQLite's quoted path echo — quotes and `!` included.
test('raisedMessage round-trips a quote and an exclamation mark', () => {
  const db = new Database(':memory:');
  for (const message of [`Can't parse null as String.`, 'Division by zero!']) {
    const path = `$!raise:${message}!$`.replaceAll("'", "''");
    let caught: unknown;
    try { db.query(`SELECT json_extract('1', '${path}')`).all(); } catch (e) { caught = e; }
    expect(raisedMessage(caught)).toBe(message);
  }
});
