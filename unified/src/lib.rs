mod request_conversion;
mod response_conversion;

use aes_gcm::{
    aead::{Aead, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use chrono::{DateTime, Utc};
use futures_util::StreamExt;
use rand::RngCore;
use response_conversion::{Protocol, StreamTranslator};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::Path as FsPath,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;
use tower_http::services::{ServeDir, ServeFile};
use uuid::Uuid;

const CODEX_DEFAULT_INSTRUCTIONS: &str = include_str!("codex_default_instructions.txt");
const CLAUDE_CODE_SENTINEL: &str = "You are Claude Code, Anthropic's official CLI for Claude.";
const CLAUDE_CLI_USER_AGENT: &str = "claude-cli/2.1.0 (external, sdk-cli)";
const CLAUDE_OAUTH_BETA: &str = "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advanced-tool-use-2025-11-20,effort-2025-11-24,structured-outputs-2025-12-15,fast-mode-2026-02-01,redact-thinking-2026-02-12,token-efficient-tools-2026-03-28";

const SCHEMA: &str = r#"
PRAGMA foreign_keys=ON;
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','user')), disabled INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id), provider TEXT NOT NULL, display_name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, credential_status TEXT NOT NULL DEFAULT 'active', access_expires_at TEXT, token_version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS connections(id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id), account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL, provider TEXT NOT NULL, name TEXT NOT NULL, protocol TEXT NOT NULL, base_url TEXT NOT NULL, auth_type TEXT NOT NULL, credential_envelope TEXT, enabled INTEGER NOT NULL DEFAULT 1, priority INTEGER NOT NULL DEFAULT 0, expires_at TEXT, token_version INTEGER NOT NULL DEFAULT 0, external_id TEXT UNIQUE, cooldown_until INTEGER NOT NULL DEFAULT 0, account_subject TEXT);
CREATE INDEX IF NOT EXISTS connections_provider ON connections(provider,enabled,priority);
CREATE TABLE IF NOT EXISTS portal_tombstones(external_id TEXT PRIMARY KEY, token_version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS models(id TEXT PRIMARY KEY, upstream_model TEXT NOT NULL, provider TEXT NOT NULL, protocol TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS combos(name TEXT PRIMARY KEY, models TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS api_keys(id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id), name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS usage(id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id), key_id TEXT, model TEXT NOT NULL, connection_id TEXT, status INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS raw_imports(source TEXT NOT NULL, table_name TEXT NOT NULL, source_id TEXT NOT NULL, row_envelope TEXT NOT NULL, PRIMARY KEY(source,table_name,source_id));
"#;

#[derive(Clone)]
pub struct Config {
    pub db_path: String,
    pub encryption_key: [u8; 32],
    pub admin_username: String,
    pub admin_password: String,
    pub allow_upstream: bool,
    pub portal_sync_token: Option<String>,
    pub web_dir: String,
}
impl Config {
    pub fn from_env() -> Result<Self, String> {
        let raw = std::env::var("UNIFIED_ENCRYPTION_KEY")
            .map_err(|_| "UNIFIED_ENCRYPTION_KEY required")?;
        let decoded = STANDARD
            .decode(raw)
            .map_err(|_| "UNIFIED_ENCRYPTION_KEY must be base64")?;
        let encryption_key: [u8; 32] = decoded
            .try_into()
            .map_err(|_| "UNIFIED_ENCRYPTION_KEY must decode to 32 bytes")?;
        Ok(Self {
            db_path: std::env::var("UNIFIED_DATABASE_PATH")
                .unwrap_or_else(|_| "./data/unified.sqlite".into()),
            encryption_key,
            admin_username: std::env::var("UNIFIED_ADMIN_USERNAME")
                .unwrap_or_else(|_| "admin".into()),
            admin_password: std::env::var("UNIFIED_ADMIN_PASSWORD").unwrap_or_default(),
            allow_upstream: std::env::var("UNIFIED_ALLOW_UPSTREAM").as_deref() == Ok("true"),
            portal_sync_token: std::env::var("PORTAL_SYNC_TOKEN")
                .ok()
                .filter(|s| !s.is_empty()),
            web_dir: std::env::var("UNIFIED_WEB_DIR").unwrap_or_else(|_| "web/dist".into()),
        })
    }
}
#[derive(Clone)]
pub struct AppState {
    db: Arc<Mutex<Connection>>,
    key: [u8; 32],
    allow_upstream: bool,
    sync_token: Option<String>,
    client: reqwest::Client,
    attempts: Arc<Mutex<HashMap<String, (u32, Instant)>>>,
}
#[derive(Clone)]
struct User {
    id: i64,
    username: String,
    role: String,
    token_hash: String,
}
type ApiResult = Result<Response, (StatusCode, Json<Value>)>;
fn err(status: StatusCode, msg: &str) -> (StatusCode, Json<Value>) {
    (status, Json(json!({"error":msg})))
}
fn internal() -> (StatusCode, Json<Value>) {
    err(StatusCode::INTERNAL_SERVER_ERROR, "Internal error")
}
fn hash(s: &str) -> String {
    format!("{:x}", Sha256::digest(s.as_bytes()))
}
fn token() -> String {
    let mut b = [0u8; 32];
    OsRng.fill_bytes(&mut b);
    URL_SAFE_NO_PAD.encode(b)
}
fn id() -> String {
    Uuid::new_v4().to_string()
}
pub fn encrypt(key: &[u8; 32], text: &str) -> Result<String, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "invalid key")?;
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce), text.as_bytes())
        .map_err(|_| "encrypt failed")?;
    Ok(format!(
        "v1.{}.{}",
        URL_SAFE_NO_PAD.encode(nonce),
        URL_SAFE_NO_PAD.encode(ct)
    ))
}
fn decrypt(key: &[u8; 32], text: &str) -> Result<String, String> {
    let p: Vec<_> = text.split('.').collect();
    if p.len() != 3 || p[0] != "v1" {
        return Err("invalid envelope".into());
    };
    let n = URL_SAFE_NO_PAD
        .decode(p[1])
        .map_err(|_| "invalid envelope")?;
    if n.len() != 12 {
        return Err("invalid envelope".into());
    };
    let ct = URL_SAFE_NO_PAD
        .decode(p[2])
        .map_err(|_| "invalid envelope")?;
    let bytes = Aes256Gcm::new_from_slice(key)
        .map_err(|_| "invalid key")?
        .decrypt(Nonce::from_slice(&n), ct.as_ref())
        .map_err(|_| "decrypt failed")?;
    String::from_utf8(bytes).map_err(|_| "invalid plaintext".into())
}
fn password_hash(password: &str) -> Result<String, String> {
    Argon2::default()
        .hash_password(password.as_bytes(), &SaltString::generate(&mut OsRng))
        .map(|v| v.to_string())
        .map_err(|_| "hash failed".into())
}
fn text<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k)?.as_str().filter(|s| !s.trim().is_empty())
}
fn boolval(v: &Value, k: &str, default: bool) -> bool {
    v.get(k).and_then(Value::as_bool).unwrap_or(default)
}
fn bearer(h: &HeaderMap) -> Option<&str> {
    h.get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .filter(|x| !x.is_empty())
}
impl AppState {
    pub fn new(config: &Config) -> Result<Self, String> {
        if config.db_path != ":memory:" {
            if let Some(parent) = FsPath::new(&config.db_path)
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
            {
                std::fs::create_dir_all(parent).map_err(|_| "cannot create database directory")?;
            }
        }
        let db = Connection::open(&config.db_path).map_err(|_| "cannot open database")?;
        db.execute_batch(SCHEMA)
            .map_err(|_| "cannot initialize database")?;
        let has_subject = {
            let mut q = db
                .prepare("PRAGMA table_info(connections)")
                .map_err(|_| "database error")?;
            let names = q
                .query_map([], |r| r.get::<_, String>(1))
                .map_err(|_| "database error")?;
            names
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| "database error")?
                .iter()
                .any(|x| x == "account_subject")
        };
        if !has_subject {
            db.execute(
                "ALTER TABLE connections ADD COLUMN account_subject TEXT",
                [],
            )
            .map_err(|_| "database migration failed")?;
        }
        let admins: i64 = db
            .query_row(
                "SELECT count(*) FROM users WHERE role='admin' AND disabled=0",
                [],
                |r| r.get(0),
            )
            .map_err(|_| "database error")?;
        if admins == 0 {
            if config.admin_password.len() < 12
                || config.admin_password.len() > 256
                || config.admin_username.trim().is_empty()
            {
                return Err("UNIFIED_ADMIN_PASSWORD (12-256 chars) and admin username required for bootstrap".into());
            };
            let ph = password_hash(&config.admin_password)?;
            db.execute(
                "INSERT INTO users(username,password_hash,role) VALUES(?1,?2,'admin')",
                params![config.admin_username, ph],
            )
            .map_err(|_| "cannot bootstrap admin")?;
        }
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(180))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "cannot build HTTP client")?;
        Ok(Self {
            db: Arc::new(Mutex::new(db)),
            key: config.encryption_key,
            allow_upstream: config.allow_upstream,
            sync_token: config.portal_sync_token.clone(),
            client,
            attempts: Arc::new(Mutex::new(HashMap::new())),
        })
    }
    fn user(&self, h: &HeaderMap) -> Result<User, (StatusCode, Json<Value>)> {
        let t = bearer(h).ok_or_else(|| err(StatusCode::UNAUTHORIZED, "Not authenticated"))?;
        let th = hash(t);
        let db = self.db.lock().map_err(|_| internal())?;
        db.query_row("SELECT u.id,u.username,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?1 AND s.expires_at>unixepoch() AND u.disabled=0",[&th],|r|Ok(User{id:r.get(0)?,username:r.get(1)?,role:r.get(2)?,token_hash:th.clone()})).optional().map_err(|_|internal())?.ok_or_else(||err(StatusCode::UNAUTHORIZED,"Not authenticated"))
    }
}
fn require_admin(u: &User) -> Result<(), (StatusCode, Json<Value>)> {
    if u.role != "admin" {
        Err(err(StatusCode::FORBIDDEN, "Admin role required"))
    } else {
        Ok(())
    }
}
pub fn router(state: AppState, web_dir: &str) -> Router {
    let index = format!("{}/index.html", web_dir.trim_end_matches('/'));
    Router::new()
        .route(
            "/health/live",
            get(|| async { Json(json!({"status":"ok"})) }),
        )
        .route(
            "/health/ready",
            get(|| async { Json(json!({"status":"ready"})) }),
        )
        .route("/api/login", post(login))
        .route("/api/logout", post(logout))
        .route("/api/me", get(me))
        .route("/api/overview", get(overview))
        .route("/api/admin/users", get(users).post(create_user))
        .route(
            "/api/internal/portal/connections/:external_id",
            get(portal_get).put(portal_put).delete(portal_delete),
        )
        .route("/api/:resource", get(list).post(create))
        .route(
            "/api/:resource/:id",
            axum::routing::put(update).delete(delete),
        )
        .route("/v1/models", get(gateway_models))
        .route("/v1/chat/completions", post(gateway))
        .route("/v1/responses", post(gateway))
        .route("/v1/messages", post(gateway))
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .fallback_service(ServeDir::new(web_dir).not_found_service(ServeFile::new(index)))
        .with_state(state)
}
async fn login(State(s): State<AppState>, Json(v): Json<Value>) -> ApiResult {
    let name = text(&v, "username").unwrap_or("");
    let pass = text(&v, "password").unwrap_or("");
    if name.len() > 64 || pass.len() > 256 {
        return Err(err(
            StatusCode::UNAUTHORIZED,
            "Invalid username or password",
        ));
    }
    {
        let mut a = s.attempts.lock().map_err(|_| internal())?;
        a.retain(|_, (_, t)| t.elapsed() < Duration::from_secs(300));
        let entry = a.entry(name.to_lowercase()).or_insert((0, Instant::now()));
        if entry.0 >= 10 {
            return Err(err(
                StatusCode::TOO_MANY_REQUESTS,
                "Too many login attempts",
            ));
        }
        entry.0 += 1;
    }
    let row = {
        let db = s.db.lock().map_err(|_| internal())?;
        db.query_row(
            "SELECT id,username,role,password_hash,disabled FROM users WHERE username=?1",
            [name],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|_| internal())?
    };
    let (uid, username, role, ph, disabled) =
        row.ok_or_else(|| err(StatusCode::UNAUTHORIZED, "Invalid username or password"))?;
    if disabled != 0
        || !PasswordHash::new(&ph).ok().is_some_and(|p| {
            Argon2::default()
                .verify_password(pass.as_bytes(), &p)
                .is_ok()
        })
    {
        return Err(err(
            StatusCode::UNAUTHORIZED,
            "Invalid username or password",
        ));
    };
    let t = token();
    let db = s.db.lock().map_err(|_| internal())?;
    db.execute("DELETE FROM sessions WHERE expires_at<=unixepoch()", [])
        .map_err(|_| internal())?;
    db.execute(
        "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?1,?2,unixepoch()+86400)",
        params![hash(&t), uid],
    )
    .map_err(|_| internal())?;
    Ok(
        Json(json!({"id":uid,"username":username,"role":role,"token":t,"expiresIn":86400}))
            .into_response(),
    )
}
async fn logout(State(s): State<AppState>, h: HeaderMap) -> ApiResult {
    let u = s.user(&h)?;
    s.db.lock()
        .map_err(|_| internal())?
        .execute("DELETE FROM sessions WHERE token_hash=?1", [u.token_hash])
        .map_err(|_| internal())?;
    Ok(Json(json!({"ok":true})).into_response())
}
async fn me(State(s): State<AppState>, h: HeaderMap) -> ApiResult {
    let u = s.user(&h)?;
    Ok(Json(json!({"id":u.id,"username":u.username,"role":u.role})).into_response())
}
async fn users(State(s): State<AppState>, h: HeaderMap) -> ApiResult {
    let u = s.user(&h)?;
    require_admin(&u)?;
    let db = s.db.lock().map_err(|_| internal())?;
    let mut q = db
        .prepare("SELECT id,username,role,disabled FROM users ORDER BY id")
        .map_err(|_| internal())?;
    let rows=q.query_map([],|r|Ok(json!({"id":r.get::<_,i64>(0)?,"username":r.get::<_,String>(1)?,"role":r.get::<_,String>(2)?,"disabled":r.get::<_,i64>(3)?!=0}))).map_err(|_|internal())?.collect::<Result<Vec<_>,_>>().map_err(|_|internal())?;
    Ok(Json(rows).into_response())
}
async fn create_user(State(s): State<AppState>, h: HeaderMap, Json(v): Json<Value>) -> ApiResult {
    let u = s.user(&h)?;
    require_admin(&u)?;
    let name =
        text(&v, "username").ok_or_else(|| err(StatusCode::BAD_REQUEST, "username required"))?;
    let pass =
        text(&v, "password").ok_or_else(|| err(StatusCode::BAD_REQUEST, "password required"))?;
    let role = text(&v, "role").unwrap_or("user");
    if name.len() < 3
        || name.len() > 64
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        || pass.len() < 12
        || pass.len() > 256
        || !(["user", "admin"].contains(&role))
    {
        return Err(err(StatusCode::BAD_REQUEST, "Invalid user"));
    }
    let ph = password_hash(pass).map_err(|_| internal())?;
    let db = s.db.lock().map_err(|_| internal())?;
    db.execute(
        "INSERT INTO users(username,password_hash,role) VALUES(?1,?2,?3)",
        params![name, ph, role],
    )
    .map_err(|_| err(StatusCode::CONFLICT, "User already exists"))?;
    Ok((
        StatusCode::CREATED,
        Json(json!({"id":db.last_insert_rowid(),"username":name,"role":role})),
    )
        .into_response())
}
async fn overview(State(s): State<AppState>, h: HeaderMap) -> ApiResult {
    let u = s.user(&h)?;
    let db = s.db.lock().map_err(|_| internal())?;
    let count = |sql: &str| -> Result<i64, (StatusCode, Json<Value>)> {
        db.query_row(sql, params![u.id, u.role], |r| r.get(0))
            .map_err(|_| internal())
    };
    Ok(Json(json!({"accounts":count("SELECT count(*) FROM accounts WHERE owner_id=?1 OR ?2='admin'")?,"connections":count("SELECT count(*) FROM connections WHERE owner_id=?1 OR ?2='admin'")?,"keys":count("SELECT count(*) FROM api_keys WHERE owner_id=?1 OR ?2='admin'")?,"usage":count("SELECT count(*) FROM usage WHERE owner_id=?1 OR ?2='admin'")?,"upstreamEnabled":s.allow_upstream,"refreshEnabled":false})).into_response())
}
async fn list(State(s): State<AppState>, Path(resource): Path<String>, h: HeaderMap) -> ApiResult {
    let u = s.user(&h)?;
    let db = s.db.lock().map_err(|_| internal())?;
    let sql=match resource.as_str(){"accounts"=>"SELECT json_object('id',id,'ownerId',owner_id,'provider',provider,'displayName',display_name,'enabled',json(CASE enabled WHEN 1 THEN 'true' ELSE 'false' END),'credentialStatus',credential_status,'accessExpiresAt',access_expires_at,'tokenVersion',token_version) FROM accounts WHERE owner_id=?1 OR ?2='admin' ORDER BY id", "connections"=>"SELECT json_object('id',id,'ownerId',owner_id,'accountId',account_id,'provider',provider,'name',name,'protocol',protocol,'baseUrl',base_url,'authType',auth_type,'hasCredential',json(CASE WHEN credential_envelope IS NULL THEN 'false' ELSE 'true' END),'enabled',json(CASE enabled WHEN 1 THEN 'true' ELSE 'false' END),'priority',priority,'expiresAt',expires_at,'tokenVersion',token_version,'externalId',external_id,'cooldownUntil',cooldown_until) FROM connections WHERE owner_id=?1 OR ?2='admin' ORDER BY priority,id", "models"=>"SELECT json_object('id',id,'upstreamModel',upstream_model,'provider',provider,'protocol',protocol,'enabled',json(CASE enabled WHEN 1 THEN 'true' ELSE 'false' END)) FROM models WHERE ?1 IS NOT NULL AND ?2 IS NOT NULL ORDER BY id", "combos"=>"SELECT json_object('name',name,'models',json(models),'enabled',json(CASE enabled WHEN 1 THEN 'true' ELSE 'false' END)) FROM combos WHERE ?1 IS NOT NULL AND ?2 IS NOT NULL ORDER BY name", "keys"=>"SELECT json_object('id',id,'ownerId',owner_id,'name',name,'enabled',json(CASE enabled WHEN 1 THEN 'true' ELSE 'false' END)) FROM api_keys WHERE owner_id=?1 OR ?2='admin' ORDER BY id", "usage"=>"SELECT json_object('id',id,'ownerId',owner_id,'keyId',key_id,'model',model,'connectionId',connection_id,'status',status,'createdAt',created_at) FROM usage WHERE owner_id=?1 OR ?2='admin' ORDER BY id DESC LIMIT 500", "imports"=>{require_admin(&u)?;"SELECT json_object('source',source,'table',table_name,'sourceId',source_id) FROM raw_imports WHERE ?1 IS NOT NULL AND ?2 IS NOT NULL ORDER BY source,table_name,source_id LIMIT 500"},_=>return Err(err(StatusCode::NOT_FOUND,"Not found"))};
    let mut q = db.prepare(sql).map_err(|_| internal())?;
    let rows = q
        .query_map(params![u.id, u.role], |r| r.get::<_, String>(0))
        .map_err(|_| internal())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| internal())?;
    let values: Vec<Value> = rows
        .iter()
        .filter_map(|r| serde_json::from_str(r).ok())
        .collect();
    Ok(Json(values).into_response())
}
fn valid_protocol(s: &str) -> bool {
    ["chat", "responses", "messages"].contains(&s)
}
fn valid_url(s: &str) -> bool {
    reqwest::Url::parse(s).ok().is_some_and(|u| {
        ["http", "https"].contains(&u.scheme())
            && u.host_str().is_some()
            && u.username().is_empty()
            && u.password().is_none()
            && u.query().is_none()
            && u.fragment().is_none()
    })
}
async fn create(
    State(s): State<AppState>,
    Path(resource): Path<String>,
    h: HeaderMap,
    Json(v): Json<Value>,
) -> ApiResult {
    let u = s.user(&h)?;
    if resource != "keys" {
        require_admin(&u)?
    }
    let uid = v.get("ownerId").and_then(Value::as_i64).unwrap_or(u.id);
    if uid != u.id && u.role != "admin" {
        return Err(err(StatusCode::FORBIDDEN, "Not allowed"));
    }
    let key = id();
    let db = s.db.lock().map_err(|_| internal())?;
    match resource.as_str() {
        "accounts" => {
            let provider = text(&v, "provider")
                .ok_or_else(|| err(StatusCode::BAD_REQUEST, "provider required"))?;
            let name = text(&v, "displayName")
                .ok_or_else(|| err(StatusCode::BAD_REQUEST, "displayName required"))?;
            db.execute("INSERT INTO accounts(id,owner_id,provider,display_name,enabled) VALUES(?1,?2,?3,?4,?5)",params![key,uid,provider,name,boolval(&v,"enabled",true)]).map_err(|_|err(StatusCode::BAD_REQUEST,"Invalid account"))?;
        }
        "connections" => {
            let provider = text(&v, "provider")
                .ok_or_else(|| err(StatusCode::BAD_REQUEST, "provider required"))?;
            let name =
                text(&v, "name").ok_or_else(|| err(StatusCode::BAD_REQUEST, "name required"))?;
            let proto = text(&v, "protocol").unwrap_or("");
            let url = text(&v, "baseUrl").unwrap_or("");
            let auth = text(&v, "authType").unwrap_or("api_key");
            let cred = text(&v, "credential")
                .ok_or_else(|| err(StatusCode::BAD_REQUEST, "credential required"))?;
            if !valid_protocol(proto)
                || !valid_url(url)
                || !["api_key", "bearer"].contains(&auth)
                || cred.len() > 16384
            {
                return Err(err(StatusCode::BAD_REQUEST, "Invalid connection"));
            }
            let envelope = encrypt(&s.key, cred).map_err(|_| internal())?;
            db.execute("INSERT INTO connections(id,owner_id,account_id,provider,name,protocol,base_url,auth_type,credential_envelope,enabled,priority,expires_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",params![key,uid,text(&v,"accountId"),provider,name,proto,url,auth,envelope,boolval(&v,"enabled",true),v.get("priority").and_then(Value::as_i64).unwrap_or(0),text(&v,"expiresAt")]).map_err(|_|err(StatusCode::BAD_REQUEST,"Invalid connection"))?;
        }
        "models" => {
            let model =
                text(&v, "id").ok_or_else(|| err(StatusCode::BAD_REQUEST, "id required"))?;
            let provider = text(&v, "provider")
                .ok_or_else(|| err(StatusCode::BAD_REQUEST, "provider required"))?;
            let proto = text(&v, "protocol").unwrap_or("");
            if !valid_protocol(proto) {
                return Err(err(StatusCode::BAD_REQUEST, "Invalid protocol"));
            }
            db.execute("INSERT INTO models(id,upstream_model,provider,protocol,enabled) VALUES(?1,?2,?3,?4,?5)",params![model,text(&v,"upstreamModel").unwrap_or(model),provider,proto,boolval(&v,"enabled",true)]).map_err(|_|err(StatusCode::CONFLICT,"Model exists or invalid"))?;
            return Ok((StatusCode::CREATED, Json(json!({"id":model}))).into_response());
        }
        "combos" => {
            let name =
                text(&v, "name").ok_or_else(|| err(StatusCode::BAD_REQUEST, "name required"))?;
            let models = v
                .get("models")
                .and_then(Value::as_array)
                .filter(|a| {
                    !a.is_empty()
                        && a.len() <= 100
                        && a.iter().all(|x| x.as_str().is_some_and(|s| !s.is_empty()))
                })
                .ok_or_else(|| {
                    err(
                        StatusCode::BAD_REQUEST,
                        "models must be a nonempty string array",
                    )
                })?;
            db.execute(
                "INSERT INTO combos(name,models,enabled) VALUES(?1,?2,?3)",
                params![
                    name,
                    serde_json::to_string(models).map_err(|_| internal())?,
                    boolval(&v, "enabled", true)
                ],
            )
            .map_err(|_| err(StatusCode::CONFLICT, "Combo exists or invalid"))?;
            return Ok((StatusCode::CREATED, Json(json!({"name":name}))).into_response());
        }
        "keys" => {
            let name =
                text(&v, "name").ok_or_else(|| err(StatusCode::BAD_REQUEST, "name required"))?;
            let secret = text(&v, "key")
                .filter(|x| x.len() >= 24 && x.len() <= 512)
                .ok_or_else(|| {
                    err(
                        StatusCode::BAD_REQUEST,
                        "key must contain 24-512 characters",
                    )
                })?;
            db.execute(
                "INSERT INTO api_keys(id,owner_id,name,key_hash,enabled) VALUES(?1,?2,?3,?4,?5)",
                params![key, uid, name, hash(secret), boolval(&v, "enabled", true)],
            )
            .map_err(|_| err(StatusCode::CONFLICT, "Key exists or invalid"))?;
        }
        _ => return Err(err(StatusCode::NOT_FOUND, "Not found")),
    };
    Ok((StatusCode::CREATED, Json(json!({"id":key}))).into_response())
}
async fn update(
    State(s): State<AppState>,
    Path((resource, id)): Path<(String, String)>,
    h: HeaderMap,
    Json(v): Json<Value>,
) -> ApiResult {
    let u = s.user(&h)?;
    if resource != "keys" && resource != "accounts" {
        require_admin(&u)?
    }
    let db = s.db.lock().map_err(|_| internal())?;
    let changed=match resource.as_str(){"accounts"=>db.execute("UPDATE accounts SET display_name=COALESCE(?1,display_name),enabled=COALESCE(?2,enabled) WHERE id=?3 AND (owner_id=?4 OR ?5='admin')",params![text(&v,"displayName"),v.get("enabled").and_then(Value::as_bool),id,u.id,u.role]),"keys"=>db.execute("UPDATE api_keys SET name=COALESCE(?1,name),enabled=COALESCE(?2,enabled) WHERE id=?3 AND (owner_id=?4 OR ?5='admin')",params![text(&v,"name"),v.get("enabled").and_then(Value::as_bool),id,u.id,u.role]),"connections"=>{if v.get("baseUrl").is_some_and(|x|!x.as_str().is_some_and(valid_url))||v.get("protocol").is_some_and(|x|!x.as_str().is_some_and(valid_protocol)){return Err(err(StatusCode::BAD_REQUEST,"Invalid connection"))}let cred=match text(&v,"credential"){Some(c)=>Some(encrypt(&s.key,c).map_err(|_|internal())?),None=>None};db.execute("UPDATE connections SET name=COALESCE(?1,name),base_url=COALESCE(?2,base_url),protocol=COALESCE(?3,protocol),credential_envelope=COALESCE(?4,credential_envelope),enabled=COALESCE(?5,enabled),priority=COALESCE(?6,priority),cooldown_until=0 WHERE id=?7 AND external_id IS NULL",params![text(&v,"name"),text(&v,"baseUrl"),text(&v,"protocol"),cred,v.get("enabled").and_then(Value::as_bool),v.get("priority").and_then(Value::as_i64),id])},"models"=>{if v.get("protocol").is_some_and(|x|!x.as_str().is_some_and(valid_protocol)){return Err(err(StatusCode::BAD_REQUEST,"Invalid protocol"))}db.execute("UPDATE models SET upstream_model=COALESCE(?1,upstream_model),provider=COALESCE(?2,provider),protocol=COALESCE(?3,protocol),enabled=COALESCE(?4,enabled) WHERE id=?5",params![text(&v,"upstreamModel"),text(&v,"provider"),text(&v,"protocol"),v.get("enabled").and_then(Value::as_bool),id])},"combos"=>{let models=match v.get("models"){Some(x)=>{let a=x.as_array().filter(|a|!a.is_empty()&&a.len()<=100&&a.iter().all(|x|x.as_str().is_some_and(|s|!s.is_empty()))).ok_or_else(||err(StatusCode::BAD_REQUEST,"Invalid models"))?;Some(serde_json::to_string(a).map_err(|_|internal())?)},None=>None};db.execute("UPDATE combos SET models=COALESCE(?1,models),enabled=COALESCE(?2,enabled) WHERE name=?3",params![models,v.get("enabled").and_then(Value::as_bool),id])},_=>return Err(err(StatusCode::NOT_FOUND,"Not found"))}.map_err(|_|internal())?;
    if changed == 0 {
        return Err(err(StatusCode::NOT_FOUND, "Not found"));
    }
    Ok(Json(json!({"ok":true})).into_response())
}
async fn delete(
    State(s): State<AppState>,
    Path((resource, id)): Path<(String, String)>,
    h: HeaderMap,
) -> ApiResult {
    let u = s.user(&h)?;
    if resource != "keys" && resource != "accounts" {
        require_admin(&u)?
    }
    let db = s.db.lock().map_err(|_| internal())?;
    let changed = match resource.as_str() {
        "accounts" => db.execute(
            "DELETE FROM accounts WHERE id=?1 AND (owner_id=?2 OR ?3='admin')",
            params![id, u.id, u.role],
        ),
        "keys" => db.execute(
            "DELETE FROM api_keys WHERE id=?1 AND (owner_id=?2 OR ?3='admin')",
            params![id, u.id, u.role],
        ),
        "connections" => db.execute(
            "DELETE FROM connections WHERE id=?1 AND external_id IS NULL",
            [id],
        ),
        "models" => db.execute("DELETE FROM models WHERE id=?1", [id]),
        "combos" => db.execute("DELETE FROM combos WHERE name=?1", [id]),
        _ => return Err(err(StatusCode::NOT_FOUND, "Not found")),
    }
    .map_err(|_| internal())?;
    if changed == 0 {
        return Err(err(StatusCode::NOT_FOUND, "Not found"));
    }
    Ok(Json(json!({"ok":true})).into_response())
}

fn sync_auth(s: &AppState, h: &HeaderMap) -> Result<(), (StatusCode, Json<Value>)> {
    let expected = s
        .sync_token
        .as_deref()
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "Unauthorized"))?;
    let supplied = bearer(h).unwrap_or("");
    if expected.len() != supplied.len()
        || !bool::from(expected.as_bytes().ct_eq(supplied.as_bytes()))
    {
        return Err(err(StatusCode::UNAUTHORIZED, "Unauthorized"));
    }
    Ok(())
}
async fn portal_get(State(s): State<AppState>, Path(ext): Path<String>, h: HeaderMap) -> ApiResult {
    sync_auth(&s, &h)?;
    let db = s.db.lock().map_err(|_| internal())?;
    let row=db.query_row("SELECT id,provider,enabled,expires_at,token_version FROM connections WHERE external_id=?1",[ext],|r|Ok(json!({"found":true,"id":r.get::<_,String>(0)?,"provider":r.get::<_,String>(1)?,"enabled":r.get::<_,i64>(2)?!=0,"expiresAt":r.get::<_,Option<String>>(3)?,"tokenVersion":r.get::<_,i64>(4)?}))).optional().map_err(|_|internal())?;
    match row {
        Some(x) => Ok(Json(x).into_response()),
        None => Err((StatusCode::NOT_FOUND, Json(json!({"found":false})))),
    }
}
async fn portal_put(
    State(s): State<AppState>,
    Path(ext): Path<String>,
    h: HeaderMap,
    Json(v): Json<Value>,
) -> ApiResult {
    sync_auth(&s, &h)?;
    let provider = text(&v, "provider").unwrap_or("");
    let access = text(&v, "accessToken").unwrap_or("");
    let expires = text(&v, "expiresAt").unwrap_or("");
    let version = v.get("tokenVersion").and_then(Value::as_i64).unwrap_or(0);
    if ext.is_empty()
        || ext.len() > 128
        || !["claude", "codex"].contains(&provider)
        || access.is_empty()
        || access.len() > 16384
        || version < 1
        || DateTime::parse_from_rfc3339(expires).is_err()
        || v.get("refreshToken").is_some()
    {
        return Err(err(StatusCode::BAD_REQUEST, "Invalid portal connection"));
    }
    let subject = v
        .get("providerSpecificData")
        .and_then(|d| {
            text(d, "workspaceId")
                .or_else(|| text(d, "chatgptAccountId"))
                .or_else(|| text(d, "accountId"))
        })
        .or_else(|| None);
    if subject.is_some_and(|x| x.len() > 512 || header::HeaderValue::from_str(x).is_err()) {
        return Err(err(StatusCode::BAD_REQUEST, "Invalid account subject"));
    }
    let envelope = encrypt(&s.key, access).map_err(|_| internal())?;
    let db = s.db.lock().map_err(|_| internal())?;
    let tomb: i64 = db
        .query_row(
            "SELECT count(*) FROM portal_tombstones WHERE external_id=?1",
            [&ext],
            |r| r.get(0),
        )
        .map_err(|_| internal())?;
    if tomb > 0 {
        return Err(err(StatusCode::CONFLICT, "Portal identity was deleted"));
    }
    let existing = db
        .query_row(
            "SELECT id,provider,token_version FROM connections WHERE external_id=?1",
            [&ext],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|_| internal())?;
    let cid = if let Some((cid, old, ver)) = existing {
        if old != provider {
            return Err(err(StatusCode::CONFLICT, "Provider cannot be changed"));
        }
        if version <= ver {
            return Err((
                StatusCode::CONFLICT,
                Json(json!({"error":"Stale tokenVersion","tokenVersion":ver})),
            ));
        }
        db.execute("UPDATE connections SET credential_envelope=?1,expires_at=?2,token_version=?3,enabled=?4,name=?5,cooldown_until=0,account_subject=COALESCE(?7,account_subject) WHERE id=?6",params![envelope,expires,version,boolval(&v,"enabled",true),text(&v,"displayName").or_else(||text(&v,"name")).unwrap_or(provider),cid,subject]).map_err(|_|internal())?;
        cid
    } else {
        let cid = id();
        let owner: i64 = db
            .query_row(
                "SELECT id FROM users WHERE role='admin' AND disabled=0 ORDER BY id LIMIT 1",
                [],
                |r| r.get(0),
            )
            .map_err(|_| internal())?;
        let (proto, base) = if provider == "claude" {
            ("messages", "https://api.anthropic.com/v1")
        } else {
            ("responses", "https://chatgpt.com/backend-api/codex")
        };
        db.execute("INSERT INTO connections(id,owner_id,provider,name,protocol,base_url,auth_type,credential_envelope,enabled,expires_at,token_version,external_id,account_subject) VALUES(?1,?2,?3,?4,?5,?6,'portal_oauth',?7,?8,?9,?10,?11,?12)",params![cid,owner,provider,text(&v,"displayName").or_else(||text(&v,"name")).unwrap_or(provider),proto,base,envelope,boolval(&v,"enabled",true),expires,version,ext,subject]).map_err(|_|internal())?;
        cid
    };
    Ok(Json(json!({"id":cid,"provider":provider,"enabled":boolval(&v,"enabled",true),"expiresAt":expires,"tokenVersion":version})).into_response())
}
async fn portal_delete(
    State(s): State<AppState>,
    Path(ext): Path<String>,
    h: HeaderMap,
) -> ApiResult {
    sync_auth(&s, &h)?;
    let mut db = s.db.lock().map_err(|_| internal())?;
    let tx = db.transaction().map_err(|_| internal())?;
    let version: Option<i64> = tx
        .query_row(
            "SELECT token_version FROM connections WHERE external_id=?1",
            [&ext],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| internal())?;
    let version = version.ok_or_else(|| (StatusCode::NOT_FOUND, Json(json!({"found":false}))))?;
    tx.execute("INSERT INTO portal_tombstones(external_id,token_version) VALUES(?1,?2) ON CONFLICT(external_id) DO UPDATE SET token_version=MAX(token_version,excluded.token_version)",params![ext,version]).map_err(|_|internal())?;
    tx.execute("DELETE FROM connections WHERE external_id=?1", [ext])
        .map_err(|_| internal())?;
    tx.commit().map_err(|_| internal())?;
    Ok(StatusCode::NO_CONTENT.into_response())
}
#[derive(Clone)]
struct GatewayKey {
    id: String,
    owner: i64,
}
fn gateway_key(s: &AppState, h: &HeaderMap) -> Result<GatewayKey, (StatusCode, Json<Value>)> {
    let raw = bearer(h)
        .or_else(|| h.get("x-api-key").and_then(|v| v.to_str().ok()))
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "API key required"))?;
    let db = s.db.lock().map_err(|_| internal())?;
    db.query_row("SELECT k.id,k.owner_id FROM api_keys k JOIN users u ON u.id=k.owner_id WHERE k.key_hash=?1 AND k.enabled=1 AND u.disabled=0",[hash(raw)],|r|Ok(GatewayKey{id:r.get(0)?,owner:r.get(1)?})).optional().map_err(|_|internal())?.ok_or_else(||err(StatusCode::UNAUTHORIZED,"Invalid API key"))
}
async fn gateway_models(State(s): State<AppState>, h: HeaderMap) -> ApiResult {
    let _ = gateway_key(&s, &h)?;
    let db = s.db.lock().map_err(|_| internal())?;
    let mut q=db.prepare("SELECT id,'model' FROM models WHERE enabled=1 UNION ALL SELECT name,'combo' FROM combos WHERE enabled=1 ORDER BY 1").map_err(|_|internal())?;
    let data=q.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"object":"model","owned_by":r.get::<_,String>(1)?}))).map_err(|_|internal())?.collect::<Result<Vec<_>,_>>().map_err(|_|internal())?;
    Ok(Json(json!({"object":"list","data":data})).into_response())
}
#[derive(Clone)]
struct Candidate {
    id: String,
    provider: String,
    protocol: String,
    upstream: String,
    base: String,
    auth: String,
    envelope: Option<String>,
    expires: Option<String>,
    subject: Option<String>,
}
fn canonical_provider(s: &str) -> &str {
    match s {
        "cc" | "claude" => "claude",
        "cx" | "codex" => "codex",
        _ => s,
    }
}
fn protocol(s: &str) -> Protocol {
    match s {
        "chat" => Protocol::Chat,
        "messages" => Protocol::Messages,
        _ => Protocol::Responses,
    }
}
fn candidates(
    s: &AppState,
    key: &GatewayKey,
    requested: &str,
) -> Result<Vec<Candidate>, (StatusCode, Json<Value>)> {
    let db = s.db.lock().map_err(|_| internal())?;
    let combo: Option<String> = db
        .query_row(
            "SELECT models FROM combos WHERE name=?1 AND enabled=1",
            [requested],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| internal())?;
    let ids: Vec<String> = if let Some(c) = combo {
        serde_json::from_str(&c).map_err(|_| internal())?
    } else {
        vec![requested.into()]
    };
    let mut out = Vec::new();
    for model in ids {
        let row: Option<(String, String, String, bool)> = db
            .query_row(
                "SELECT provider,upstream_model,protocol,enabled FROM models WHERE id=?1",
                [&model],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()
            .map_err(|_| internal())?;
        if row.as_ref().is_some_and(|r| !r.3) {
            continue;
        }
        let (provider, upstream, configured_protocol) = if let Some(row) = row {
            (row.0, row.1, Some(row.2))
        } else if let Some((p, m)) = model.split_once('/') {
            if p.is_empty() || m.is_empty() {
                continue;
            }
            (p.to_owned(), m.to_owned(), None)
        } else {
            continue;
        };
        let mut q = db.prepare("SELECT c.id,c.provider,c.protocol,c.base_url,c.auth_type,c.credential_envelope,c.expires_at,c.account_subject FROM connections c JOIN users u ON u.id=c.owner_id LEFT JOIN accounts a ON a.id=c.account_id WHERE c.enabled=1 AND c.cooldown_until<=unixepoch() AND (c.owner_id=?1 OR u.role='admin') AND (c.account_id IS NULL OR (a.enabled=1 AND a.credential_status='active')) ORDER BY c.priority,c.id").map_err(|_|internal())?;
        let rows = q
            .query_map([key.owner], |r| {
                Ok(Candidate {
                    id: r.get(0)?,
                    provider: r.get(1)?,
                    protocol: r.get(2)?,
                    upstream: upstream.clone(),
                    base: r.get(3)?,
                    auth: r.get(4)?,
                    envelope: r.get(5)?,
                    expires: r.get(6)?,
                    subject: r.get(7)?,
                })
            })
            .map_err(|_| internal())?;
        let mut matched = Vec::new();
        for c in rows {
            let c = c.map_err(|_| internal())?;
            if canonical_provider(&c.provider) == canonical_provider(&provider) {
                matched.push(c);
            }
        }
        // Prefer the connection protocol the model row declares, but fall back to
        // every protocol for the provider: the gateway can convert requests.
        let preferred: Vec<Candidate> = matched
            .iter()
            .filter(|c| {
                configured_protocol
                    .as_ref()
                    .is_none_or(|p| p == &c.protocol)
            })
            .cloned()
            .collect();
        if preferred.is_empty() {
            out.extend(matched);
        } else {
            out.extend(preferred);
        }
    }
    Ok(out)
}
fn usage(s: &AppState, k: &GatewayKey, model: &str, cid: Option<&str>, status: u16) {
    if let Ok(db) = s.db.lock() {
        let _ = db.execute(
            "INSERT INTO usage(owner_id,key_id,model,connection_id,status) VALUES(?1,?2,?3,?4,?5)",
            params![k.owner, k.id, model, cid, status],
        );
    }
}
/// Anthropic requires `max_tokens`. Clients that omit it (most OpenAI-style
/// streaming clients) get the same documented default the JS routers use.
fn ensure_message_token_limit(body: &mut Value, source: &str) {
    let limit = if body
        .get("tools")
        .and_then(Value::as_array)
        .is_some_and(|a| !a.is_empty())
    {
        32_000
    } else {
        64_000
    };
    let field = if source == "responses" {
        "max_output_tokens"
    } else {
        "max_tokens"
    };
    let missing = match source {
        "chat" => {
            body.get("max_tokens").is_none_or(Value::is_null)
                && body.get("max_completion_tokens").is_none_or(Value::is_null)
        }
        _ => body.get(field).is_none_or(Value::is_null),
    };
    if missing {
        body[field] = json!(limit);
    }
}
fn stream_error_event(target: Protocol) -> &'static str {
    match target {
        Protocol::Messages => "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"Upstream stream conversion failed\"}}\n\n",
        _ => "data: {\"error\":{\"message\":\"Upstream stream conversion failed\",\"type\":\"api_error\"}}\n\n",
    }
}
async fn gateway(
    State(s): State<AppState>,
    axum::extract::OriginalUri(uri): axum::extract::OriginalUri,
    h: HeaderMap,
    Json(body): Json<Value>,
) -> ApiResult {
    let k = gateway_key(&s, &h)?;
    if !s.allow_upstream {
        return Err(err(
            StatusCode::SERVICE_UNAVAILABLE,
            "Upstream requests disabled in parallel-copy mode",
        ));
    }
    let requested = text(&body, "model")
        .filter(|x| x.len() <= 256)
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "model required"))?
        .to_string();
    let source = match uri.path() {
        "/v1/chat/completions" => "chat",
        "/v1/responses" => "responses",
        "/v1/messages" => "messages",
        _ => return Err(err(StatusCode::NOT_FOUND, "Not found")),
    };
    let client_stream = match body.get("stream") {
        None | Some(Value::Bool(false)) => false,
        Some(Value::Bool(true)) => true,
        _ => return Err(err(StatusCode::BAD_REQUEST, "stream must be boolean")),
    };
    let cs = candidates(&s, &k, &requested)?;
    if cs.is_empty() {
        return Err(err(
            StatusCode::SERVICE_UNAVAILABLE,
            "No eligible connection",
        ));
    }
    let mut conversion_error = None;
    for c in cs {
        if c.expires.as_deref().is_some_and(|v| {
            DateTime::parse_from_rfc3339(v).map_or(true, |d| d.with_timezone(&Utc) <= Utc::now())
        }) {
            continue;
        }
        let Some(secret) = c
            .envelope
            .as_deref()
            .and_then(|x| decrypt(&s.key, x).ok())
            .filter(|x| !x.is_empty())
        else {
            continue;
        };
        if !valid_url(&c.base) {
            continue;
        }
        let oauth = c.auth == "portal_oauth";
        let codex = oauth && canonical_provider(&c.provider) == "codex";
        let claude = oauth && canonical_provider(&c.provider) == "claude";
        if oauth && !codex && !claude {
            continue;
        }
        let mut request = body.clone();
        if c.protocol == "messages" {
            ensure_message_token_limit(&mut request, source);
        }
        let mut payload =
            match request_conversion::convert(&request, source, &c.protocol, &c.upstream, codex) {
                Ok(x) => x,
                Err(e) => {
                    conversion_error = Some(e);
                    continue;
                }
            };
        if claude {
            let sentinel = json!({"type":"text","text":CLAUDE_CODE_SENTINEL});
            payload["system"] = match payload.get("system") {
                None => json!([{"type":"text","text":CLAUDE_CODE_SENTINEL}]),
                Some(Value::String(text)) => {
                    json!([{"type":"text","text":CLAUDE_CODE_SENTINEL},{"type":"text","text":text}])
                }
                Some(Value::Array(blocks)) => {
                    let already = blocks
                        .first()
                        .and_then(|b| b.get("text"))
                        .and_then(Value::as_str)
                        .is_some_and(|t| t == CLAUDE_CODE_SENTINEL);
                    if already {
                        payload["system"].clone()
                    } else {
                        let mut out = vec![sentinel];
                        out.extend(blocks.iter().cloned());
                        Value::Array(out)
                    }
                }
                Some(_) => {
                    return Err(err(
                        StatusCode::BAD_REQUEST,
                        "system must be a string or an array of text blocks",
                    ))
                }
            };
        }
        if codex {
            payload["prompt_cache_key"] = payload
                .get("prompt_cache_key")
                .cloned()
                .unwrap_or_else(|| json!(c.id));
            let allowed = [
                "model",
                "input",
                "instructions",
                "tools",
                "tool_choice",
                "stream",
                "store",
                "reasoning",
                "service_tier",
                "include",
                "prompt_cache_key",
                "client_metadata",
                "text",
                "parallel_tool_calls",
            ];
            if let Some(field) = payload
                .as_object()
                .unwrap()
                .keys()
                .find(|x| !allowed.contains(&x.as_str()))
            {
                conversion_error = Some(format!("codex: unsupported field '{field}'"));
                continue;
            }
            if body.get("store") == Some(&Value::Bool(true)) {
                conversion_error = Some("codex: store=true is unsupported".into());
                continue;
            }
            if payload.get("instructions").is_none() {
                payload["instructions"] = json!(CODEX_DEFAULT_INSTRUCTIONS);
            }
            let remote_image = payload
                .get("input")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|item| item.get("content").and_then(Value::as_array))
                .flatten()
                .any(|part| {
                    part.get("type").and_then(Value::as_str) == Some("input_image")
                        && !part
                            .get("image_url")
                            .and_then(Value::as_str)
                            .is_some_and(|u| u.starts_with("data:"))
                });
            if remote_image {
                conversion_error = Some(
                    "codex: remote image URLs are unsupported; inline images as data: URIs".into(),
                );
                continue;
            }
            if let Some(input) = payload.get_mut("input") {
                if let Some(items) = input.as_array_mut() {
                    for item in items {
                        if item.get("role").and_then(Value::as_str) == Some("system") {
                            item["role"] = json!("developer");
                        }
                    }
                } else if let Some(text) = input.as_str() {
                    *input = json!([{"type":"message","role":"user","content":[{"type":"input_text","text":text}]}]);
                }
            }
        }
        let suffix = match c.protocol.as_str() {
            "chat" => "/chat/completions",
            "responses" => "/responses",
            _ => "/messages",
        };
        let base = c.base.trim_end_matches('/');
        let endpoint = if base.ends_with(suffix) {
            base.to_string()
        } else {
            format!("{base}{suffix}")
        };
        let url = if claude {
            format!("{endpoint}?beta=true")
        } else {
            endpoint
        };
        let mut req = s
            .client
            .post(url)
            .header(header::CONTENT_TYPE, "application/json");
        if claude {
            req = req
                .bearer_auth(&secret)
                .header("anthropic-version", "2023-06-01")
                .header("anthropic-beta", CLAUDE_OAUTH_BETA)
                .header("user-agent", CLAUDE_CLI_USER_AGENT)
                .header("x-app", "cli")
                .header("anthropic-dangerous-direct-browser-access", "true");
        } else if codex {
            req = req
                .bearer_auth(&secret)
                .header("originator", "codex_cli_rs")
                .header("user-agent", "codex_cli_rs/0.167.1")
                .header("version", "0.167.1")
                .header("session_id", &c.id)
                .header(header::ACCEPT, "text/event-stream");
            if let Some(subject) = &c.subject {
                req = req.header("chatgpt-account-id", subject);
            }
        } else if c.protocol == "messages" && c.auth == "api_key" {
            req = req.header("x-api-key", &secret).header(
                "anthropic-version",
                h.get("anthropic-version")
                    .and_then(|x| x.to_str().ok())
                    .unwrap_or("2023-06-01"),
            );
            if let Some(beta) = h.get("anthropic-beta") {
                req = req.header("anthropic-beta", beta);
            }
        } else {
            req = req.bearer_auth(&secret);
            if c.protocol == "messages" {
                req = req.header("anthropic-version", "2023-06-01");
            }
        }
        match req.json(&payload).send().await {
            Ok(upstream) => {
                let status = upstream.status();
                if status == StatusCode::TOO_MANY_REQUESTS
                    || status.is_server_error()
                    || status == StatusCode::UNAUTHORIZED
                    || status == StatusCode::FORBIDDEN
                {
                    let delay = upstream
                        .headers()
                        .get(header::RETRY_AFTER)
                        .and_then(|x| x.to_str().ok())
                        .and_then(|x| x.parse::<i64>().ok())
                        .unwrap_or(30)
                        .clamp(1, 300);
                    if let Ok(db) = s.db.lock() {
                        let _ = db.execute(
                            "UPDATE connections SET cooldown_until=unixepoch()+?1 WHERE id=?2",
                            params![delay, c.id],
                        );
                    }
                    continue;
                }
                usage(&s, &k, &requested, Some(&c.id), status.as_u16());
                if !status.is_success() {
                    return Err(err(status, "Upstream rejected request"));
                }
                let conversion = source != c.protocol;
                if !conversion && (client_stream || !codex) {
                    let content_type = upstream.headers().get(header::CONTENT_TYPE).cloned();
                    let mut result = Response::new(Body::from_stream(upstream.bytes_stream()));
                    *result.status_mut() = status;
                    if let Some(v) = content_type {
                        result.headers_mut().insert(header::CONTENT_TYPE, v);
                    }
                    return Ok(result);
                }
                let up_proto = protocol(&c.protocol);
                let target_proto = protocol(source);
                if codex || client_stream {
                    if client_stream {
                        let mut input = upstream.bytes_stream();
                        let output = async_stream::stream! {
                            let mut translator=StreamTranslator::new(up_proto,target_proto);
                            let mut failed=false;
                            while let Some(chunk)=input.next().await {
                                match chunk { Ok(bytes)=>match translator.push(&bytes) {Ok(frames)=>for f in frames {yield Ok::<_,std::io::Error>(f);},Err(_)=>{failed=true;break;}}, Err(_)=>{failed=true;break;} }
                            }
                            if !failed {match translator.finish(){Ok(frames)=>for f in frames {yield Ok::<_,std::io::Error>(f);},Err(_)=>failed=true}}
                            if failed { yield Ok(stream_error_event(target_proto).to_string()); }
                        };
                        return Ok((
                            [
                                (header::CONTENT_TYPE, "text/event-stream"),
                                (header::CACHE_CONTROL, "no-cache"),
                            ],
                            Body::from_stream(output),
                        )
                            .into_response());
                    }
                    let mut stream = upstream.bytes_stream();
                    let mut t = StreamTranslator::new(up_proto, target_proto);
                    while let Some(chunk) = stream.next().await {
                        let b = chunk
                            .map_err(|_| err(StatusCode::BAD_GATEWAY, "Upstream stream failed"))?;
                        t.push(&b).map_err(|_| {
                            err(StatusCode::BAD_GATEWAY, "Upstream stream conversion failed")
                        })?;
                    }
                    t.finish().map_err(|_| {
                        err(StatusCode::BAD_GATEWAY, "Upstream stream conversion failed")
                    })?;
                    return Ok(Json(t.body().map_err(|_| {
                        err(StatusCode::BAD_GATEWAY, "Upstream stream conversion failed")
                    })?)
                    .into_response());
                }
                let bytes = upstream
                    .bytes()
                    .await
                    .map_err(|_| err(StatusCode::BAD_GATEWAY, "Upstream response failed"))?;
                return Ok(Json(
                    response_conversion::collect(up_proto, target_proto, &bytes).map_err(|_| {
                        err(
                            StatusCode::BAD_GATEWAY,
                            "Upstream response conversion failed",
                        )
                    })?,
                )
                .into_response());
            }
            Err(_) => {
                if let Ok(db) = s.db.lock() {
                    let _ = db.execute(
                        "UPDATE connections SET cooldown_until=unixepoch()+30 WHERE id=?1",
                        [c.id],
                    );
                }
                continue;
            }
        }
    }
    usage(&s, &k, &requested, None, 503);
    if let Some(e) = conversion_error {
        return Err((StatusCode::BAD_REQUEST, Json(json!({"error":e}))));
    }
    Err(err(
        StatusCode::SERVICE_UNAVAILABLE,
        "No eligible upstream succeeded",
    ))
}
