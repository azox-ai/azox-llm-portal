// Reference catalog snapshot from azox-llm-gateway README (2026-10-01).
// Prices are USD per million input/output tokens; not LiteLLM billing settings.
const initialModels = [
  ['anthropic/claude-fable-5', 'Ultra', 10, 50],
  ['openai/gpt-6-astra', 'Ultra', 10, 50],
  ['anthropic/claude-opus-5-5', 'Max', 4, 20],
  ['openai/gpt-6.1-sol', 'Max', 2, 10],
  ['openai/gpt-6-sol', 'Max', 2, 10],
  ['anthropic/claude-sonnet-5-5', 'High', 2, 10],
  ['openai/gpt-5.6-terra', 'High', 2, 12],
  ['openai/gpt-6-luna', 'Medium', 0.1, 0.5],
  ['z-ai/glm-5.3', 'Max', 0.2219, 4.4],
  ['x-ai/grok-4.7', 'Max', 2, 6],
  ['x-ai/grok-4.6', 'Max', 2, 6],
  ['meta/muse-spark-1.3-contributor', 'Max', 0.1, 0.2],
  ['z-ai/glm-5.3-flash', 'High', 0.15, 0.5],
  ['xiaomi/mimo-v2.6-pro', 'High', 0.435, 0.87],
  ['deepseek/deepseek-v4.1-flash', 'High', 0.03, 0.5],
  ['deepseek/deepseek-v4-pro-0813', 'Medium', 1.32, 3.96],
  ['anthropic/claude-opus-5', 'Max', 5, 25],
  ['openai/gpt-5.6-sol', 'Max', 4, 20],
  ['anthropic/claude-sonnet-5', 'High', 2, 10],
  ['openai/gpt-5.6-luna', 'Medium', 0.2, 1.2],
];

const legacyTierTitles = new Map([
  ['Ultra', 'model-ultra'], ['Max', 'model-max'],
  ['High', 'model-high'], ['Medium', 'model-medium'],
]);

// The legacy JSON column stays populated with 1.5 tier names so a rolled-back
// image can still read and edit rows that use the four original tiers.
export function legacyTierValue(titles) {
  const legacy = new Map([...legacyTierTitles].map(([name, title]) => [title, name]));
  return JSON.stringify(titles.map((title) => legacy.get(title) ?? title));
}

// One-time conversion from the hard-coded tier list to admin-managed tiers.
// The sentinel keeps tiers an admin later deletes from being recreated.
export function migrateModelTiers(db) {
  if (db.prepare("SELECT value FROM app_settings WHERE key = 'model_tiers_migrated'").get()) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    const insertTier = db.prepare('INSERT INTO model_tiers (title) VALUES (?)');
    const tierByTitle = new Map(db.prepare('SELECT id, title FROM model_tiers').all().map(({ id, title }) => [title, id]));
    for (const title of legacyTierTitles.values()) {
      if (!tierByTitle.has(title)) tierByTitle.set(title, insertTier.run(title).lastInsertRowid);
    }
    const link = db.prepare('INSERT OR IGNORE INTO model_tier_links (model_id, tier_id) VALUES (?, ?)');
    for (const model of db.prepare('SELECT id, tiers FROM model_catalog').all()) {
      const names = JSON.parse(model.tiers).map((tier) => legacyTierTitles.get(tier) ?? tier);
      for (const name of names) {
        if (!tierByTitle.has(name)) tierByTitle.set(name, insertTier.run(name).lastInsertRowid);
        link.run(model.id, tierByTitle.get(name));
      }
    }
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('model_tiers_migrated', '1')").run();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function seedModelCatalog(db) {
  const insert = db.prepare('INSERT OR IGNORE INTO model_catalog (model, tiers, input_price, output_price, position) VALUES (?, ?, ?, ?, ?)');
  // Seed once only: the sentinel keeps later restarts from re-adding seed rows
  // whose model ID an admin has since renamed.
  if (db.prepare("SELECT value FROM app_settings WHERE key = 'model_catalog_seeded'").get()) return;
  db.exec('BEGIN');
  try {
    initialModels.forEach(([model, tier, inputPrice, outputPrice], index) =>
      insert.run(model, JSON.stringify([tier]), inputPrice, outputPrice, index + 1));
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('model_catalog_seeded', '1')").run();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
