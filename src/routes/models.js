import { audit } from '../services/audit.js';

const TIERS = ['Ultra', 'Max', 'High', 'Medium'];
// Provider IDs keep their upstream casing and variant suffixes such as `:free`.
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9~][A-Za-z0-9._:~-]*$/;

function authorized(request, reply, admin = false) {
  if (!request.user) { reply.code(401).send({ error: 'Not authenticated' }); return false; }
  if (admin && request.user.role !== 'admin') { reply.code(403).send({ error: 'Admin role required' }); return false; }
  return true;
}

function validate(body) {
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
  return { model: body.model, tiers: TIERS.filter((tier) => body.tiers.includes(tier)), inputPrice: body.inputPrice, outputPrice: body.outputPrice };
}

function row(value) {
  return {
    id: value.id, model: value.model, tiers: JSON.parse(value.tiers),
    inputPrice: value.input_price, outputPrice: value.output_price, position: value.position,
  };
}

function list(db) {
  return db.prepare('SELECT * FROM model_catalog ORDER BY position, id').all().map(row);
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
  const { model, tiers, inputPrice, outputPrice } = value;
  return { model, tiers, inputPrice, outputPrice };
}

function errorReply(reply, error) {
  if (error instanceof TypeError || error instanceof RangeError) return reply.code(400).send({ error: error.message });
  if (error.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed: model_catalog.model/i.test(error.message)) {
    return reply.code(400).send({ error: 'Model already exists.' });
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
      const value = validate(request.body);
      const created = transaction(db, () => {
        const position = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS position FROM model_catalog').get().position;
        const result = db.prepare('INSERT INTO model_catalog (model, tiers, input_price, output_price, position) VALUES (?, ?, ?, ?, ?)')
          .run(value.model, JSON.stringify(value.tiers), value.inputPrice, value.outputPrice, position);
        audit(db, {
          actorId: request.user.id, action: 'admin.create_model', targetType: 'model', targetId: result.lastInsertRowid,
          detail: JSON.stringify({ after: value }), ip: request.ip,
        });
        return row(find(db, result.lastInsertRowid));
      });
      return reply.code(201).send(created);
    } catch (error) { return errorReply(reply, error); }
  });

  app.patch('/api/models/:id', async (request, reply) => {
    if (!authorized(request, reply, true)) return reply;
    const current = find(db, request.params.id);
    if (!current) return reply.code(404).send({ error: 'Model not found' });
    try {
      const value = validate(request.body);
      return transaction(db, () => {
        db.prepare('UPDATE model_catalog SET model = ?, tiers = ?, input_price = ?, output_price = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(value.model, JSON.stringify(value.tiers), value.inputPrice, value.outputPrice, current.id);
        audit(db, {
          actorId: request.user.id, action: 'admin.update_model', targetType: 'model', targetId: current.id,
          detail: JSON.stringify({ before: snapshot(row(current)), after: value }), ip: request.ip,
        });
        return row(find(db, current.id));
      });
    } catch (error) { return errorReply(reply, error); }
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
