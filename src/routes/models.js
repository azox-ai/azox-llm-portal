import { audit } from '../services/audit.js';

const TIERS = ['Ultra', 'Max', 'High', 'Medium'];
// Provider IDs keep their upstream casing and variant suffixes such as `:free`.
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9~][A-Za-z0-9._:~-]*$/;
const FAMILY_TITLE = /^[a-z0-9_-]{1,64}$/;

function status(value) {
  if (value !== 'active' && value !== 'inactive') throw new TypeError('Status must be active or inactive.');
  return value;
}

function familyIds(db, value) {
  if (!Array.isArray(value) || new Set(value).size !== value.length ||
    value.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    throw new TypeError('Select distinct valid model families.');
  }
  for (const id of value) {
    if (!db.prepare('SELECT id FROM model_families WHERE id = ?').get(id)) {
      throw new TypeError('Selected model family does not exist.');
    }
  }
  return value;
}

function familyTitle(body) {
  if (!body || typeof body.title !== 'string' || !FAMILY_TITLE.test(body.title)) {
    throw new TypeError('Use a lowercase family title of 1–64 letters, digits, underscores or hyphens.');
  }
  return body.title;
}

function families(db) {
  return db.prepare(`SELECT f.id, f.title, count(l.model_id) AS modelCount
    FROM model_families f LEFT JOIN model_family_links l ON l.family_id = f.id
    GROUP BY f.id ORDER BY f.id`).all();
}

function modelFamilies(db, modelId) {
  return db.prepare(`SELECT f.id, f.title FROM model_families f
    JOIN model_family_links l ON l.family_id = f.id WHERE l.model_id = ? ORDER BY f.id`).all(modelId);
}

function replaceFamilies(db, modelId, ids) {
  db.prepare('DELETE FROM model_family_links WHERE model_id = ?').run(modelId);
  const insert = db.prepare('INSERT INTO model_family_links (model_id, family_id) VALUES (?, ?)');
  for (const id of ids) insert.run(modelId, id);
}

function authorized(request, reply, admin = false) {
  if (!request.user) { reply.code(401).send({ error: 'Not authenticated' }); return false; }
  if (admin && request.user.role !== 'admin') { reply.code(403).send({ error: 'Admin role required' }); return false; }
  return true;
}

function validate(db, body, defaults = { status: 'inactive', familyIds: [] }) {
  if (!body || typeof body.model !== 'string' || !MODEL_ID.test(body.model) || body.model.length > 160) {
    throw new TypeError('Use a provider/model ID with letters, digits, ".", "_", "-", ":" or "~".');
  }
  if (!Array.isArray(body.tiers) || body.tiers.length < 1 || body.tiers.length > 4 ||
    new Set(body.tiers).size !== body.tiers.length || body.tiers.some((tier) => !TIERS.includes(tier))) {
    throw new TypeError('Select one or more distinct tiers.');
  }
  for (const price of [body.inputPrice, body.outputPrice]) {
    if (typeof price !== 'number' || !Number.isFinite(price) || price < 0 || price > 1000000) {
      throw new TypeError('Prices must be finite non-negative numbers.');
    }
  }
  return {
    model: body.model, tiers: TIERS.filter((tier) => body.tiers.includes(tier)),
    inputPrice: body.inputPrice, outputPrice: body.outputPrice,
    status: status(body.status ?? defaults.status), familyIds: familyIds(db, body.familyIds ?? defaults.familyIds),
  };
}

function row(db, value) {
  return {
    id: value.id, model: value.model, tiers: JSON.parse(value.tiers),
    inputPrice: value.input_price, outputPrice: value.output_price, position: value.position,
    status: value.status, families: modelFamilies(db, value.id),
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
  return { model, tiers, inputPrice, outputPrice, status, familyIds: families.map((family) => family.id) };
}

function errorReply(reply, error) {
  if (error instanceof TypeError || error instanceof RangeError) return reply.code(400).send({ error: error.message });
  if (error.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed: model_catalog.model/i.test(error.message)) {
    return reply.code(400).send({ error: 'Model already exists.' });
  }
  if (error.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed: model_families.title/i.test(error.message)) {
    return reply.code(400).send({ error: 'Model family already exists.' });
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
          .run(value.model, JSON.stringify(value.tiers), value.inputPrice, value.outputPrice, position, value.status);
        replaceFamilies(db, result.lastInsertRowid, value.familyIds);
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
      // Omitted status/families keep their stored values, so an older client
      // editing prices cannot silently switch a model off or drop its families.
      const value = validate(db, request.body, { status: before.status, familyIds: snapshot(before).familyIds });
      return transaction(db, () => {
        db.prepare('UPDATE model_catalog SET model = ?, tiers = ?, input_price = ?, output_price = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(value.model, JSON.stringify(value.tiers), value.inputPrice, value.outputPrice, value.status, current.id);
        replaceFamilies(db, current.id, value.familyIds);
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
      db.prepare('DELETE FROM model_family_links WHERE model_id = ?').run(current.id);
      db.prepare('DELETE FROM model_catalog WHERE id = ?').run(current.id);
    });
    return { ok: true };
  });

  app.get('/api/model-families', async (request, reply) => {
    if (!authorized(request, reply)) return reply;
    return families(db);
  });

  app.post('/api/model-families', async (request, reply) => {
    if (!authorized(request, reply, true)) return reply;
    try {
      const title = familyTitle(request.body);
      const created = transaction(db, () => {
        const result = db.prepare('INSERT INTO model_families (title) VALUES (?)').run(title);
        audit(db, {
          actorId: request.user.id, action: 'admin.create_model_family', targetType: 'model_family', targetId: result.lastInsertRowid,
          detail: JSON.stringify({ after: { title } }), ip: request.ip,
        });
        return families(db).find((family) => family.id === Number(result.lastInsertRowid));
      });
      return reply.code(201).send(created);
    } catch (error) { return errorReply(reply, error); }
  });

  app.patch('/api/model-families/:id', async (request, reply) => {
    if (!authorized(request, reply, true)) return reply;
    const current = db.prepare('SELECT * FROM model_families WHERE id = ?').get(request.params.id);
    if (!current) return reply.code(404).send({ error: 'Model family not found' });
    try {
      const title = familyTitle(request.body);
      return transaction(db, () => {
        db.prepare('UPDATE model_families SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(title, current.id);
        audit(db, {
          actorId: request.user.id, action: 'admin.update_model_family', targetType: 'model_family', targetId: current.id,
          detail: JSON.stringify({ before: { title: current.title }, after: { title } }), ip: request.ip,
        });
        return families(db).find((family) => family.id === current.id);
      });
    } catch (error) { return errorReply(reply, error); }
  });

  app.delete('/api/model-families/:id', async (request, reply) => {
    if (!authorized(request, reply, true)) return reply;
    const current = db.prepare('SELECT * FROM model_families WHERE id = ?').get(request.params.id);
    if (!current) return reply.code(404).send({ error: 'Model family not found' });
    const unlinkedModels = transaction(db, () => {
      const unlinked = db.prepare('DELETE FROM model_family_links WHERE family_id = ?').run(current.id).changes;
      db.prepare('DELETE FROM model_families WHERE id = ?').run(current.id);
      audit(db, {
        actorId: request.user.id, action: 'admin.delete_model_family', targetType: 'model_family', targetId: current.id,
        detail: JSON.stringify({ before: { title: current.title }, unlinkedModels: unlinked }), ip: request.ip,
      });
      return unlinked;
    });
    return { ok: true, unlinkedModels };
  });

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
