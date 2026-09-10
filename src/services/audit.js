export function audit(db, { actorId = null, action, targetType, targetId = null, detail = null, ip = null }) {
  db.prepare(`
    INSERT INTO audit_log (actor_id, action, target_type, target_id, detail, ip)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(actorId, action, targetType, targetId === null ? null : String(targetId), detail, ip);
}
