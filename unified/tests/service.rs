use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tower::ServiceExt;
use unified_gateway::{router, AppState, Config};

type Seen = Arc<Mutex<Vec<(String, HashMap<String, String>, Value)>>>;

async fn mock(content_type: &'static str, response_body: String) -> (String, Seen) {
    let seen: Seen = Arc::new(Mutex::new(Vec::new()));
    let state = seen.clone();
    let handler = axum::routing::post(move |req: Request<Body>| {
        let state = state.clone();
        let response_body = response_body.clone();
        async move {
            let uri = req.uri().to_string();
            let headers = req.headers().clone();
            let bytes = req.into_body().collect().await.unwrap().to_bytes();
            let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            let map = headers
                .iter()
                .map(|(k, v)| (k.as_str().to_string(), v.to_str().unwrap_or("").to_string()))
                .collect();
            state.lock().unwrap().push((uri, map, body));
            // Deliver in tiny chunks so every SSE/protocol path is exercised with
            // frame boundaries that do not line up with event boundaries.
            let chunks: Vec<Result<Vec<u8>, std::io::Error>> = response_body
                .into_bytes()
                .chunks(5)
                .map(|c| Ok(c.to_vec()))
                .collect();
            (
                [(axum::http::header::CONTENT_TYPE, content_type)],
                Body::from_stream(futures_util::stream::iter(chunks)),
            )
        }
    });
    let inner = Router::new().fallback(handler);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, inner).await.unwrap() });
    (format!("http://{address}"), seen)
}

fn app(allow_upstream: bool) -> Router {
    app_with_db(allow_upstream, ":memory:")
}
fn app_with_db(allow_upstream: bool, db_path: &str) -> Router {
    let config = Config {
        db_path: db_path.into(),
        encryption_key: [7; 32],
        admin_username: "admin".into(),
        admin_password: "correct-horse-battery".into(),
        allow_upstream,
        portal_sync_token: Some("sync-secret".into()),
        web_dir: "nonexistent".into(),
    };
    router(AppState::new(&config).unwrap(), &config.web_dir)
}
async fn call(
    app: &Router,
    method: &str,
    path: &str,
    bearer: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if let Some(token) = bearer {
        req = req.header("authorization", format!("Bearer {token}"));
    }
    let response = app
        .clone()
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
async fn login(app: &Router, name: &str, password: &str) -> String {
    let (status, v) = call(
        app,
        "POST",
        "/api/login",
        None,
        json!({"username":name,"password":password}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    v["token"].as_str().unwrap().into()
}

#[tokio::test]
async fn auth_ownership_and_no_secret_responses() {
    let app = app(false);
    assert_eq!(
        call(&app, "GET", "/api/accounts", None, json!({})).await.0,
        StatusCode::UNAUTHORIZED
    );
    let admin = login(&app, "admin", "correct-horse-battery").await;
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/admin/users",
            Some(&admin),
            json!({"username":"alice","password":"alice-password-123"})
        )
        .await
        .0,
        StatusCode::CREATED
    );
    let alice = login(&app, "alice", "alice-password-123").await;
    assert_eq!(
        call(&app, "POST", "/api/models", Some(&alice), json!({}))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let (status,conn)=call(&app,"POST","/api/connections",Some(&admin),json!({"provider":"example","name":"one","protocol":"chat","baseUrl":"http://127.0.0.1:1/v1","credential":"super-secret-upstream"})).await;
    assert_eq!(status, StatusCode::CREATED);
    assert!(!conn.to_string().contains("super-secret"));
    let (_, rows) = call(&app, "GET", "/api/connections", Some(&admin), json!({})).await;
    assert!(!rows.to_string().contains("super-secret"));
    let (_, rows) = call(&app, "GET", "/api/connections", Some(&alice), json!({})).await;
    assert_eq!(rows.as_array().unwrap().len(), 0);
    assert_eq!(
        call(
            &app,
            "PUT",
            &format!("/api/connections/{}", conn["id"].as_str().unwrap()),
            Some(&alice),
            json!({"enabled":false})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(&app, "POST", "/api/logout", Some(&alice), json!({}))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        call(&app, "GET", "/api/me", Some(&alice), json!({}))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
}
#[tokio::test]
async fn portal_version_order_and_tombstone() {
    let app = app(false);
    let body = json!({"provider":"codex","accessToken":"hidden-token","expiresAt":"2030-01-01T00:00:00Z","tokenVersion":2});
    assert_eq!(
        call(
            &app,
            "PUT",
            "/api/internal/portal/connections/portal-1",
            None,
            body.clone()
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let (st, v) = call(
        &app,
        "PUT",
        "/api/internal/portal/connections/portal-1",
        Some("sync-secret"),
        body.clone(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert!(!v.to_string().contains("hidden-token"));
    assert_eq!(
        call(
            &app,
            "PUT",
            "/api/internal/portal/connections/portal-1",
            Some("sync-secret"),
            body.clone()
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let mut newer = body.clone();
    newer["tokenVersion"] = json!(3);
    assert_eq!(
        call(
            &app,
            "PUT",
            "/api/internal/portal/connections/portal-1",
            Some("sync-secret"),
            newer.clone()
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &app,
            "DELETE",
            "/api/internal/portal/connections/portal-1",
            Some("sync-secret"),
            json!({})
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    newer["tokenVersion"] = json!(4);
    assert_eq!(
        call(
            &app,
            "PUT",
            "/api/internal/portal/connections/portal-1",
            Some("sync-secret"),
            newer
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
}
#[tokio::test]
async fn default_gate_and_streaming_passthrough() {
    let mock = Router::new().route(
        "/v1/chat/completions",
        axum::routing::post(
            |headers: axum::http::HeaderMap, axum::Json(body): axum::Json<Value>| async move {
                assert_eq!(headers["authorization"], "Bearer provider-secret");
                assert_eq!(body["model"], "real-model");
                (
                    [("content-type", "text/event-stream")],
                    "data: first\n\ndata: [DONE]\n\n",
                )
            },
        ),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, mock).await.unwrap() });
    for enabled in [false, true] {
        let app = app(enabled);
        let admin = login(&app, "admin", "correct-horse-battery").await;
        assert_eq!(
            call(
                &app,
                "POST",
                "/api/keys",
                Some(&admin),
                json!({"name":"client","key":"client-key-with-at-least-24-characters"})
            )
            .await
            .0,
            StatusCode::CREATED
        );
        assert_eq!(call(&app,"POST","/api/connections",Some(&admin),json!({"provider":"example","name":"one","protocol":"chat","baseUrl":format!("http://{address}/v1"),"credential":"provider-secret"})).await.0,StatusCode::CREATED);
        assert_eq!(call(&app,"POST","/api/models",Some(&admin),json!({"id":"alias","provider":"example","protocol":"chat","upstreamModel":"real-model"})).await.0,StatusCode::CREATED);
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/chat/completions")
                    .header("content-type", "application/json")
                    .header(
                        "authorization",
                        "Bearer client-key-with-at-least-24-characters",
                    )
                    .body(Body::from(
                        json!({"model":"alias","stream":true,"messages":[]}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        if enabled {
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()["content-type"], "text/event-stream");
            let data = response.into_body().collect().await.unwrap().to_bytes();
            assert_eq!(&data[..], b"data: first\n\ndata: [DONE]\n\n");
            let (status, error) = call(
                &app,
                "POST",
                "/v1/messages",
                Some("client-key-with-at-least-24-characters"),
                json!({"model":"alias"}),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST);
            assert!(error["error"].as_str().unwrap().contains("messages"));
        } else {
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        }
    }
    server.abort();
}

async fn client_key(app: &Router, admin: &str) {
    assert_eq!(
        call(
            app,
            "POST",
            "/api/keys",
            Some(admin),
            json!({"name":"client","key":"client-key-with-at-least-24-characters"})
        )
        .await
        .0,
        StatusCode::CREATED
    );
}

async fn seed(app: &Router, admin: &str, provider: &str, protocol: &str, base: String) {
    assert_eq!(call(app,"POST","/api/connections",Some(admin),json!({"provider":provider,"name":provider,"protocol":protocol,"baseUrl":base,"credential":"upstream-secret-token"})).await.0,StatusCode::CREATED);
    assert_eq!(
        call(
            app,
            "POST",
            "/api/keys",
            Some(admin),
            json!({"name":"client","key":"client-key-with-at-least-24-characters"})
        )
        .await
        .0,
        StatusCode::CREATED
    );
}

#[tokio::test]
async fn claude_oauth_executes_with_headers_and_tool_conversion() {
    let claude_sse = concat!(
        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"model\":\"claude-up\",\"usage\":{\"input_tokens\":5}}}\n\n",
        "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"hi\"}}\n\n",
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\" there\"}}\n\n",
        "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
        "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"lookup\",\"input\":{}}}\n\n",
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"q\\\":\"}}\n\n",
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"\\\"x\\\"}\"}}\n\n",
        "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":1}\n\n",
        "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":7}}\n\n",
        "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
    let expected = claude_sse.to_string();
    let (base, seen) = mock("text/event-stream", expected).await;
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("test.sqlite");
    let app = app_with_db(true, db_path.to_str().unwrap());
    let admin = login(&app, "admin", "correct-horse-battery").await;
    let body = json!({"provider":"claude","accessToken":"sk-ant-oat-live-token","expiresAt":"2030-01-01T00:00:00Z","tokenVersion":1,"displayName":"Sponsored: me"});
    assert_eq!(
        call(
            &app,
            "PUT",
            "/api/internal/portal/connections/portal-claude",
            Some("sync-secret"),
            body
        )
        .await
        .0,
        StatusCode::OK
    );
    // Point this isolated test database at loopback, without exposing a sync API override.
    rusqlite::Connection::open(&db_path)
        .unwrap()
        .execute(
            "UPDATE connections SET base_url=?1 WHERE provider=?2",
            rusqlite::params![format!("{base}/v1"), "claude"],
        )
        .unwrap();
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/models",
            Some(&admin),
            json!({"id":"sonnet","provider":"cc","protocol":"messages","upstreamModel":"claude-up"})
        )
        .await
        .0,
        StatusCode::CREATED
    );
    seed(&app, &admin, "unused", "chat", format!("{base}/v1")).await;
    let response = app.clone().oneshot(Request::builder().method("POST").uri("/v1/chat/completions")
        .header("content-type","application/json").header("authorization","Bearer client-key-with-at-least-24-characters")
        .body(Body::from(json!({"model":"sonnet","stream":true,"max_tokens":64,"messages":[{"role":"system","content":"sys"},{"role":"user","content":"q"}],"tools":[{"type":"function","function":{"name":"lookup","parameters":{"type":"object"}}}]}).to_string())).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let text = String::from_utf8(
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec(),
    )
    .unwrap();
    assert!(text.contains("\"tool_calls\""), "{text}");
    assert!(text.contains("toolu_1"), "{text}");
    assert!(text.contains("\"hi\""), "{text}");
    assert!(text.contains("\" there\""), "{text}");
    assert!(text.contains("[DONE]"), "{text}");
    let requests = seen.lock().unwrap().clone();
    let claude = requests
        .iter()
        .find(|(u, _, _)| u.starts_with("/v1/messages"))
        .expect("claude call");
    assert_eq!(claude.0, "/v1/messages?beta=true");
    assert_eq!(claude.1["authorization"], "Bearer sk-ant-oat-live-token");
    assert_eq!(claude.1["anthropic-version"], "2023-06-01");
    assert!(claude.1["anthropic-beta"].contains("oauth-2025-04-20"));
    assert_eq!(claude.2["model"], "claude-up");
    assert_eq!(
        claude.2["system"][0]["text"],
        "You are Claude Code, Anthropic's official CLI for Claude."
    );
    assert_eq!(claude.2["system"][1]["text"], "sys");
    assert_eq!(claude.2["tools"][0]["name"], "lookup");
    assert_eq!(claude.2["messages"][0]["role"], "user");
    assert!(!requests
        .iter()
        .any(|(_, _, b)| b.to_string().contains("live-token")));
}

#[tokio::test]
async fn codex_oauth_binds_account_and_converts_tools() {
    let responses_sse = concat!(
        "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\",\"model\":\"gpt-up\"}}\n\n",
        "event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"function_call\",\"id\":\"fc_1\",\"call_id\":\"call_1\",\"name\":\"lookup\",\"arguments\":\"\"}}\n\n",
        "event: response.function_call_arguments.delta\ndata: {\"type\":\"response.function_call_arguments.delta\",\"output_index\":0,\"delta\":\"{\\\"q\\\":\\\"x\\\"}\"}\n\n",
        "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"model\":\"gpt-up\",\"usage\":{\"input_tokens\":2,\"output_tokens\":3}}}\n\n");
    let expected = responses_sse.to_string();
    let (base, seen) = mock("text/event-stream", expected).await;
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("test.sqlite");
    let app = app_with_db(true, db_path.to_str().unwrap());
    let admin = login(&app, "admin", "correct-horse-battery").await;
    let body = json!({"provider":"codex","accessToken":"codex-access-token","expiresAt":"2030-01-01T00:00:00Z","tokenVersion":1,"providerSpecificData":{"chatgptAccountId":"ws-subject-1"}});
    assert_eq!(
        call(
            &app,
            "PUT",
            "/api/internal/portal/connections/portal-codex",
            Some("sync-secret"),
            body
        )
        .await
        .0,
        StatusCode::OK
    );
    // Point this isolated test database at loopback, without exposing a sync API override.
    rusqlite::Connection::open(&db_path)
        .unwrap()
        .execute(
            "UPDATE connections SET base_url=?1 WHERE provider=?2",
            rusqlite::params![format!("{base}/backend-api/codex"), "codex"],
        )
        .unwrap();
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/models",
            Some(&admin),
            json!({"id":"gpt-hi","provider":"cx","protocol":"responses","upstreamModel":"gpt-up"})
        )
        .await
        .0,
        StatusCode::CREATED
    );
    seed(
        &app,
        &admin,
        "unused",
        "chat",
        format!("{base}/backend-api/codex"),
    )
    .await;
    // Provider alias model without a models row: provider/model split.
    let (status, out) = call(&app,"POST","/v1/messages",Some("client-key-with-at-least-24-characters"),json!({"model":"gpt-hi","messages":[{"role":"user","content":"call lookup"}],"tools":[{"name":"lookup","description":"d","input_schema":{"type":"object"}}]})).await;
    assert_eq!(status, StatusCode::OK, "{out}");
    assert_eq!(out["type"], "message");
    assert_eq!(out["content"][0]["type"], "tool_use");
    assert_eq!(out["content"][0]["input"]["q"], "x");
    assert_eq!(out["stop_reason"], "tool_use");
    let requests = seen.lock().unwrap().clone();
    let codex = requests
        .iter()
        .find(|(u, _, _)| u.starts_with("/backend-api/codex"))
        .expect("codex call");
    assert_eq!(codex.0, "/backend-api/codex/responses");
    assert_eq!(codex.1["authorization"], "Bearer codex-access-token");
    assert_eq!(codex.1["chatgpt-account-id"], "ws-subject-1");
    assert_eq!(codex.1["originator"], "codex_cli_rs");
    assert_eq!(codex.2["store"], false);
    assert_eq!(codex.2["stream"], true);
    assert_eq!(codex.2["model"], "gpt-up");
    assert!(codex.2["instructions"]
        .as_str()
        .unwrap()
        .starts_with("You are Codex"));
    assert_eq!(codex.2["tools"][0]["type"], "function");
    assert_eq!(codex.2["tools"][0]["name"], "lookup");
    assert_eq!(codex.2["input"][0]["content"][0]["text"], "call lookup");
}

#[tokio::test]
async fn imported_alias_config_matches_and_validates_unsupported_fields() {
    let (base, seen) = mock(
        "application/json",
        "{\"id\":\"m1\",\"model\":\"claude-y\",\"content\":[{\"type\":\"text\",\"text\":\"ok\"}],\"stop_reason\":\"end_turn\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}".into(),
    )
    .await;
    let (codex_base, codex_seen) = mock(
        "application/json",
        "{\"id\":\"r1\",\"model\":\"gpt-up\",\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"id\":\"msg_1\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"ok\",\"annotations\":[]}]}]}".into(),
    )
    .await;
    let app = app(true);
    let admin = login(&app, "admin", "correct-horse-battery").await;
    seed(&app, &admin, "claude", "messages", format!("{base}/v1")).await;
    // A models row imported with the short provider alias must reach a claude connection.
    assert_eq!(call(&app,"POST","/api/models",Some(&admin),json!({"id":"cc-model","provider":"cc","protocol":"messages","upstreamModel":"claude-x"})).await.0,StatusCode::CREATED);
    let (status, err) = call(&app,"POST","/v1/chat/completions",Some("client-key-with-at-least-24-characters"),json!({"model":"cc-model","messages":[{"role":"user","content":"x"}],"response_format":{"type":"json_object"}})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        err["error"].as_str().unwrap().contains("response_format"),
        "{err}"
    );
    assert!(seen.lock().unwrap().is_empty());
    // No models row: provider/model syntax resolves through the same alias canonicalisation.
    assert_eq!(
        call(
            &app,
            "POST",
            "/v1/chat/completions",
            Some("client-key-with-at-least-24-characters"),
            json!({"model":"cc/claude-y","max_tokens":8,"messages":[{"role":"user","content":"x"}]})
        )
        .await
        .0,
        StatusCode::OK
    );
    let requests = seen.lock().unwrap().clone();
    assert_eq!(requests[0].0, "/v1/messages");
    assert_eq!(requests[0].1["x-api-key"], "upstream-secret-token");
    assert_eq!(requests[0].2["model"], "claude-y");
    assert_eq!(requests[0].2["system"].as_str(), None);
    assert_eq!(requests[0].2["messages"][0]["content"][0]["text"], "x");
    // Combos may mix unknown models with alias-provider models; the reachable path wins.
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/combos",
            Some(&admin),
            json!({"name":"mix","models":["ghost","cc-model"]})
        )
        .await
        .0,
        StatusCode::CREATED
    );
    let (status, out) = call(&app,"POST","/v1/chat/completions",Some("client-key-with-at-least-24-characters"),json!({"model":"mix","stream_options":{"include_usage":true},"messages":[{"role":"user","content":"combo"}]})).await;
    assert_eq!(status, StatusCode::OK, "{out}");
    assert_eq!(out["choices"][0]["message"]["content"], "ok");
    let requests = seen.lock().unwrap().clone();
    assert_eq!(
        requests.last().unwrap().2["messages"][0]["content"][0]["text"],
        "combo"
    );
    // A models row imported with the cx alias reaches a codex connection via provider canonicalisation.
    assert_eq!(call(&app,"POST","/api/connections",Some(&admin),json!({"provider":"codex","name":"cx","protocol":"responses","baseUrl":format!("{codex_base}/backend-api/codex"),"credential":"cx-secret"})).await.0,StatusCode::CREATED);
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/models",
            Some(&admin),
            json!({"id":"gpt-bare","provider":"cx","protocol":"responses","upstreamModel":"gpt-up"})
        )
        .await
        .0,
        StatusCode::CREATED
    );
    let (status, out) = call(
        &app,
        "POST",
        "/v1/chat/completions",
        Some("client-key-with-at-least-24-characters"),
        json!({"model":"gpt-bare","messages":[{"role":"user","content":"hi"}]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{out}");
    assert_eq!(out["choices"][0]["message"]["content"], "ok");
    let codex_requests = codex_seen.lock().unwrap().clone();
    assert_eq!(codex_requests[0].0, "/backend-api/codex/responses");
    assert_eq!(codex_requests[0].1["authorization"], "Bearer cx-secret");
    assert_eq!(codex_requests[0].2["input"][0]["content"][0]["text"], "hi");
}

#[tokio::test]
async fn codex_stream_conversion_chunk_boundaries_text_and_usage() {
    let upstream = concat!(
        "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_s\",\"model\":\"gpt-up\"}}\n\n",
        "event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"message\",\"id\":\"msg_1\",\"role\":\"assistant\",\"content\":[]}}\n\n",
        "event: response.content_part.added\ndata: {\"type\":\"response.content_part.added\",\"output_index\":0,\"content_index\":0,\"part\":{\"type\":\"output_text\",\"text\":\"\",\"annotations\":[]}}\n\n",
        "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"content_index\":0,\"delta\":\"hel\"}\n\n",
        "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"content_index\":0,\"delta\":\"lo\"}\n\n",
        "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_s\",\"model\":\"gpt-up\",\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"hello\",\"annotations\":[]}]}],\"usage\":{\"input_tokens\":4,\"output_tokens\":2}}}\n\n");
    let (base, _seen) = mock("text/event-stream", upstream.into()).await;
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("test.sqlite");
    let app = app_with_db(true, db_path.to_str().unwrap());
    let admin = login(&app, "admin", "correct-horse-battery").await;
    let body = json!({"provider":"codex","accessToken":"codex-stream-token","expiresAt":"2030-01-01T00:00:00Z","tokenVersion":1});
    assert_eq!(
        call(
            &app,
            "PUT",
            "/api/internal/portal/connections/portal-codex-s",
            Some("sync-secret"),
            body
        )
        .await
        .0,
        StatusCode::OK
    );
    rusqlite::Connection::open(&db_path)
        .unwrap()
        .execute(
            "UPDATE connections SET base_url=?1 WHERE provider='codex'",
            [format!("{base}/backend-api/codex")],
        )
        .unwrap();
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/models",
            Some(&admin),
            json!({"id":"gpt-s","provider":"codex","protocol":"responses","upstreamModel":"gpt-up"})
        )
        .await
        .0,
        StatusCode::CREATED
    );
    client_key(&app, &admin).await;
    let response = app.clone().oneshot(Request::builder().method("POST").uri("/v1/chat/completions")
        .header("content-type","application/json").header("authorization","Bearer client-key-with-at-least-24-characters")
        .body(Body::from(json!({"model":"gpt-s","stream":true,"messages":[{"role":"user","content":"hi"}]}).to_string())).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "text/event-stream");
    let text = String::from_utf8(
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec(),
    )
    .unwrap();
    assert!(text.contains("\"hel\""), "{text}");
    assert!(text.contains("\"lo\""), "{text}");
    assert!(text.contains("\"prompt_tokens\":4"), "{text}");
    assert!(text.contains("\"completion_tokens\":2"), "{text}");
    assert!(text.trim_end().ends_with("data: [DONE]"), "{text}");
}

#[tokio::test]
async fn upstream_stream_error_becomes_client_error_frame() {
    let upstream = "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"busy\"}}\n\n";
    let (base, _seen) = mock("text/event-stream", upstream.into()).await;
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("test.sqlite");
    let app = app_with_db(true, db_path.to_str().unwrap());
    let admin = login(&app, "admin", "correct-horse-battery").await;
    let body = json!({"provider":"claude","accessToken":"sk-ant-oat-stream","expiresAt":"2030-01-01T00:00:00Z","tokenVersion":1});
    assert_eq!(
        call(
            &app,
            "PUT",
            "/api/internal/portal/connections/portal-claude-err",
            Some("sync-secret"),
            body
        )
        .await
        .0,
        StatusCode::OK
    );
    rusqlite::Connection::open(&db_path)
        .unwrap()
        .execute(
            "UPDATE connections SET base_url=?1 WHERE provider='claude'",
            [format!("{base}/v1")],
        )
        .unwrap();
    assert_eq!(call(&app,"POST","/api/models",Some(&admin),json!({"id":"claude-e","provider":"cc","protocol":"messages","upstreamModel":"claude-up"})).await.0,StatusCode::CREATED);
    client_key(&app, &admin).await;
    let response = app.clone().oneshot(Request::builder().method("POST").uri("/v1/chat/completions")
        .header("content-type","application/json").header("authorization","Bearer client-key-with-at-least-24-characters")
        .body(Body::from(json!({"model":"claude-e","stream":true,"max_tokens":8,"messages":[{"role":"user","content":"hi"}]}).to_string())).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let text = String::from_utf8(
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec(),
    )
    .unwrap();
    assert!(text.contains("Upstream stream conversion failed"), "{text}");
    assert!(text.contains("\"error\""), "{text}");
}

#[tokio::test]
async fn expired_portal_token_is_skipped_without_refresh() {
    let (base, seen) = mock("application/json", "{}".into()).await;
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("test.sqlite");
    let app = app_with_db(true, db_path.to_str().unwrap());
    let admin = login(&app, "admin", "correct-horse-battery").await;
    let body = json!({"provider":"claude","accessToken":"sk-ant-oat-expired","expiresAt":"2020-01-01T00:00:00Z","tokenVersion":1});
    assert_eq!(
        call(
            &app,
            "PUT",
            "/api/internal/portal/connections/portal-expired",
            Some("sync-secret"),
            body
        )
        .await
        .0,
        StatusCode::OK
    );
    rusqlite::Connection::open(&db_path)
        .unwrap()
        .execute(
            "UPDATE connections SET base_url=?1 WHERE provider='claude'",
            [format!("{base}/v1")],
        )
        .unwrap();
    assert_eq!(call(&app,"POST","/api/models",Some(&admin),json!({"id":"old","provider":"claude","protocol":"messages","upstreamModel":"claude-up"})).await.0,StatusCode::CREATED);
    client_key(&app, &admin).await;
    let (status, out) = call(
        &app,
        "POST",
        "/v1/messages",
        Some("client-key-with-at-least-24-characters"),
        json!({"model":"old","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{out}");
    assert!(seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn claude_oauth_nonstream_tool_call_and_default_token_limit() {
    let (base, seen) = mock(
        "application/json",
        "{\"id\":\"msg_n\",\"model\":\"claude-up\",\"content\":[{\"type\":\"text\",\"text\":\"checking\"},{\"type\":\"tool_use\",\"id\":\"toolu_n\",\"name\":\"lookup\",\"input\":{\"q\":\"x\"}}],\"stop_reason\":\"tool_use\",\"usage\":{\"input_tokens\":3,\"output_tokens\":4}}".into(),
    )
    .await;
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("test.sqlite");
    let app = app_with_db(true, db_path.to_str().unwrap());
    let admin = login(&app, "admin", "correct-horse-battery").await;
    let body = json!({"provider":"claude","accessToken":"sk-ant-oat-nonstream","expiresAt":"2030-01-01T00:00:00Z","tokenVersion":1});
    assert_eq!(
        call(
            &app,
            "PUT",
            "/api/internal/portal/connections/portal-claude-n",
            Some("sync-secret"),
            body
        )
        .await
        .0,
        StatusCode::OK
    );
    rusqlite::Connection::open(&db_path)
        .unwrap()
        .execute(
            "UPDATE connections SET base_url=?1 WHERE provider='claude'",
            [format!("{base}/v1")],
        )
        .unwrap();
    assert_eq!(call(&app,"POST","/api/models",Some(&admin),json!({"id":"claude-n","provider":"claude","protocol":"messages","upstreamModel":"claude-up"})).await.0,StatusCode::CREATED);
    client_key(&app, &admin).await;
    let (status, out) = call(&app,"POST","/v1/chat/completions",Some("client-key-with-at-least-24-characters"),json!({
        "model":"claude-n",
        "messages":[{"role":"user","content":"find x"}],
        "tools":[{"type":"function","function":{"name":"lookup","parameters":{"type":"object"}}}]
    })).await;
    assert_eq!(status, StatusCode::OK, "{out}");
    assert_eq!(out["choices"][0]["message"]["content"], "checking");
    assert_eq!(
        out["choices"][0]["message"]["tool_calls"][0]["id"],
        "toolu_n"
    );
    assert_eq!(
        out["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"],
        "{\"q\":\"x\"}"
    );
    assert_eq!(out["choices"][0]["finish_reason"], "tool_calls");
    let requests = seen.lock().unwrap().clone();
    assert_eq!(requests[0].2["max_tokens"], 32000);
    assert_eq!(requests[0].2["tools"][0]["name"], "lookup");
    assert!(requests[0].2.get("stream").is_none());
}
