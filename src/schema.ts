// ---------- mogwai's fixed SQLite schema, as typed relation constants ----------
//
// The schema (src/storage.ts) is fixed and known upfront — we never DDL at query
// time — so every table + column is declared ONCE here and referenced as a typed
// object everywhere (`nodes.c.id`, not the string 'n.id'). Rename in one place;
// typos are compile errors; find-references works. Generated CTEs use the SAME
// Relation shape (minted via `Query`), so a table and a CTE are indistinguishable
// at the use site — see src/q.ts.

import { relation } from './q.ts';

export const nodes = relation('nodes', ['id', 'uid', 'label']);
export const vertexProperties = relation('vertex_properties', ['id', 'node', 'key', 'value', 'meta']);
export const edges = relation('edges', ['id', 'uid', 'src', 'label', 'tgt', 'props']);
export const labels = relation('labels', ['id', 'name']);
