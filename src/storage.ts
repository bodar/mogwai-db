import Database from 'better-sqlite3';

export class GraphStore {
  db: Database.Database;

  constructor(path = ':memory:') {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS labels(
        id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS nodes(
        id INTEGER PRIMARY KEY, label INTEGER NOT NULL REFERENCES labels(id),
        props TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE IF NOT EXISTS edges(
        id INTEGER PRIMARY KEY, src INTEGER NOT NULL, label INTEGER NOT NULL,
        tgt INTEGER NOT NULL, props TEXT NOT NULL DEFAULT '{}');
      CREATE INDEX IF NOT EXISTS n_label ON nodes(label);
      CREATE INDEX IF NOT EXISTS e_out ON edges(src, label, tgt);
      CREATE INDEX IF NOT EXISTS e_in  ON edges(tgt, label, src);
    `);
  }

  labelId(name: string): number {
    const row = this.db
      .prepare('INSERT INTO labels(name) VALUES(?) ON CONFLICT(name) DO UPDATE SET name=name RETURNING id')
      .get(name) as { id: number };
    return row.id;
  }

  labelName(id: number): string {
    return (this.db.prepare('SELECT name FROM labels WHERE id=?').get(id) as any).name;
  }
}
