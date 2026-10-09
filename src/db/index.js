import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { schema } from './schema.js';
import { migrate } from './migrate.js';
import { seedModelCatalog } from './model-catalog.js';

export function openDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  migrate(db);
  db.exec(schema);
  seedModelCatalog(db);
  return db;
}
