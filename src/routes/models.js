import { audit } from '../services/audit.js';
import { legacyTierValue } from '../db/model-catalog.js';

// Provider IDs keep their upstream casing and variant suffixes such as `:free`.
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9~][A-Za-z0-9._:~-]*$/;
const TAG_TITLE = /^[a-z0-9_-]{1,64}$/;

function status(value) {
  if (value !== 'active' && value !== 'inactive') throw new TypeError('Status must be active or inactive.');
  return value;
}

// Families and tiers are the same kind of admin-managed tag: a catalog table
// plus a many-to-many link table keyed by model.
const TAGS = {
  family: { table: 'model_families', links: 'model_family_links', column: 'family_id', label: 'model family', plural: 'model families' },
  tier: { table: 'model_tiers', links: 'model_tier_links', column: 'tier_id', label: 'model tier', plural: 'model tiers' },
};

function tagIds(db, kind, value) {
  const { table, label, plural } = TAGS[kind];
  if (!Array.isArray(value) || new Set(value).size !== value.length ||
    value.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    throw new TypeError(`Select distinct valid ${plural}.`);
  }
  for (const id of value) {
    if (!db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id)) {
      throw new TypeError(`Selected ${label} does not exist.`);
    }
  }
  return value;
}

function tagTitle(kind, body) {
  if (!body || typeof body.title !== 'string' || !TAG_TITLE.test(body.title)) {
    throw new TypeError(`Use a lowercase ${kind} title of 1–64 letters, digits, underscores or hyphens.`);
  }
  return body.title;
}

function tags(db, kind) {
  const { table, links, column } = TAGS[kind];
  return db.prepare(`SELECT t.id, t.title, count(l.model_id) AS modelCount
    FROM ${table} t LEFT JOIN ${links} l ON l.${column} = t.id
    GROUP BY t.id ORDER BY t.id`).all();
}

function modelTags(db, kind, modelId) {
  const { table, links, column } = TAGS[kind];
  return db.prepare(`SELECT t.id, t.title FROM ${table} t
    JOIN ${links} l ON l.${column} = t.id WHERE l.model_id = ? ORDER BY t.id`).all(modelId);
}

function replaceTags(db, kind, modelId, ids) {
  const { links, column } = TAGS[kind];
  db.prepare(`DELETE FROM ${links} WHERE model_id = ?`).run(modelId);
  const insert = db.prepare(`INSERT INTO ${links} (model_id, ${column}) VALUES (?, ?)`);
  for (const id of ids) insert.run(modelId, id);
}

// model_catalog.tiers mirrors the tier links so a rolled-back image still sees
// each model's tiers.
function syncLegacyTiers(db, modelIds) {
  const update = db.prepare('UPDATE model_catalog SET tiers = ? WHERE id = ?');
  for (const id of modelIds) update.run(legacyTierValue(modelTags(db, 'tier', id).map((tier) => tier.title)), id);
}

function tierModelIds(db, tierId) {
  return db.prepare('SELECT model_id FROM model_tier_links WHERE tier_id = ?').all(tierId).map((link) => link.model_id);
}

function authorized(request, reply, admin = false) {
  if (!request.user) { reply.code(401).send({ error: 'Not authenticated' }); return false; }
  if (admin && request.user.role !== 'admin') { reply.code(403).send({ error: 'Admin role required' }); return false; }
  return true;
}

function validate(db, body, defaults = { status: 'inactive', familyIds: [], tierIds: [] }) {
  if (!body || typeof body.model !== 'string' || !MODEL_ID.test(body.model) || body.model.length > 160) {
    throw new TypeError('Use a provider/model ID with letters, digits, ".", "_", "-", ":" or "~".');
  }
  for (const price of [body.inputPrice, body.outputPrice]) {
    if (typeof price !== 'number' || !Number.isFinite(price) || price < 0 || price > 1000000) {
      throw new TypeError('Prices must be finite non-negative numbers.');
    }
  }
  return {
    model: body.model, tierIds: tagIds(db, 'tier', body.tierIds ?? defaults.tierIds),
    inputPrice: body.inputPrice, outputPrice: body.outputPrice,
    status: status(body.status ?? defaults.status), familyIds: tagIds(db, 'family', body.familyIds ?? defaults.familyIds),
  };
}

function row(db, value) {
  return {
    id: value.id, model: value.model, tiers: modelTags(db, 'tier', value.id),
    inputPrice: value.input_price, outputPrice: value.output_price, position: value.position,
    status: value.status, families: modelTags(db, 'family', value.id),
  };
}

function list(db) {
  return db.prepare('SELECT * FROM model_catalog ORDER BY position, id').all().map((value) => row(db, value));
}

function find(db, id) {
  return db.prepare('SELECT * FROM model_catalog WHERE id = ?').get(id);
}

// Catalog rows and their audit entry commit together, so a failed audit never
// leaves an unrecorded price change behind.
function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function snapshot(value) {
  const { model, tiers, inputPrice, outputPrice, status, families } = value;
  return {
    model, tierIds: tiers.map((tier) => tier.id), inputPrice, outputPrice, status,
    familyIds: families.map((family) => family.id),
  };
}

function errorReply(reply, error) {
  if (error instanceof TypeError || error instanceof RangeError) return reply.code(400).send({ error: error.message });
  if (error.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed: model_catalog.model/i.test(error.message)) {
    return reply.code(400).send({ error: 'Model already exists.' });
  }
  if (error.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed: model_families.title/i.test(error.message)) {
    return reply.code(400).send({ error: 'Model family already exists.' });
  }
  if (error.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed: model_tiers.title/i.test(error.message)) {
    return reply.code(400).send({ error: 'Model tier already exists.' });
  }
  throw error;
}

export default async function modelRoutes(app, { db }) {
  app.get('/api/models', async (request, reply) => {
    if (!authorized(request, reply)) return reply;
    return list(db);
  });

  app.post('/api/models', async (request, reply) => {
    if (!authorized(request, reply, true)) return reply;
    try {
      const value = validate(db, request.body);
      const created = transaction(db, () => {
        const position = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS position FROM model_catalog').get().position;
        const result = db.prepare('INSERT INTO model_catalog (model, tiers, input_price, output_price, position, status) VALUES (?, ?, ?, ?, ?, ?)')
          .run(value.model, '[]', value.inputPrice, value.outputPrice, position, value.status);
        replaceTags(db, 'tier', result.lastInsertRowid, value.tierIds);
        syncLegacyTiers(db, [result.lastInsertRowid]);
        replaceTags(db, 'family', result.lastInsertRowid, value.familyIds);
        audit(db, {
          actorId: request.user.id, action: 'admin.create_model', targetType: 'model', targetId: result.lastInsertRowid,
          detail: JSON.stringify({ after: value }), ip: request.ip,
        });
        return row(db, find(db, result.lastInsertRowid));
      });
      return reply.code(201).send(created);
    } catch (error) { return errorReply(reply, error); }
  });

  app.patch('/api/models/:id', async (request, reply) => {
    if (!authorized(request, reply, true)) return reply;
    const current = find(db, request.params.id);
    if (!current) return reply.code(404).send({ error: 'Model not found' });
    try {
      const before = row(db, current);
      // Omitted status/tiers/families keep their stored values, so an older
      // client editing prices cannot silently switch a model off or drop tags.
      const { status: storedStatus, tierIds, familyIds } = snapshot(before);
      const value = validate(db, request.body, { status: storedStatus, tierIds, familyIds });
      return transaction(db, () => {
        db.prepare('UPDATE model_catalog SET model = ?, input_price = ?, output_price = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(value.model, value.inputPrice, value.outputPrice, value.status, current.id);
        replaceTags(db, 'tier', current.id, value.tierIds);
        syncLegacyTiers(db, [current.id]);
        replaceTags(db, 'family', current.id, value.familyIds);
        audit(db, {
          actorId: request.user.id, action: 'admin.update_model', targetType: 'model', targetId: current.id,
          detail: JSON.stringify({ before: snapshot(before), after: value }), ip: request.ip,
        });
        return row(db, find(db, current.id));
      });
    } catch (error) { return errorReply(reply, error); }
  });

  app.patch('/api/models/:id/status', async (request, reply) => {
    if (!authorized(request, reply, true)) return reply;
    const current = find(db, request.params.id);
    if (!current) return reply.code(404).send({ error: 'Model not found' });
    try {
      const next = status(request.body?.status);
      return transaction(db, () => {
        db.prepare('UPDATE model_catalog SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(next, current.id);
        audit(db, {
          actorId: request.user.id, action: 'admin.set_model_status', targetType: 'model', targetId: current.id,
          detail: JSON.stringify({ before: current.status, after: next }), ip: request.ip,
        });
        return row(db, find(db, current.id));
      });
    } catch (error) { return errorReply(reply, error); }
  });

  app.delete('/api/models/:id', async (request, reply) => {
    if (!authorized(request, reply, true)) return reply;
    const current = find(db, request.params.id);
    if (!current) return reply.code(404).send({ error: 'Model not found' });
    transaction(db, () => {
      // Audit first: the model name is kept in the detail because the target
      // row no longer exists for the audit view to join against.
      audit(db, {
        actorId: request.user.id, action: 'admin.delete_model', targetType: 'model', targetId: current.id,
        detail: JSON.stringify({ before: snapshot(row(db, current)) }), ip: request.ip,
      });
      db.prepare('DELETE FROM model_catalog WHERE id = ?').run(current.id);
    });
    return { ok: true };
  });

  tagRoutes(app, db, 'family', '/api/model-families', 'Model family not found');
  tagRoutes(app, db, 'tier', '/api/model-tiers', 'Model tier not found');

  app.post('/api/models/:id/move', async (request, reply) => {
    if (!authorized(request, reply, true)) return reply;
    const direction = request.body?.direction;
    if (!['up', 'down'].includes(direction)) return reply.code(400).send({ error: 'Use up or down.' });
    const rows = list(db);
    const index = rows.findIndex((item) => String(item.id) === request.params.id);
    if (index === -1) return reply.code(404).send({ error: 'Model not found' });
    const adjacent = rows[index + (direction === 'up' ? -1 : 1)];
    if (!adjacent) return reply.code(400).send({ error: 'Already at the edge of the list.' });
    transaction(db, () => {
      db.prepare('UPDATE model_catalog SET position = ? WHERE id = ?').run(adjacent.position, rows[index].id);
      db.prepare('UPDATE model_catalog SET position = ? WHERE id = ?').run(rows[index].position, adjacent.id);
      audit(db, { actorId: request.user.id, action: 'admin.move_model', targetType: 'model', targetId: rows[index].id, detail: direction, ip: request.ip });
    });
    return list(db);
  });
}

function tagRoutes(app, db, kind, path, notFound) {
  const { table, links, column } = TAGS[kind];
  const target = 'model_' + kind;
  const find = (id) => db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);

  app.get(path, async (request, reply) => {
    if (!authorized(request, reply)) return reply;
    return tags(db, kind);
  });

  app.post(path, async (request, reply) => {
    if (!authorized(request, reply, true)) return reply;
    try {
      const title = tagTitle(kind, request.body);
      const created = transaction(db, () => {
        const result = db.prepare(`INSERT INTO ${table} (title) VALUES (?)`).run(title);
        audit(db, {
          actorId: request.user.id, action: 'admin.create_' + target, targetType: target, targetId: result.lastInsertRowid,
          detail: JSON.stringify({ after: { title } }), ip: request.ip,
        });
        return tags(db, kind).find((tag) => tag.id === Number(result.lastInsertRowid));
      });
      return reply.code(201).send(created);
    } catch (error) { return errorReply(reply, error); }
  });

  app.patch(path + '/:id', async (request, reply) => {
    if (!authorized(request, reply, true)) return reply;
    const current = find(request.params.id);
    if (!current) return reply.code(404).send({ error: notFound });
    try {
      const title = tagTitle(kind, request.body);
      return transaction(db, () => {
        db.prepare(`UPDATE ${table} SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(title, current.id);
        if (kind === 'tier') syncLegacyTiers(db, tierModelIds(db, current.id));
        audit(db, {
          actorId: request.user.id, action: 'admin.update_' + target, targetType: target, targetId: current.id,
          detail: JSON.stringify({ before: { title: current.title }, after: { title } }), ip: request.ip,
        });
        return tags(db, kind).find((tag) => tag.id === current.id);
      });
    } catch (error) { return errorReply(reply, error); }
  });

  app.delete(path + '/:id', async (request, reply) => {
    if (!authorized(request, reply, true)) return reply;
    const current = find(request.params.id);
    if (!current) return reply.code(404).send({ error: notFound });
    const unlinkedModels = transaction(db, () => {
      const modelIds = db.prepare(`SELECT model_id FROM ${links} WHERE ${column} = ?`).all(current.id).map((link) => link.model_id);
      db.prepare(`DELETE FROM ${links} WHERE ${column} = ?`).run(current.id);
      db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(current.id);
      if (kind === 'tier') syncLegacyTiers(db, modelIds);
      audit(db, {
        actorId: request.user.id, action: 'admin.delete_' + target, targetType: target, targetId: current.id,
        detail: JSON.stringify({ before: { title: current.title }, unlinkedModels: modelIds.length }), ip: request.ip,
      });
      return modelIds.length;
    });
    return { ok: true, unlinkedModels };
  });
}
