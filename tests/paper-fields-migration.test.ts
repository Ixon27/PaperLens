import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { migratePaperFields } from '../src/server/db';

it('migrates legacy research types in order and drops the old column idempotently', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE papers(id TEXT PRIMARY KEY, title TEXT, research_types TEXT)');
    const insert = db.prepare('INSERT INTO papers(id, title, research_types) VALUES (?, ?, ?)');
    const values = ['["clinical","omics"]', '["wetlab"]', '["review","omics"]', '["review"]', null, 'bad'];
    values.forEach((value, i) => insert.run(String(i), `Paper ${i}`, value));

    migratePaperFields(db);
    const rows = db.prepare('SELECT field, field_suggested FROM papers ORDER BY id').all();
    expect(rows.map((row) => row.field)).toEqual(['medicine', 'life', 'life', null, null, null]);
    expect(rows.map((row) => row.field_suggested)).toEqual([null, null, null, null, null, null]);
    const columns = db.prepare('PRAGMA table_info(papers)').all().map((column) => column.name);
    expect(columns).toContain('field');
    expect(columns).toContain('field_suggested');
    expect(columns).not.toContain('research_types');

    expect(() => migratePaperFields(db)).not.toThrow();
    expect(db.prepare('SELECT field, field_suggested FROM papers ORDER BY id').all()).toEqual(rows);
  } finally {
    db.close();
  }
});

it('preserves existing fields and ignores JSON values that are not string arrays', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE papers(id TEXT PRIMARY KEY, title TEXT, research_types TEXT, field TEXT)');
    const insert = db.prepare('INSERT INTO papers VALUES (?, ?, ?, ?)');
    insert.run('1', 'Existing', '["clinical"]', 'physics');
    insert.run('2', 'Object', '{"0":"clinical"}', null);
    insert.run('3', 'Mixed', '["clinical",1]', null);
    migratePaperFields(db);
    expect(db.prepare('SELECT field FROM papers ORDER BY id').all().map((row) => row.field)).toEqual(['physics', null, null]);
  } finally {
    db.close();
  }
});
