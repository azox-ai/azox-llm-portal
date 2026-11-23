//! Request conversion between the gateway's three upstream protocols.
//!
//! The gateway exposes three wire protocols:
//!
//! * `chat`      - OpenAI Chat Completions (`POST /v1/chat/completions`)
//! * `responses` - OpenAI Responses (`POST /v1/responses`)
//! * `messages`  - Anthropic Messages (`POST /v1/messages`)
//!
//! Conversion always goes through a small canonical request model. Features
//! that cannot be represented in the target protocol produce an explicit
//! `Err` instead of being silently dropped.
//!
//! The single public entry point is [`convert`]. Same-protocol requests
//! (without `codex`) are returned as a clone with only `model` replaced, so
//! protocol-specific fields survive round trips unchanged. `codex` requests
//! are always Responses protocol requests and are normalised to
//! `stream = true` / `store = false`.

use serde_json::{json, Map, Value};

type CResult<T> = Result<T, String>;

/// Stateful Responses features the stateless Codex backend cannot serve.
const CODEX_UNSUPPORTED_FIELDS: &[&str] = &["previous_response_id", "conversation", "background"];

fn reject_codex_stateful_fields(object: &Map<String, Value>) -> CResult<()> {
    for key in CODEX_UNSUPPORTED_FIELDS {
        if present(object, key).is_some() {
            return Err(format!(
                "codex: field '{key}' is unsupported by the stateless Codex backend"
            ));
        }
    }
    Ok(())
}

/// Convert a JSON request body from one protocol to another.
///
/// * `body` - the incoming JSON request object.
/// * `from` - source protocol: `"chat"`, `"responses"` or `"messages"`.
/// * `to` - target protocol: `"chat"`, `"responses"` or `"messages"`.
/// * `model` - model name written to the outgoing request.
/// * `codex` - normalise a Responses request for the ChatGPT Codex backend
///   (`stream = true`, `store = false`). Requires `to == "responses"`.
///
/// Returns the converted request object, or a human readable error string
/// naming the unsupported field/feature and the protocol that rejected it.
pub fn convert(
    body: &Value,
    from: &str,
    to: &str,
    model: &str,
    codex: bool,
) -> Result<Value, String> {
    if model.is_empty() {
        return Err("model must not be empty".to_string());
    }
    validate_protocol(from)?;
    validate_protocol(to)?;
    if !body.is_object() {
        return Err("request body must be a JSON object".to_string());
    }
    if codex && to != "responses" {
        return Err(format!(
            "codex normalization requires the 'responses' target protocol, got '{to}'"
        ));
    }

    // Same protocol: a clone with the model swapped is lossless. For Codex we
    // additionally force the transport flags the ChatGPT backend requires.
    if from == to && (!codex || from == "responses") {
        let mut out = body.clone();
        out["model"] = Value::String(model.to_string());
        if codex {
            reject_codex_stateful_fields(
                body.as_object()
                    .expect("body was checked to be an object above"),
            )?;
            out["stream"] = Value::Bool(true);
            out["store"] = Value::Bool(false);
        }
        return Ok(out);
    }

    let object = body
        .as_object()
        .expect("body was checked to be an object above");
    let request = parse_request(object, from)?;
    emit_request(&request, to, model, codex)
}

fn validate_protocol(protocol: &str) -> CResult<()> {
    match protocol {
        "chat" | "responses" | "messages" => Ok(()),
        other => Err(format!(
            "unsupported protocol '{other}'; expected 'chat', 'responses' or 'messages'"
        )),
    }
}

// ---------------------------------------------------------------------------
// Canonical request model
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
enum Role {
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ToolCall {
    id: String,
    name: String,
    /// JSON-encoded argument object, as used by Chat and Responses.
    arguments: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Message {
    role: Role,
    text: Option<String>,
    /// Image URLs (http(s) or `data:` URIs).
    images: Vec<String>,
    tool_calls: Vec<ToolCall>,
    tool_call_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ToolDef {
    name: String,
    description: Option<String>,
    parameters: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ToolChoice {
    Auto,
    None,
    Required,
    Named(String),
}

#[derive(Debug, Clone, Default, PartialEq)]
struct Request {
    system: Option<String>,
    messages: Vec<Message>,
    tools: Vec<ToolDef>,
    tool_choice: Option<ToolChoice>,
    parallel_tool_calls: Option<bool>,
    max_tokens: Option<u64>,
    temperature: Option<f64>,
    top_p: Option<f64>,
    stop: Vec<String>,
    reasoning_effort: Option<String>,
    stream: Option<bool>,
}

fn parse_request(object: &Map<String, Value>, protocol: &str) -> CResult<Request> {
    match protocol {
        "chat" => parse_chat(object),
        "responses" => parse_responses(object),
        "messages" => parse_messages(object),
        _ => unreachable!("protocol was validated"),
    }
}

fn emit_request(request: &Request, protocol: &str, model: &str, codex: bool) -> CResult<Value> {
    match protocol {
        "chat" => emit_chat(request, model),
        "responses" => emit_responses(request, model, codex),
        "messages" => emit_messages(request, model),
        _ => unreachable!("protocol was validated"),
    }
}

// ---------------------------------------------------------------------------
// Shared parsing helpers
// ---------------------------------------------------------------------------

fn kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "a string",
        Value::Array(_) => "an array",
        Value::Object(_) => "an object",
    }
}

fn as_object<'a>(value: &'a Value, ctx: &str) -> CResult<&'a Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| format!("{ctx}: expected an object, got {}", kind(value)))
}

fn reject_unknown(object: &Map<String, Value>, allowed: &[&str], ctx: &str) -> CResult<()> {
    for key in object.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(format!("{ctx}: unsupported field '{key}'"));
        }
    }
    Ok(())
}

/// Optional field lookup that treats an explicit JSON `null` as absent, which
/// matches how generated SDK clients serialise unset optional arguments.
fn present<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    object.get(key).filter(|value| !value.is_null())
}

fn get_string(object: &Map<String, Value>, key: &str, ctx: &str) -> CResult<Option<String>> {
    match present(object, key) {
        None => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(value) => Err(format!(
            "{ctx}: field '{key}' must be a string, got {}",
            kind(value)
        )),
    }
}

fn require_string(object: &Map<String, Value>, key: &str, ctx: &str) -> CResult<String> {
    get_string(object, key, ctx)?.ok_or_else(|| format!("{ctx}: field '{key}' is required"))
}

fn require_nonempty_string(object: &Map<String, Value>, key: &str, ctx: &str) -> CResult<String> {
    let value = require_string(object, key, ctx)?;
    if value.is_empty() {
        return Err(format!("{ctx}: field '{key}' must not be empty"));
    }
    Ok(value)
}

fn get_bool(object: &Map<String, Value>, key: &str, ctx: &str) -> CResult<Option<bool>> {
    match present(object, key) {
        None => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(value) => Err(format!(
            "{ctx}: field '{key}' must be a boolean, got {}",
            kind(value)
        )),
    }
}

fn get_u64(object: &Map<String, Value>, key: &str, ctx: &str) -> CResult<Option<u64>> {
    match present(object, key) {
        None => Ok(None),
        Some(Value::Number(number)) => number
            .as_u64()
            .map(Some)
            .ok_or_else(|| format!("{ctx}: field '{key}' must be a non-negative integer")),
        Some(value) => Err(format!(
            "{ctx}: field '{key}' must be a non-negative integer, got {}",
            kind(value)
        )),
    }
}

fn get_f64(object: &Map<String, Value>, key: &str, ctx: &str) -> CResult<Option<f64>> {
    match present(object, key) {
        None => Ok(None),
        Some(Value::Number(number)) => Ok(number.as_f64()),
        Some(value) => Err(format!(
            "{ctx}: field '{key}' must be a number, got {}",
            kind(value)
        )),
    }
}

/// `stop` / `stop_sequences`: either one string or an array of strings.
fn parse_string_list(object: &Map<String, Value>, key: &str, ctx: &str) -> CResult<Vec<String>> {
    match present(object, key) {
        None => Ok(Vec::new()),
        Some(Value::String(value)) => Ok(vec![value.clone()]),
        Some(Value::Array(values)) => {
            let mut out = Vec::with_capacity(values.len());
            for (index, value) in values.iter().enumerate() {
                match value {
                    Value::String(value) => out.push(value.clone()),
                    other => {
                        return Err(format!(
                            "{ctx}: field '{key}[{index}]' must be a string, got {}",
                            kind(other)
                        ))
                    }
                }
            }
            Ok(out)
        }
        Some(value) => Err(format!(
            "{ctx}: field '{key}' must be a string or an array of strings, got {}",
            kind(value)
        )),
    }
}

fn join_text(parts: Vec<String>) -> Option<String> {
    let parts: Vec<String> = parts.into_iter().filter(|part| !part.is_empty()).collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

fn join_system(parts: Vec<String>) -> Option<String> {
    let parts: Vec<String> = parts.into_iter().filter(|part| !part.is_empty()).collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n\n"))
    }
}

fn parse_reasoning_effort(
    object: &Map<String, Value>,
    key: &str,
    ctx: &str,
) -> CResult<Option<String>> {
    let effort = get_string(object, key, ctx)?;
    if let Some(effort) = &effort {
        if effort.is_empty() {
            return Err(format!("{ctx}: field '{key}' must not be empty"));
        }
    }
    Ok(effort)
}

// ---------------------------------------------------------------------------
// Chat Completions parsing
// ---------------------------------------------------------------------------

const CHAT_FIELDS: &[&str] = &[
    "model",
    "messages",
    "stream",
    "temperature",
    "top_p",
    "max_tokens",
    "max_completion_tokens",
    "stop",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "n",
    "reasoning_effort",
    "stream_options",
];

fn parse_chat(object: &Map<String, Value>) -> CResult<Request> {
    reject_unknown(object, CHAT_FIELDS, "chat")?;
    let stream = get_bool(object, "stream", "chat")?;
    // `stream_options` only tunes completion-chunk metadata. Converted streams
    // always carry usage, so `include_usage` needs no further mapping.
    if let Some(value) = present(object, "stream_options") {
        let options = as_object(value, "chat.stream_options")?;
        reject_unknown(options, &["include_usage"], "chat.stream_options")?;
        get_bool(options, "include_usage", "chat.stream_options")?;
    }

    if let Some(n) = present(object, "n") {
        let n = n
            .as_u64()
            .ok_or_else(|| "chat: field 'n' must be a positive integer".to_string())?;
        if n != 1 {
            return Err(format!(
                "chat: 'n' = {n} is not supported; only a single choice can be converted"
            ));
        }
    }

    let messages_value = object
        .get("messages")
        .ok_or_else(|| "chat: field 'messages' is required".to_string())?;
    let message_items = messages_value
        .as_array()
        .ok_or_else(|| "chat: field 'messages' must be an array".to_string())?;
    if message_items.is_empty() {
        return Err("chat: 'messages' must not be empty".to_string());
    }
    let (system, messages) = parse_chat_messages(message_items)?;

    let max_tokens = match (
        get_u64(object, "max_tokens", "chat")?,
        get_u64(object, "max_completion_tokens", "chat")?,
    ) {
        (Some(deprecated), Some(current)) if deprecated != current => {
            return Err(
                "chat: 'max_tokens' and 'max_completion_tokens' disagree; pass only one"
                    .to_string(),
            )
        }
        (Some(value), _) | (None, Some(value)) => Some(value),
        (None, None) => None,
    };
    if max_tokens == Some(0) {
        return Err("chat: the token limit must be greater than zero".to_string());
    }
    Ok(Request {
        system,
        messages,
        tools: parse_chat_tools(object.get("tools"))?,
        tool_choice: parse_chat_tool_choice(object.get("tool_choice"))?,
        parallel_tool_calls: get_bool(object, "parallel_tool_calls", "chat")?,
        max_tokens,
        temperature: get_f64(object, "temperature", "chat")?,
        top_p: get_f64(object, "top_p", "chat")?,
        stop: parse_string_list(object, "stop", "chat")?,
        reasoning_effort: parse_reasoning_effort(object, "reasoning_effort", "chat")?,
        stream,
    })
}

fn parse_positive_u64(object: &Map<String, Value>, key: &str, ctx: &str) -> CResult<Option<u64>> {
    let value = get_u64(object, key, ctx)?;
    if value == Some(0) {
        return Err(format!("{ctx}: field '{key}' must be greater than zero"));
    }
    Ok(value)
}

fn parse_chat_messages(items: &[Value]) -> CResult<(Option<String>, Vec<Message>)> {
    let mut systems = Vec::new();
    let mut messages = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let ctx = format!("chat.messages[{index}]");
        let message = as_object(item, &ctx)?;
        let role = require_nonempty_string(message, "role", &ctx)?;
        match role.as_str() {
            "system" | "developer" => {
                reject_unknown(message, &["role", "content"], &ctx)?;
                let (text, images) = parse_chat_content(message.get("content"), &ctx, false)?;
                if !images.is_empty() {
                    return Err(format!(
                        "{ctx}: image content is not supported in a system message"
                    ));
                }
                systems.push(text.unwrap_or_default());
            }
            "user" => {
                reject_unknown(message, &["role", "content"], &ctx)?;
                let (text, images) = parse_chat_content(message.get("content"), &ctx, false)?;
                if text.is_none() && images.is_empty() {
                    return Err(format!("{ctx}: user messages must not have empty content"));
                }
                messages.push(Message {
                    role: Role::User,
                    text,
                    images,
                    tool_calls: Vec::new(),
                    tool_call_id: None,
                });
            }
            "assistant" => {
                reject_unknown(message, &["role", "content", "tool_calls"], &ctx)?;
                let (text, images) = parse_chat_content(message.get("content"), &ctx, true)?;
                if !images.is_empty() {
                    return Err(format!(
                        "{ctx}: image content is not supported in an assistant message"
                    ));
                }
                let tool_calls = parse_chat_tool_calls(message.get("tool_calls"), &ctx)?;
                if text.is_none() && tool_calls.is_empty() {
                    return Err(format!(
                        "{ctx}: assistant messages must have content or tool calls"
                    ));
                }
                messages.push(Message {
                    role: Role::Assistant,
                    text,
                    images: Vec::new(),
                    tool_calls,
                    tool_call_id: None,
                });
            }
            "tool" => {
                reject_unknown(message, &["role", "content", "tool_call_id"], &ctx)?;
                let tool_call_id = require_nonempty_string(message, "tool_call_id", &ctx)?;
                let (text, images) = parse_chat_content(message.get("content"), &ctx, false)?;
                if !images.is_empty() {
                    return Err(format!(
                        "{ctx}: image content is not supported in a tool message"
                    ));
                }
                messages.push(Message {
                    role: Role::Tool,
                    text: Some(text.unwrap_or_default()),
                    images: Vec::new(),
                    tool_calls: Vec::new(),
                    tool_call_id: Some(tool_call_id),
                });
            }
            "function" => {
                return Err(format!(
                    "{ctx}: unsupported legacy role 'function'; use role 'tool' with 'tool_call_id'"
                ))
            }
            other => return Err(format!("{ctx}: unsupported role '{other}'")),
        }
    }
    Ok((join_system(systems), messages))
}

fn parse_chat_content(
    value: Option<&Value>,
    ctx: &str,
    allow_null: bool,
) -> CResult<(Option<String>, Vec<String>)> {
    match value {
        None | Some(Value::Null) if allow_null => Ok((None, Vec::new())),
        None | Some(Value::Null) => Err(format!("{ctx}: field 'content' is required")),
        Some(Value::String(text)) => Ok((Some(text.clone()), Vec::new())),
        Some(Value::Array(parts)) => {
            let mut texts = Vec::new();
            let mut images = Vec::new();
            for (index, part) in parts.iter().enumerate() {
                let part_ctx = format!("{ctx}.content[{index}]");
                let part = as_object(part, &part_ctx)?;
                let part_type = require_string(part, "type", &part_ctx)?;
                match part_type.as_str() {
                    "text" => {
                        reject_unknown(part, &["type", "text"], &part_ctx)?;
                        texts.push(require_string(part, "text", &part_ctx)?);
                    }
                    "image_url" => {
                        reject_unknown(part, &["type", "image_url"], &part_ctx)?;
                        images.push(parse_url_value(part.get("image_url"), &part_ctx)?);
                    }
                    other => {
                        return Err(format!(
                            "{part_ctx}: unsupported chat content part type '{other}'"
                        ))
                    }
                }
            }
            Ok((join_text(texts), images))
        }
        Some(other) => Err(format!(
            "{ctx}: field 'content' must be a string or an array of content parts, got {}",
            kind(other)
        )),
    }
}

fn parse_url_value(value: Option<&Value>, ctx: &str) -> CResult<String> {
    match value {
        None => Err(format!("{ctx}: image url is required")),
        Some(Value::String(url)) => {
            if url.is_empty() {
                Err(format!("{ctx}: image url must not be empty"))
            } else {
                Ok(url.clone())
            }
        }
        Some(Value::Object(object)) => {
            reject_unknown(object, &["url"], ctx)?;
            require_nonempty_string(object, "url", ctx)
        }
        Some(other) => Err(format!(
            "{ctx}: image url must be a string or an object with a 'url' field, got {}",
            kind(other)
        )),
    }
}

fn parse_chat_tool_calls(value: Option<&Value>, ctx: &str) -> CResult<Vec<ToolCall>> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Ok(Vec::new());
    };
    let items = value
        .as_array()
        .ok_or_else(|| format!("{ctx}: field 'tool_calls' must be an array"))?;
    let mut calls = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let call_ctx = format!("{ctx}.tool_calls[{index}]");
        let call = as_object(item, &call_ctx)?;
        reject_unknown(call, &["id", "type", "function"], &call_ctx)?;
        let id = require_nonempty_string(call, "id", &call_ctx)?;
        if let Some(call_type) = call.get("type") {
            let call_type = call_type
                .as_str()
                .ok_or_else(|| format!("{call_ctx}: field 'type' must be a string"))?;
            if call_type != "function" {
                return Err(format!(
                    "{call_ctx}: unsupported tool call type '{call_type}'; only 'function' is supported"
                ));
            }
        }
        let function = call
            .get("function")
            .ok_or_else(|| format!("{call_ctx}: field 'function' is required"))?;
        let function = as_object(function, &format!("{call_ctx}.function"))?;
        let function_ctx = format!("{call_ctx}.function");
        reject_unknown(function, &["name", "arguments"], &function_ctx)?;
        let name = require_nonempty_string(function, "name", &function_ctx)?;
        let arguments = require_string(function, "arguments", &function_ctx)?;
        calls.push(ToolCall {
            id,
            name,
            arguments,
        });
    }
    Ok(calls)
}

fn parse_chat_tools(value: Option<&Value>) -> CResult<Vec<ToolDef>> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Ok(Vec::new());
    };
    let items = value
        .as_array()
        .ok_or_else(|| "chat: field 'tools' must be an array".to_string())?;
    let mut tools = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let ctx = format!("chat.tools[{index}]");
        let tool = as_object(item, &ctx)?;
        reject_unknown(tool, &["type", "function"], &ctx)?;
        let tool_type = require_string(tool, "type", &ctx)?;
        if tool_type != "function" {
            return Err(format!(
                "{ctx}: unsupported tool type '{tool_type}'; only 'function' is supported"
            ));
        }
        let function = tool
            .get("function")
            .ok_or_else(|| format!("{ctx}: field 'function' is required"))?;
        let function = as_object(function, &format!("{ctx}.function"))?;
        let function_ctx = format!("{ctx}.function");
        reject_unknown(
            function,
            &["name", "description", "parameters", "strict"],
            &function_ctx,
        )?;
        if get_bool(function, "strict", &function_ctx)?.unwrap_or(false) {
            return Err(format!(
                "{function_ctx}: field 'strict: true' is unsupported when converting between protocols"
            ));
        }
        let name = require_nonempty_string(function, "name", &function_ctx)?;
        let description = get_string(function, "description", &function_ctx)?;
        let parameters = present(function, "parameters")
            .cloned()
            .unwrap_or_else(|| json!({"type": "object", "properties": {}}));
        if !parameters.is_object() {
            return Err(format!(
                "{function_ctx}: field 'parameters' must be a JSON schema object"
            ));
        }
        tools.push(ToolDef {
            name,
            description,
            parameters,
        });
    }
    Ok(tools)
}

fn parse_chat_tool_choice(value: Option<&Value>) -> CResult<Option<ToolChoice>> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    match value {
        Value::String(choice) => match choice.as_str() {
            "auto" => Ok(Some(ToolChoice::Auto)),
            "none" => Ok(Some(ToolChoice::None)),
            "required" => Ok(Some(ToolChoice::Required)),
            other => Err(format!(
                "chat.tool_choice: unsupported value '{other}'; expected 'auto', 'none' or 'required'"
            )),
        },
        Value::Object(object) => {
            let ctx = "chat.tool_choice";
            reject_unknown(object, &["type", "function"], ctx)?;
            let choice_type = require_string(object, "type", ctx)?;
            if choice_type != "function" {
                return Err(format!(
                    "{ctx}: unsupported tool choice type '{choice_type}'; only 'function' is supported"
                ));
            }
            let function = object
                .get("function")
                .ok_or_else(|| format!("{ctx}: field 'function' is required"))?;
            let function = as_object(function, &format!("{ctx}.function"))?;
            reject_unknown(function, &["name"], &format!("{ctx}.function"))?;
            Ok(Some(ToolChoice::Named(require_nonempty_string(
                function,
                "name",
                &format!("{ctx}.function"),
            )?)))
        }
        other => Err(format!(
            "chat.tool_choice: expected a string or an object, got {}",
            kind(other)
        )),
    }
}

// ---------------------------------------------------------------------------
// Responses parsing
// ---------------------------------------------------------------------------

const RESPONSES_FIELDS: &[&str] = &[
    "model",
    "input",
    "instructions",
    "stream",
    "store",
    "temperature",
    "top_p",
    "max_output_tokens",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "reasoning",
];

fn parse_responses(object: &Map<String, Value>) -> CResult<Request> {
    reject_unknown(object, RESPONSES_FIELDS, "responses")?;
    // Validate transport flags even though the caller chooses streaming at the
    // protocol boundary. A non-Codex target is emitted with the source value.
    let stream = get_bool(object, "stream", "responses")?;
    if get_bool(object, "store", "responses")? == Some(true) {
        return Err(
            "responses: 'store: true' is unsupported when converting to another protocol"
                .to_string(),
        );
    }
    let mut systems = Vec::new();
    if let Some(instructions) = get_string(object, "instructions", "responses")? {
        systems.push(instructions);
    }
    let input = object
        .get("input")
        .ok_or_else(|| "responses: field 'input' is required".to_string())?;
    let (input_systems, messages) = parse_responses_input(input)?;
    systems.extend(input_systems);
    let reasoning_effort = match present(object, "reasoning") {
        None => None,
        Some(value) => {
            let reasoning = as_object(value, "responses.reasoning")?;
            reject_unknown(reasoning, &["effort"], "responses.reasoning")?;
            parse_reasoning_effort(reasoning, "effort", "responses.reasoning")?
        }
    };
    Ok(Request {
        system: join_system(systems),
        messages,
        tools: parse_responses_tools(object.get("tools"))?,
        tool_choice: parse_responses_tool_choice(object.get("tool_choice"))?,
        parallel_tool_calls: get_bool(object, "parallel_tool_calls", "responses")?,
        max_tokens: parse_positive_u64(object, "max_output_tokens", "responses")?,
        temperature: get_f64(object, "temperature", "responses")?,
        top_p: get_f64(object, "top_p", "responses")?,
        stop: Vec::new(),
        reasoning_effort,
        stream,
    })
}

fn parse_responses_input(value: &Value) -> CResult<(Vec<String>, Vec<Message>)> {
    if let Some(text) = value.as_str() {
        return Ok((
            Vec::new(),
            vec![Message {
                role: Role::User,
                text: Some(text.to_string()),
                images: Vec::new(),
                tool_calls: Vec::new(),
                tool_call_id: None,
            }],
        ));
    }
    let items = value
        .as_array()
        .ok_or_else(|| "responses: field 'input' must be a string or an array".to_string())?;
    if items.is_empty() {
        return Err("responses: 'input' must not be empty".to_string());
    }
    let mut systems = Vec::new();
    let mut messages: Vec<Message> = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let ctx = format!("responses.input[{index}]");
        let item = as_object(item, &ctx)?;
        let item_type = get_string(item, "type", &ctx)?.unwrap_or_else(|| "message".to_string());
        match item_type.as_str() {
            "message" => {
                reject_unknown(item, &["type", "role", "content"], &ctx)?;
                let role = require_nonempty_string(item, "role", &ctx)?;
                let (text, images) = parse_responses_content(item.get("content"), &ctx)?;
                match role.as_str() {
                    "system" | "developer" => {
                        if !images.is_empty() {
                            return Err(format!(
                                "{ctx}: image content is not supported in a system message"
                            ));
                        }
                        systems.push(text.unwrap_or_default());
                    }
                    "user" => {
                        if text.is_none() && images.is_empty() {
                            return Err(format!(
                                "{ctx}: user messages must not have empty content"
                            ));
                        }
                        messages.push(Message {
                            role: Role::User,
                            text,
                            images,
                            tool_calls: Vec::new(),
                            tool_call_id: None,
                        });
                    }
                    "assistant" => {
                        if !images.is_empty() {
                            return Err(format!(
                                "{ctx}: image content is not supported in an assistant message"
                            ));
                        }
                        if text.is_none() {
                            return Err(format!(
                                "{ctx}: assistant messages must not have empty content"
                            ));
                        }
                        messages.push(Message {
                            role: Role::Assistant,
                            text,
                            images: Vec::new(),
                            tool_calls: Vec::new(),
                            tool_call_id: None,
                        });
                    }
                    other => return Err(format!("{ctx}: unsupported role '{other}'")),
                }
            }
            "function_call" => {
                reject_unknown(item, &["type", "call_id", "name", "arguments"], &ctx)?;
                let call = ToolCall {
                    id: require_nonempty_string(item, "call_id", &ctx)?,
                    name: require_nonempty_string(item, "name", &ctx)?,
                    arguments: require_string(item, "arguments", &ctx)?,
                };
                // Responses has an item boundary between assistant text and each
                // function call; Chat and Messages do not. Merge adjacent calls
                // into the preceding assistant turn so the tool calls stay paired
                // with the assistant text that introduced them.
                if let Some(last) = messages.last_mut() {
                    if last.role == Role::Assistant {
                        last.tool_calls.push(call);
                        continue;
                    }
                }
                messages.push(Message {
                    role: Role::Assistant,
                    text: None,
                    images: Vec::new(),
                    tool_calls: vec![call],
                    tool_call_id: None,
                });
            }
            "function_call_output" => {
                reject_unknown(item, &["type", "call_id", "output"], &ctx)?;
                messages.push(Message {
                    role: Role::Tool,
                    text: Some(require_string(item, "output", &ctx)?),
                    images: Vec::new(),
                    tool_calls: Vec::new(),
                    tool_call_id: Some(require_nonempty_string(item, "call_id", &ctx)?),
                });
            }
            other => {
                return Err(format!(
                    "{ctx}: unsupported responses input item type '{other}'"
                ))
            }
        }
    }
    Ok((systems, messages))
}

fn parse_responses_content(
    value: Option<&Value>,
    ctx: &str,
) -> CResult<(Option<String>, Vec<String>)> {
    match value {
        None | Some(Value::Null) => Err(format!("{ctx}: field 'content' is required")),
        Some(Value::String(text)) => Ok((Some(text.clone()), Vec::new())),
        Some(Value::Array(parts)) => {
            let mut texts = Vec::new();
            let mut images = Vec::new();
            for (index, part) in parts.iter().enumerate() {
                let part_ctx = format!("{ctx}.content[{index}]");
                let part = as_object(part, &part_ctx)?;
                let part_type = require_string(part, "type", &part_ctx)?;
                match part_type.as_str() {
                    "input_text" | "output_text" => {
                        reject_unknown(part, &["type", "text"], &part_ctx)?;
                        texts.push(require_string(part, "text", &part_ctx)?);
                    }
                    "input_image" => {
                        reject_unknown(part, &["type", "image_url"], &part_ctx)?;
                        images.push(parse_url_value(part.get("image_url"), &part_ctx)?);
                    }
                    other => {
                        return Err(format!(
                            "{part_ctx}: unsupported responses content part type '{other}'"
                        ))
                    }
                }
            }
            Ok((join_text(texts), images))
        }
        Some(other) => Err(format!(
            "{ctx}: field 'content' must be a string or an array of content parts, got {}",
            kind(other)
        )),
    }
}

fn parse_responses_tools(value: Option<&Value>) -> CResult<Vec<ToolDef>> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Ok(Vec::new());
    };
    let items = value
        .as_array()
        .ok_or_else(|| "responses: field 'tools' must be an array".to_string())?;
    let mut tools = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let ctx = format!("responses.tools[{index}]");
        let tool = as_object(item, &ctx)?;
        reject_unknown(
            tool,
            &["type", "name", "description", "parameters", "strict"],
            &ctx,
        )?;
        let tool_type = require_string(tool, "type", &ctx)?;
        if tool_type != "function" {
            return Err(format!(
                "{ctx}: unsupported tool type '{tool_type}'; only 'function' is supported"
            ));
        }
        if get_bool(tool, "strict", &ctx)?.unwrap_or(false) {
            return Err(format!(
                "{ctx}: field 'strict: true' is unsupported when converting between protocols"
            ));
        }
        let name = require_nonempty_string(tool, "name", &ctx)?;
        let description = get_string(tool, "description", &ctx)?;
        let parameters = present(tool, "parameters")
            .cloned()
            .unwrap_or_else(|| json!({"type": "object", "properties": {}}));
        if !parameters.is_object() {
            return Err(format!(
                "{ctx}: field 'parameters' must be a JSON schema object"
            ));
        }
        tools.push(ToolDef {
            name,
            description,
            parameters,
        });
    }
    Ok(tools)
}

fn parse_responses_tool_choice(value: Option<&Value>) -> CResult<Option<ToolChoice>> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    match value {
        Value::String(choice) => match choice.as_str() {
            "auto" => Ok(Some(ToolChoice::Auto)),
            "none" => Ok(Some(ToolChoice::None)),
            "required" => Ok(Some(ToolChoice::Required)),
            other => Err(format!(
                "responses.tool_choice: unsupported value '{other}'"
            )),
        },
        Value::Object(choice) => {
            let ctx = "responses.tool_choice";
            reject_unknown(choice, &["type", "name"], ctx)?;
            let choice_type = require_string(choice, "type", ctx)?;
            if choice_type != "function" {
                return Err(format!(
                    "{ctx}: unsupported tool choice type '{choice_type}'"
                ));
            }
            Ok(Some(ToolChoice::Named(require_nonempty_string(
                choice, "name", ctx,
            )?)))
        }
        other => Err(format!(
            "responses.tool_choice: expected a string or an object, got {}",
            kind(other)
        )),
    }
}

// ---------------------------------------------------------------------------
// Messages parsing
// ---------------------------------------------------------------------------

const MESSAGES_FIELDS: &[&str] = &[
    "model",
    "messages",
    "system",
    "max_tokens",
    "max_output_tokens",
    "stream",
    "temperature",
    "top_p",
    "stop_sequences",
    "tools",
    "tool_choice",
];

fn parse_messages(object: &Map<String, Value>) -> CResult<Request> {
    reject_unknown(object, MESSAGES_FIELDS, "messages")?;
    let stream = get_bool(object, "stream", "messages")?;
    let system = match present(object, "system") {
        None => None,
        Some(Value::String(text)) => Some(text.clone()),
        Some(Value::Array(parts)) => {
            let mut texts = Vec::new();
            for (index, part) in parts.iter().enumerate() {
                let ctx = format!("messages.system[{index}]");
                let part = as_object(part, &ctx)?;
                reject_unknown(part, &["type", "text"], &ctx)?;
                let typ = require_string(part, "type", &ctx)?;
                if typ != "text" {
                    return Err(format!("{ctx}: unsupported system block type '{typ}'"));
                }
                texts.push(require_string(part, "text", &ctx)?);
            }
            join_system(texts)
        }
        Some(other) => {
            return Err(format!(
                "messages: field 'system' must be a string or array of text blocks, got {}",
                kind(other)
            ))
        }
    };
    let items = object
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| "messages: field 'messages' must be an array".to_string())?;
    if items.is_empty() {
        return Err("messages: 'messages' must not be empty".to_string());
    }
    let (tool_choice, parallel_tool_calls) = parse_messages_tool_choice(object.get("tool_choice"))?;
    Ok(Request {
        system,
        messages: parse_messages_items(items)?,
        tools: parse_messages_tools(object.get("tools"))?,
        tool_choice,
        parallel_tool_calls,
        // Anthropic clients occasionally send the Responses-style name; accept it
        // for the same slot so the request is not silently truncated to a default.
        max_tokens: match (
            parse_positive_u64(object, "max_tokens", "messages")?,
            parse_positive_u64(object, "max_output_tokens", "messages")?,
        ) {
            (Some(a), Some(b)) if a != b => {
                return Err(
                    "messages: 'max_tokens' and 'max_output_tokens' disagree; pass only one"
                        .to_string(),
                )
            }
            (Some(v), _) | (None, Some(v)) => Some(v),
            (None, None) => None,
        },
        temperature: get_f64(object, "temperature", "messages")?,
        top_p: get_f64(object, "top_p", "messages")?,
        stop: parse_string_list(object, "stop_sequences", "messages")?,
        reasoning_effort: None,
        stream,
    })
}

fn parse_messages_items(items: &[Value]) -> CResult<Vec<Message>> {
    let mut messages = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let ctx = format!("messages.messages[{index}]");
        let item = as_object(item, &ctx)?;
        reject_unknown(item, &["role", "content"], &ctx)?;
        let role = require_string(item, "role", &ctx)?;
        if role != "user" && role != "assistant" {
            return Err(format!("{ctx}: unsupported role '{role}'"));
        }
        let content = item
            .get("content")
            .ok_or_else(|| format!("{ctx}: field 'content' is required"))?;
        if let Some(text) = content.as_str() {
            messages.push(Message {
                role: if role == "user" {
                    Role::User
                } else {
                    Role::Assistant
                },
                text: Some(text.to_string()),
                images: Vec::new(),
                tool_calls: Vec::new(),
                tool_call_id: None,
            });
            continue;
        }
        let blocks = content
            .as_array()
            .ok_or_else(|| format!("{ctx}: field 'content' must be a string or an array"))?;
        let mut texts = Vec::new();
        let mut images = Vec::new();
        let mut calls = Vec::new();
        let mut results = Vec::new();
        for (block_index, block) in blocks.iter().enumerate() {
            let block_ctx = format!("{ctx}.content[{block_index}]");
            let block = as_object(block, &block_ctx)?;
            let typ = require_string(block, "type", &block_ctx)?;
            match typ.as_str() {
                "text" => {
                    reject_unknown(block, &["type", "text"], &block_ctx)?;
                    texts.push(require_string(block, "text", &block_ctx)?);
                }
                "image" if role == "user" => {
                    reject_unknown(block, &["type", "source"], &block_ctx)?;
                    let source = as_object(
                        block
                            .get("source")
                            .ok_or_else(|| format!("{block_ctx}: field 'source' is required"))?,
                        &format!("{block_ctx}.source"),
                    )?;
                    let source_ctx = format!("{block_ctx}.source");
                    let source_type = require_string(source, "type", &source_ctx)?;
                    let url = match source_type.as_str() {
                        "url" => {
                            reject_unknown(source, &["type", "url"], &source_ctx)?;
                            require_nonempty_string(source, "url", &source_ctx)?
                        }
                        "base64" => {
                            reject_unknown(source, &["type", "media_type", "data"], &source_ctx)?;
                            let media_type =
                                require_nonempty_string(source, "media_type", &source_ctx)?;
                            let data = require_nonempty_string(source, "data", &source_ctx)?;
                            format!("data:{media_type};base64,{data}")
                        }
                        other => {
                            return Err(format!(
                                "{source_ctx}: unsupported image source type '{other}'"
                            ))
                        }
                    };
                    images.push(url);
                }
                "tool_use" if role == "assistant" => {
                    reject_unknown(block, &["type", "id", "name", "input"], &block_ctx)?;
                    let input = block
                        .get("input")
                        .ok_or_else(|| format!("{block_ctx}: field 'input' is required"))?;
                    if !input.is_object() {
                        return Err(format!("{block_ctx}: field 'input' must be an object"));
                    }
                    calls.push(ToolCall {
                        id: require_nonempty_string(block, "id", &block_ctx)?,
                        name: require_nonempty_string(block, "name", &block_ctx)?,
                        arguments: input.to_string(),
                    });
                }
                "tool_result" if role == "user" => {
                    reject_unknown(
                        block,
                        &["type", "tool_use_id", "content", "is_error"],
                        &block_ctx,
                    )?;
                    if get_bool(block, "is_error", &block_ctx)?.unwrap_or(false) {
                        return Err(format!("{block_ctx}: 'is_error: true' is unsupported when converting to another protocol"));
                    }
                    let text = match block.get("content") {
                        Some(Value::String(text)) => text.clone(),
                        None => String::new(),
                        Some(Value::Array(parts)) => {
                            let mut texts = Vec::new();
                            for (part_index, part) in parts.iter().enumerate() {
                                let part_ctx = format!("{block_ctx}.content[{part_index}]");
                                let part = as_object(part, &part_ctx)?;
                                let typ = require_string(part, "type", &part_ctx)?;
                                if typ != "text" {
                                    return Err(format!(
                                        "{part_ctx}: unsupported tool result content block type '{typ}'"
                                    ));
                                }
                                reject_unknown(part, &["type", "text"], &part_ctx)?;
                                texts.push(require_string(part, "text", &part_ctx)?);
                            }
                            join_text(texts).unwrap_or_default()
                        }
                        Some(_) => {
                            return Err(format!(
                                "{block_ctx}: tool result content must be a string or an array of text blocks"
                            ))
                        }
                    };
                    results.push(Message {
                        role: Role::Tool,
                        text: Some(text),
                        images: Vec::new(),
                        tool_calls: Vec::new(),
                        tool_call_id: Some(require_nonempty_string(
                            block,
                            "tool_use_id",
                            &block_ctx,
                        )?),
                    });
                }
                other => {
                    return Err(format!(
                        "{block_ctx}: unsupported content block type '{other}' for role '{role}'"
                    ))
                }
            }
        }
        // Tool results must precede any user text in a Messages turn. Preserve
        // that order when expanding the block list into canonical messages.
        let has_results = !results.is_empty();
        messages.extend(results);
        let text = join_text(texts);
        if text.is_none() && images.is_empty() && calls.is_empty() {
            if has_results {
                // A Messages turn made only of tool_result blocks becomes one or
                // more Tool messages; there is no separate user turn to emit.
                continue;
            }
            return Err(format!(
                "{ctx}: {role} messages must not have empty content"
            ));
        }
        messages.push(Message {
            role: if role == "user" {
                Role::User
            } else {
                Role::Assistant
            },
            text,
            images,
            tool_calls: calls,
            tool_call_id: None,
        });
    }
    Ok(messages)
}

fn parse_messages_tools(value: Option<&Value>) -> CResult<Vec<ToolDef>> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Ok(Vec::new());
    };
    let items = value
        .as_array()
        .ok_or_else(|| "messages: field 'tools' must be an array".to_string())?;
    let mut tools = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let ctx = format!("messages.tools[{index}]");
        let tool = as_object(item, &ctx)?;
        reject_unknown(
            tool,
            &["name", "description", "input_schema", "strict"],
            &ctx,
        )?;
        let parameters = present(tool, "input_schema")
            .cloned()
            .ok_or_else(|| format!("{ctx}: field 'input_schema' is required"))?;
        if !parameters.is_object() {
            return Err(format!("{ctx}: field 'input_schema' must be an object"));
        }
        if get_bool(tool, "strict", &ctx)?.unwrap_or(false) {
            return Err(format!(
                "{ctx}: field 'strict: true' is unsupported when converting between protocols"
            ));
        }
        tools.push(ToolDef {
            name: require_nonempty_string(tool, "name", &ctx)?,
            description: get_string(tool, "description", &ctx)?,
            parameters,
        });
    }
    Ok(tools)
}

fn parse_messages_tool_choice(
    value: Option<&Value>,
) -> CResult<(Option<ToolChoice>, Option<bool>)> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Ok((None, None));
    };
    let ctx = "messages.tool_choice";
    let choice = as_object(value, ctx)?;
    reject_unknown(choice, &["type", "name", "disable_parallel_tool_use"], ctx)?;
    let typ = require_string(choice, "type", ctx)?;
    let tool_choice = match typ.as_str() {
        "auto" => ToolChoice::Auto,
        "any" => ToolChoice::Required,
        "none" => ToolChoice::None,
        "tool" => ToolChoice::Named(require_nonempty_string(choice, "name", ctx)?),
        other => return Err(format!("{ctx}: unsupported tool choice type '{other}'")),
    };
    if typ != "tool" && choice.contains_key("name") {
        return Err(format!("{ctx}: 'name' is only supported for type 'tool'"));
    }
    let parallel = get_bool(choice, "disable_parallel_tool_use", ctx)?.map(|v| !v);
    Ok((Some(tool_choice), parallel))
}

// ---------------------------------------------------------------------------
// Protocol emitters
// ---------------------------------------------------------------------------

/// Chat has no way to signal that a call is required without tools, and an
/// empty tool list with `tool_choice: "none"` is redundant. Reject combinations
/// the upstream would reject so failures are explicit rather than upstream 400s.
fn require_tools_for_choice(request: &Request, protocol: &str) -> CResult<()> {
    let needs_tools = match &request.tool_choice {
        Some(ToolChoice::Auto) | Some(ToolChoice::None) | None => false,
        Some(ToolChoice::Required) | Some(ToolChoice::Named(_)) => true,
    };
    if needs_tools && request.tools.is_empty() {
        return Err(format!(
            "{protocol}: tool_choice selects a tool but no tools are defined"
        ));
    }
    if request.parallel_tool_calls == Some(true) && request.tools.is_empty() {
        return Err(format!(
            "{protocol}: parallel_tool_calls requires at least one tool"
        ));
    }
    Ok(())
}

fn check_tool_pairs(messages: &[Message], protocol: &str) -> CResult<()> {
    let mut open: Vec<&str> = Vec::new();
    for message in messages {
        match message.role {
            Role::Assistant => {
                if !message.tool_calls.is_empty() && !open.is_empty() {
                    return Err(format!(
                        "{protocol}: assistant tool call issued before previous tool results were provided"
                    ));
                }
                open = message
                    .tool_calls
                    .iter()
                    .map(|call| call.id.as_str())
                    .collect();
            }
            Role::Tool => {
                let id = message.tool_call_id.as_deref().unwrap_or_default();
                match open.iter().position(|candidate| *candidate == id) {
                    Some(index) => {
                        open.remove(index);
                    }
                    None => {
                        return Err(format!(
                            "{protocol}: tool result for unknown tool call '{id}'"
                        ))
                    }
                }
            }
            Role::User => {
                if !open.is_empty() {
                    return Err(format!(
                        "{protocol}: user message arrived before tool results for {} pending call(s)",
                        open.len()
                    ));
                }
            }
        }
    }
    if !open.is_empty() {
        return Err(format!(
            "{protocol}: missing tool result for {} call(s): {}",
            open.len(),
            open.join(", ")
        ));
    }
    Ok(())
}

fn emit_chat(request: &Request, model: &str) -> CResult<Value> {
    require_tools_for_choice(request, "chat")?;
    check_tool_pairs(&request.messages, "chat")?;
    let mut messages = Vec::new();
    if let Some(system) = &request.system {
        messages.push(json!({"role": "system", "content": system}));
    }
    for message in &request.messages {
        match message.role {
            Role::User => {
                let content = chat_content(message);
                messages.push(json!({"role": "user", "content": content}));
            }
            Role::Assistant => {
                if message.text.is_none() && message.tool_calls.is_empty() {
                    return Err(
                        "chat: assistant messages must have text or tool calls".to_string()
                    );
                }
                let mut value = json!({"role": "assistant", "content": message.text});
                if !message.tool_calls.is_empty() {
                    value["tool_calls"] = Value::Array(message.tool_calls.iter().map(|call| json!({"id": call.id, "type": "function", "function": {"name": call.name, "arguments": call.arguments}})).collect());
                }
                messages.push(value);
            }
            Role::Tool => messages.push(json!({"role": "tool", "tool_call_id": message.tool_call_id, "content": message.text.as_deref().unwrap_or("")})),
        }
    }
    let mut out = json!({"model": model, "messages": messages});
    if !request.tools.is_empty() {
        out["tools"] = Value::Array(
            request
                .tools
                .iter()
                .map(|tool| {
                    let mut function = json!({"name": tool.name, "parameters": tool.parameters});
                    if let Some(description) = &tool.description {
                        function["description"] = json!(description);
                    }
                    json!({"type": "function", "function": function})
                })
                .collect(),
        );
    }
    if let Some(choice) = &request.tool_choice {
        out["tool_choice"] = match choice {
            ToolChoice::Auto => json!("auto"),
            ToolChoice::None => json!("none"),
            ToolChoice::Required => json!("required"),
            ToolChoice::Named(name) => json!({"type": "function", "function": {"name": name}}),
        };
    }
    set_common(&mut out, request, "max_tokens", "stop");
    if let Some(parallel) = request.parallel_tool_calls {
        out["parallel_tool_calls"] = json!(parallel);
    }
    if let Some(effort) = &request.reasoning_effort {
        out["reasoning_effort"] = json!(effort);
    }
    Ok(out)
}

fn chat_content(message: &Message) -> Value {
    if message.images.is_empty() {
        return json!(message.text.as_deref().unwrap_or(""));
    }
    let mut parts = Vec::new();
    if let Some(text) = &message.text {
        parts.push(json!({"type": "text", "text": text}));
    }
    for image in &message.images {
        parts.push(json!({"type": "image_url", "image_url": {"url": image}}));
    }
    Value::Array(parts)
}

fn emit_responses(request: &Request, model: &str, codex: bool) -> CResult<Value> {
    require_tools_for_choice(request, "responses")?;
    check_tool_pairs(&request.messages, "responses")?;
    if !request.stop.is_empty() {
        return Err(
            "responses: stop sequences are unsupported by the Responses protocol".to_string(),
        );
    }
    let mut input = Vec::new();
    for message in &request.messages {
        match message.role {
            Role::User | Role::Assistant => {
                if message.role == Role::User || message.text.is_some() {
                    let role = if message.role == Role::User { "user" } else { "assistant" };
                    let part_type = if message.role == Role::User { "input_text" } else { "output_text" };
                    let mut parts = Vec::new();
                    if let Some(text) = &message.text { parts.push(json!({"type": part_type, "text": text})); }
                    for image in &message.images { parts.push(json!({"type": "input_image", "image_url": image})); }
                    input.push(json!({"type": "message", "role": role, "content": parts}));
                }
                for call in &message.tool_calls { input.push(json!({"type": "function_call", "call_id": call.id, "name": call.name, "arguments": call.arguments})); }
            }
            Role::Tool => input.push(json!({"type": "function_call_output", "call_id": message.tool_call_id, "output": message.text.as_deref().unwrap_or("")})),
        }
    }
    if input.is_empty() {
        return Err("responses: at least one input item is required".to_string());
    }
    let mut out = json!({"model": model, "input": input});
    if let Some(system) = &request.system {
        out["instructions"] = json!(system);
    }
    if !request.tools.is_empty() {
        out["tools"] = Value::Array(request.tools.iter().map(|tool| {
            let mut value = json!({"type": "function", "name": tool.name, "parameters": tool.parameters});
            if let Some(description) = &tool.description { value["description"] = json!(description); }
            value
        }).collect());
    }
    if let Some(choice) = &request.tool_choice {
        out["tool_choice"] = match choice {
            ToolChoice::Auto => json!("auto"),
            ToolChoice::None => json!("none"),
            ToolChoice::Required => json!("required"),
            ToolChoice::Named(name) => json!({"type": "function", "name": name}),
        };
    }
    set_common(&mut out, request, "max_output_tokens", "stop");
    if let Some(parallel) = request.parallel_tool_calls {
        out["parallel_tool_calls"] = json!(parallel);
    }
    if let Some(effort) = &request.reasoning_effort {
        out["reasoning"] = json!({"effort": effort});
    }
    if codex {
        out["stream"] = json!(true);
        out["store"] = json!(false);
    }
    Ok(out)
}

fn emit_messages(request: &Request, model: &str) -> CResult<Value> {
    require_tools_for_choice(request, "messages")?;
    check_tool_pairs(&request.messages, "messages")?;
    if request.reasoning_effort.is_some() {
        return Err(
            "messages: reasoning effort is unsupported by the Messages protocol".to_string(),
        );
    }
    if request.messages.is_empty() {
        return Err("messages: at least one user or assistant message is required".to_string());
    }
    let max_tokens = request.max_tokens.ok_or_else(|| {
        "messages: 'max_tokens' is required; source request did not specify a token limit"
            .to_string()
    })?;
    let mut messages: Vec<Value> = Vec::new();
    for message in &request.messages {
        match message.role {
            Role::User => {
                let mut content = Vec::new();
                if let Some(text) = &message.text {
                    content.push(json!({"type": "text", "text": text}));
                }
                for image in &message.images {
                    content.push(messages_image(image)?);
                }
                if content.is_empty() {
                    return Err("messages: user messages must not have empty content".to_string());
                }
                if let Some(last) = messages.last_mut() {
                    let tool_results = last["content"].as_array().is_some_and(|blocks| {
                        blocks.iter().any(|block| block["type"] == "tool_result")
                    });
                    if last["role"] == "user" && tool_results {
                        last["content"]
                            .as_array_mut()
                            .expect("checked array")
                            .extend(content);
                        continue;
                    }
                }
                messages.push(json!({"role": "user", "content": content}));
            }
            Role::Assistant => {
                let mut content = Vec::new();
                if let Some(text) = &message.text {
                    content.push(json!({"type": "text", "text": text}));
                }
                for call in &message.tool_calls {
                    let input: Value = serde_json::from_str(&call.arguments).map_err(|_| {
                        format!(
                            "messages: tool call '{}' arguments must be a JSON object",
                            call.id
                        )
                    })?;
                    if !input.is_object() {
                        return Err(format!(
                            "messages: tool call '{}' arguments must be a JSON object",
                            call.id
                        ));
                    }
                    content.push(json!({"type": "tool_use", "id": call.id, "name": call.name, "input": input}));
                }
                if content.is_empty() {
                    return Err(
                        "messages: assistant messages must not have empty content".to_string()
                    );
                }
                messages.push(json!({"role": "assistant", "content": content}));
            }
            Role::Tool => {
                let tool_call_id = message
                    .tool_call_id
                    .as_deref()
                    .ok_or_else(|| "messages: tool results require a tool_call_id".to_string())?;
                if messages.is_empty() {
                    return Err("messages: a tool result cannot be the first message".to_string());
                }
                let block = json!({
                    "type": "tool_result",
                    "tool_use_id": tool_call_id,
                    "content": message.text.as_deref().unwrap_or("")
                });
                // Adjacent results must share one user turn in Messages.
                let last = messages.last_mut().expect("checked non-empty");
                let result_turn = last["role"] == "user"
                    && last["content"].as_array().is_some_and(|items| {
                        items.iter().all(|item| item["type"] == "tool_result")
                    });
                if result_turn {
                    last["content"]
                        .as_array_mut()
                        .expect("checked array")
                        .push(block);
                } else {
                    messages.push(json!({"role": "user", "content": [block]}));
                }
            }
        }
    }
    let mut out = json!({"model": model, "messages": messages, "max_tokens": max_tokens});
    if let Some(system) = &request.system {
        out["system"] = json!(system);
    }
    if !request.tools.is_empty() {
        out["tools"] = Value::Array(
            request
                .tools
                .iter()
                .map(|tool| {
                    let mut value = json!({"name": tool.name, "input_schema": tool.parameters});
                    if let Some(description) = &tool.description {
                        value["description"] = json!(description);
                    }
                    value
                })
                .collect(),
        );
    }
    if request.tool_choice.is_some() || request.parallel_tool_calls.is_some() {
        let mut choice = match request.tool_choice.as_ref().unwrap_or(&ToolChoice::Auto) {
            ToolChoice::Auto => json!({"type": "auto"}),
            ToolChoice::None => json!({"type": "none"}),
            ToolChoice::Required => json!({"type": "any"}),
            ToolChoice::Named(name) => json!({"type": "tool", "name": name}),
        };
        if let Some(parallel) = request.parallel_tool_calls {
            choice["disable_parallel_tool_use"] = json!(!parallel);
        }
        out["tool_choice"] = choice;
    }
    set_common(&mut out, request, "max_tokens", "stop_sequences");
    Ok(out)
}

fn messages_image(url: &str) -> CResult<Value> {
    if let Some(data) = url.strip_prefix("data:") {
        let (header, data) = data
            .split_once(',')
            .ok_or_else(|| "messages: invalid image data URI".to_string())?;
        let media_type = header
            .strip_suffix(";base64")
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                "messages: image data URI must specify media type and base64 encoding".to_string()
            })?;
        if data.is_empty() {
            return Err("messages: image data URI is empty".to_string());
        }
        Ok(
            json!({"type": "image", "source": {"type": "base64", "media_type": media_type, "data": data}}),
        )
    } else if url.starts_with("https://") || url.starts_with("http://") {
        Ok(json!({"type": "image", "source": {"type": "url", "url": url}}))
    } else {
        Err("messages: image URL must use http, https or a base64 data URI".to_string())
    }
}

fn set_common(out: &mut Value, request: &Request, max_key: &str, stop_key: &str) {
    if let Some(value) = request.max_tokens {
        out[max_key] = json!(value);
    }
    if let Some(value) = request.temperature {
        out["temperature"] = json!(value);
    }
    if let Some(value) = request.top_p {
        out["top_p"] = json!(value);
    }
    if !request.stop.is_empty() {
        out[stop_key] = json!(request.stop);
    }
    if let Some(stream) = request.stream {
        out["stream"] = json!(stream);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn conv(body: Value, from: &str, to: &str, codex: bool) -> Value {
        convert(&body, from, to, "target-model", codex).expect("conversion should succeed")
    }

    fn conv_err(body: Value, from: &str, to: &str, codex: bool) -> String {
        convert(&body, from, to, "target-model", codex).expect_err("conversion should fail")
    }

    // -- Same-protocol pass-through -----------------------------------------

    #[test]
    fn same_protocol_chat_only_swaps_model() {
        let body = json!({
            "model": "old-model",
            "messages": [{"role": "user", "content": "hi"}],
            "max_completion_tokens": 9,
            "custom": {"nested": true}
        });
        let out = conv(body.clone(), "chat", "chat", false);
        assert_eq!(out["model"], "target-model");
        assert_eq!(out["max_completion_tokens"], 9);
        assert_eq!(out["custom"], json!({"nested": true}));
        let mut expected = body;
        expected["model"] = json!("target-model");
        assert_eq!(out, expected);
    }

    #[test]
    fn same_protocol_messages_preserves_protocol_only_fields() {
        let body = json!({
            "model": "old-model",
            "max_tokens": 10,
            "thinking": {"type": "enabled", "budget_tokens": 1024},
            "metadata": {"user_id": "u1"},
            "messages": [{"role": "user", "content": "hi"}]
        });
        let out = conv(body.clone(), "messages", "messages", false);
        let mut expected = body;
        expected["model"] = json!("target-model");
        assert_eq!(out, expected);
    }

    #[test]
    fn same_protocol_responses_preserves_unknown_fields() {
        let body = json!({
            "model": "old-model",
            "input": "hi",
            "include": ["reasoning.encrypted_content"],
            "prompt_cache_key": "abc"
        });
        let out = conv(body.clone(), "responses", "responses", false);
        let mut expected = body;
        expected["model"] = json!("target-model");
        assert_eq!(out, expected);
    }

    #[test]
    fn codex_responses_forces_stream_and_store() {
        let body = json!({
            "model": "old-model",
            "input": "hi",
            "stream": false,
            "store": true,
            "include": ["reasoning.encrypted_content"],
            "instructions": "be brief"
        });
        let out = conv(body, "responses", "responses", true);
        assert_eq!(out["model"], "target-model");
        assert_eq!(out["stream"], true);
        assert_eq!(out["store"], false);
        assert_eq!(out["include"], json!(["reasoning.encrypted_content"]));
        assert_eq!(out["instructions"], "be brief");
    }

    #[test]
    fn codex_rejects_stateful_responses_features() {
        let message = conv_err(
            json!({"input": "hi", "previous_response_id": "resp_1"}),
            "responses",
            "responses",
            true,
        );
        assert!(message.contains("previous_response_id"), "{message}");
        let message = conv_err(
            json!({"input": "hi", "background": true}),
            "responses",
            "responses",
            true,
        );
        assert!(message.contains("background"), "{message}");
    }

    #[test]
    fn codex_requires_responses_target() {
        let body = json!({"messages": [{"role": "user", "content": "hi"}]});
        let message = conv_err(body, "chat", "messages", true);
        assert!(message.contains("codex"), "{message}");
    }

    // -- Chat -> Messages ----------------------------------------------------

    #[test]
    fn chat_to_messages_basic() {
        let body = json!({
            "model": "m",
            "messages": [
                {"role": "system", "content": "sys"},
                {"role": "user", "content": "hi"}
            ],
            "max_tokens": 64,
            "stream": true,
            "temperature": 0.2,
            "top_p": 0.9,
            "stop": ["STOP"]
        });
        let out = conv(body, "chat", "messages", false);
        assert_eq!(out["system"], "sys");
        assert_eq!(
            out["messages"],
            json!([{"role": "user", "content": [{"type": "text", "text": "hi"}]}])
        );
        assert_eq!(out["max_tokens"], 64);
        assert_eq!(out["stream"], true);
        assert_eq!(out["temperature"], 0.2);
        assert_eq!(out["top_p"], 0.9);
        assert_eq!(out["stop_sequences"], json!(["STOP"]));
    }

    #[test]
    fn chat_to_messages_tools_calls_and_results() {
        let body = json!({
            "model": "m",
            "messages": [
                {"role": "user", "content": "look"},
                {"role": "assistant", "content": null, "tool_calls": [{
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "lookup", "arguments": "{\"q\":\"x\"}"}
                }]},
                {"role": "tool", "tool_call_id": "call_1", "content": "found"}
            ],
            "tools": [{
                "type": "function",
                "function": {
                    "name": "lookup",
                    "description": "Find",
                    "parameters": {"type": "object", "properties": {"q": {"type": "string"}}}
                }
            }],
            "tool_choice": "auto",
            "parallel_tool_calls": false,
            "max_tokens": 32
        });
        let out = conv(body, "chat", "messages", false);
        assert_eq!(
            out["messages"][0],
            json!({"role": "user", "content": [{"type": "text", "text": "look"}]})
        );
        assert_eq!(
            out["messages"][1],
            json!({"role": "assistant", "content": [
                {"type": "tool_use", "id": "call_1", "name": "lookup", "input": {"q": "x"}}
            ]})
        );
        assert_eq!(
            out["messages"][2],
            json!({"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "call_1", "content": "found"}
            ]})
        );
        assert_eq!(
            out["tools"][0],
            json!({
                "name": "lookup",
                "description": "Find",
                "input_schema": {"type": "object", "properties": {"q": {"type": "string"}}}
            })
        );
        assert_eq!(
            out["tool_choice"],
            json!({"type": "auto", "disable_parallel_tool_use": true})
        );
    }

    #[test]
    fn chat_max_completion_tokens_is_an_alias_for_max_tokens() {
        let body = json!({
            "messages": [{"role": "user", "content": "hi"}],
            "max_completion_tokens": 40
        });
        let out = conv(body, "chat", "messages", false);
        assert_eq!(out["max_tokens"], 40);
    }

    #[test]
    fn rejects_empty_user_content() {
        let message = conv_err(
            json!({"messages": [{"role": "user", "content": []}]}),
            "chat",
            "messages",
            false,
        );
        assert!(message.contains("empty content"), "{message}");
    }

    #[test]
    fn chat_multiple_system_messages_are_joined() {
        let body = json!({
            "messages": [
                {"role": "system", "content": "one"},
                {"role": "developer", "content": "two"},
                {"role": "user", "content": "hi"}
            ],
            "max_tokens": 5
        });
        let out = conv(body, "chat", "messages", false);
        assert_eq!(out["system"], "one\n\ntwo");
    }

    // -- Messages -> Chat ----------------------------------------------------

    #[test]
    fn messages_to_chat_system_content_tools_and_images() {
        let body = json!({
            "model": "m",
            "system": [
                {"type": "text", "text": "a"},
                {"type": "text", "text": "b"}
            ],
            "max_tokens": 20,
            "messages": [
                {"role": "user", "content": [
                    {"type": "text", "text": "hi"},
                    {"type": "image", "source": {"type": "url", "url": "https://example.com/a.png"}}
                ]},
                {"role": "assistant", "content": [
                    {"type": "text", "text": "calling"},
                    {"type": "tool_use", "id": "t1", "name": "f", "input": {"a": 1}}
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "t1", "content": "ok"},
                    {"type": "text", "text": "then"}
                ]}
            ],
            "tools": [{
                "name": "f",
                "description": "desc",
                "input_schema": {"type": "object", "properties": {"a": {"type": "number"}}}
            }],
            "tool_choice": {"type": "any", "disable_parallel_tool_use": false}
        });
        let out = conv(body, "messages", "chat", false);
        assert_eq!(
            out["messages"][0],
            json!({"role": "system", "content": "a\n\nb"})
        );
        assert_eq!(
            out["messages"][1]["content"][0],
            json!({"type": "text", "text": "hi"})
        );
        assert_eq!(
            out["messages"][1]["content"][1],
            json!({"type": "image_url", "image_url": {"url": "https://example.com/a.png"}})
        );
        assert_eq!(
            out["messages"][2],
            json!({
                "role": "assistant",
                "content": "calling",
                "tool_calls": [{
                    "id": "t1",
                    "type": "function",
                    "function": {"name": "f", "arguments": "{\"a\":1}"}
                }]
            })
        );
        assert_eq!(
            out["messages"][3],
            json!({"role": "tool", "tool_call_id": "t1", "content": "ok"})
        );
        assert_eq!(
            out["messages"][4],
            json!({"role": "user", "content": "then"})
        );
        assert_eq!(
            out["tools"][0],
            json!({
                "type": "function",
                "function": {
                    "name": "f",
                    "description": "desc",
                    "parameters": {"type": "object", "properties": {"a": {"type": "number"}}}
                }
            })
        );
        assert_eq!(out["tool_choice"], "required");
        assert_eq!(out["parallel_tool_calls"], true);
    }

    #[test]
    fn messages_named_tool_choice_maps_to_chat_function() {
        let body = json!({
            "max_tokens": 5,
            "messages": [{"role": "user", "content": "hi"}],
            "tools": [{"name": "f", "input_schema": {"type": "object"}}],
            "tool_choice": {"type": "tool", "name": "f"}
        });
        let out = conv(body, "messages", "chat", false);
        assert_eq!(
            out["tool_choice"],
            json!({"type": "function", "function": {"name": "f"}})
        );
    }

    #[test]
    fn messages_base64_image_becomes_data_uri() {
        let body = json!({
            "max_tokens": 5,
            "messages": [{"role": "user", "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AAAA"}}
            ]}]
        });
        let out = conv(body, "messages", "chat", false);
        assert_eq!(
            out["messages"][0]["content"][0]["image_url"]["url"],
            "data:image/png;base64,AAAA"
        );
    }

    // -- Responses -> Chat ---------------------------------------------------

    #[test]
    fn responses_to_chat_instructions_calls_and_results() {
        let body = json!({
            "model": "m",
            "instructions": "you are helpful",
            "input": [
                {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}]},
                {"type": "function_call", "call_id": "c1", "name": "f", "arguments": "{\"a\":2}"},
                {"type": "function_call_output", "call_id": "c1", "output": "done"}
            ],
            "max_output_tokens": 128,
            "reasoning": {"effort": "high"},
            "tools": [{"type": "function", "name": "f", "description": "d", "parameters": {"type": "object"}}],
            "tool_choice": "required",
            "parallel_tool_calls": true,
            "stream": true,
            "store": false
        });
        let out = conv(body, "responses", "chat", false);
        assert_eq!(
            out["messages"][0],
            json!({"role": "system", "content": "you are helpful"})
        );
        assert_eq!(out["messages"][1], json!({"role": "user", "content": "hi"}));
        assert_eq!(
            out["messages"][2],
            json!({
                "role": "assistant",
                "content": null,
                "tool_calls": [{
                    "id": "c1",
                    "type": "function",
                    "function": {"name": "f", "arguments": "{\"a\":2}"}
                }]
            })
        );
        assert_eq!(
            out["messages"][3],
            json!({"role": "tool", "tool_call_id": "c1", "content": "done"})
        );
        assert_eq!(out["max_tokens"], 128);
        assert_eq!(out["reasoning_effort"], "high");
        assert_eq!(out["stream"], true);
        assert_eq!(out["tool_choice"], "required");
        assert_eq!(out["parallel_tool_calls"], true);
        assert_eq!(
            out["tools"][0],
            json!({"type": "function", "function": {
                "name": "f", "description": "d", "parameters": {"type": "object"}
            }})
        );
    }

    #[test]
    fn responses_string_input_becomes_user_message() {
        let body = json!({"input": "hello", "max_output_tokens": 5});
        let out = conv(body, "responses", "chat", false);
        assert_eq!(
            out["messages"],
            json!([{"role": "user", "content": "hello"}])
        );
    }

    #[test]
    fn responses_adjacent_function_calls_merge_into_one_assistant_turn() {
        let body = json!({
            "input": [
                {"type": "message", "role": "user", "content": "go"},
                {"type": "function_call", "call_id": "c1", "name": "a", "arguments": "{}"},
                {"type": "function_call", "call_id": "c2", "name": "b", "arguments": "{}"},
                {"type": "function_call_output", "call_id": "c1", "output": "1"},
                {"type": "function_call_output", "call_id": "c2", "output": "2"}
            ],
            "max_output_tokens": 9
        });
        let out = conv(body, "responses", "chat", false);
        assert_eq!(
            out["messages"][1]["tool_calls"].as_array().unwrap().len(),
            2
        );
        assert_eq!(out["messages"][2]["tool_call_id"], "c1");
        assert_eq!(out["messages"][3]["tool_call_id"], "c2");
    }

    // -- Chat -> Responses ---------------------------------------------------

    #[test]
    fn chat_to_responses_system_tools_and_tool_results() {
        let body = json!({
            "model": "m",
            "messages": [
                {"role": "system", "content": "sys"},
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": null, "tool_calls": [{
                    "id": "c1",
                    "type": "function",
                    "function": {"name": "f", "arguments": "{\"a\":2}"}
                }]},
                {"role": "tool", "tool_call_id": "c1", "content": "done"}
            ],
            "max_tokens": 128,
            "reasoning_effort": "high",
            "tools": [{"type": "function", "function": {"name": "f", "parameters": {"type": "object"}}}],
            "tool_choice": {"type": "function", "function": {"name": "f"}},
            "parallel_tool_calls": true
        });
        let out = conv(body, "chat", "responses", false);
        assert_eq!(out["instructions"], "sys");
        assert_eq!(
            out["input"],
            json!([
                {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}]},
                {"type": "function_call", "call_id": "c1", "name": "f", "arguments": "{\"a\":2}"},
                {"type": "function_call_output", "call_id": "c1", "output": "done"}
            ])
        );
        assert_eq!(
            out["tools"][0],
            json!({"type": "function", "name": "f", "parameters": {"type": "object"}})
        );
        assert_eq!(out["tool_choice"], json!({"type": "function", "name": "f"}));
        assert_eq!(out["max_output_tokens"], 128);
        assert_eq!(out["reasoning"], json!({"effort": "high"}));
        assert_eq!(out["parallel_tool_calls"], true);
        assert!(out.get("stream").is_none());
        assert!(out.get("store").is_none());
    }

    #[test]
    fn codex_chat_to_responses_forces_stream_and_store() {
        let body = json!({
            "messages": [{"role": "user", "content": "hi"}],
            "max_tokens": 8
        });
        let out = conv(body, "chat", "responses", true);
        assert_eq!(out["stream"], true);
        assert_eq!(out["store"], false);
        assert_eq!(out["input"][0]["role"], "user");
        assert_eq!(out["max_output_tokens"], 8);
    }

    // -- Messages -> Responses ----------------------------------------------

    #[test]
    fn messages_to_responses_tool_blocks() {
        let body = json!({
            "model": "m",
            "system": "sys",
            "max_tokens": 50,
            "messages": [
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": [
                    {"type": "tool_use", "id": "t1", "name": "f", "input": {}}
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "t1", "content": "ok"}
                ]}
            ]
        });
        let out = conv(body, "messages", "responses", false);
        assert_eq!(out["instructions"], "sys");
        assert_eq!(
            out["input"],
            json!([
                {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}]},
                {"type": "function_call", "call_id": "t1", "name": "f", "arguments": "{}"},
                {"type": "function_call_output", "call_id": "t1", "output": "ok"}
            ])
        );
        assert_eq!(out["max_output_tokens"], 50);
    }

    // -- Responses -> Messages ----------------------------------------------

    #[test]
    fn responses_to_messages_tool_calls_and_results() {
        let body = json!({
            "model": "m",
            "instructions": "sys",
            "max_output_tokens": 77,
            "input": [
                {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}]},
                {"type": "function_call", "call_id": "c1", "name": "f", "arguments": "{\"a\":1}"},
                {"type": "function_call_output", "call_id": "c1", "output": "done"}
            ]
        });
        let out = conv(body, "responses", "messages", false);
        assert_eq!(out["system"], "sys");
        assert_eq!(out["max_tokens"], 77);
        assert_eq!(
            out["messages"][0],
            json!({"role": "user", "content": [{"type": "text", "text": "hi"}]})
        );
        assert_eq!(
            out["messages"][1],
            json!({"role": "assistant", "content": [
                {"type": "tool_use", "id": "c1", "name": "f", "input": {"a": 1}}
            ]})
        );
        assert_eq!(
            out["messages"][2],
            json!({"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "c1", "content": "done"}
            ]})
        );
    }

    #[test]
    fn chat_data_uri_image_becomes_messages_base64_source() {
        let body = json!({
            "messages": [{"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}
            ]}],
            "max_tokens": 5
        });
        let out = conv(body, "chat", "messages", false);
        assert_eq!(
            out["messages"][0]["content"][0],
            json!({"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AAAA"}})
        );
    }

    #[test]
    fn rejects_tool_choice_without_tools() {
        let message = conv_err(
            json!({
                "messages": [{"role": "user", "content": "hi"}],
                "tool_choice": "required"
            }),
            "chat",
            "messages",
            false,
        );
        assert!(message.contains("no tools"), "{message}");
    }

    #[test]
    fn chat_tool_result_without_prior_assistant_is_rejected_by_messages_target() {
        let body = json!({
            "max_tokens": 5,
            "messages": [
                {"role": "tool", "tool_call_id": "c1", "content": "x"}
            ]
        });
        let message = conv_err(body, "chat", "messages", false);
        assert!(message.contains("unknown tool call"), "{message}");
    }

    #[test]
    fn messages_tool_result_only_turn_round_trips_without_empty_user_turn() {
        let body = json!({
            "max_tokens": 5,
            "messages": [
                {"role": "assistant", "content": [
                    {"type": "tool_use", "id": "t1", "name": "f", "input": {}}
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "t1", "content": "x"}
                ]}
            ]
        });
        // Same protocol clones; forcing a conversion exercises the emitter.
        let cloned = convert(&body, "messages", "messages", "m", false).unwrap();
        assert_eq!(cloned["messages"], body["messages"]);
    }

    #[test]
    fn rejects_empty_message_content_for_messages_target() {
        let message = conv_err(
            json!({
                "max_tokens": 5,
                "messages": [{"role": "assistant", "content": null}]
            }),
            "chat",
            "messages",
            false,
        );
        assert!(message.contains("assistant messages"), "{message}");
    }

    // -- Validation / explicit errors ---------------------------------------

    #[test]
    fn rejects_unknown_fields_per_protocol() {
        assert!(conv_err(
            json!({"messages": [{"role": "user", "content": "hi"}], "logprobs": true}),
            "chat",
            "messages",
            false
        )
        .contains("unsupported field 'logprobs'"));
        assert!(conv_err(
            json!({"input": "hi", "metadata": {}}),
            "responses",
            "chat",
            false
        )
        .contains("unsupported field 'metadata'"));
        assert!(conv_err(
            json!({
                "max_tokens": 5,
                "messages": [{"role": "user", "content": "hi"}],
                "thinking": {"type": "enabled"}
            }),
            "messages",
            "chat",
            false
        )
        .contains("unsupported field 'thinking'"));
    }

    #[test]
    fn rejects_multiple_chat_choices() {
        let message = conv_err(
            json!({"messages": [{"role": "user", "content": "hi"}], "n": 2}),
            "chat",
            "messages",
            false,
        );
        assert!(message.contains("'n'"), "{message}");
    }

    #[test]
    fn rejects_unsupported_tool_types() {
        let message = conv_err(
            json!({
                "messages": [{"role": "user", "content": "hi"}],
                "tools": [{"type": "web_search"}]
            }),
            "chat",
            "messages",
            false,
        );
        assert!(message.contains("tool type"), "{message}");
        let message = conv_err(
            json!({
                "input": [{"type": "message", "role": "user", "content": "hi"}],
                "tools": [{"type": "custom", "name": "x"}]
            }),
            "responses",
            "chat",
            false,
        );
        assert!(message.contains("tool type"), "{message}");
    }

    #[test]
    fn rejects_unsupported_responses_input_items() {
        let message = conv_err(
            json!({"input": [{"type": "custom_tool_call", "name": "x"}]}),
            "responses",
            "chat",
            false,
        );
        assert!(
            message.contains("unsupported responses input item type"),
            "{message}"
        );
    }

    #[test]
    fn rejects_strict_tools_and_legacy_function_role() {
        let message = conv_err(
            json!({
                "messages": [{"role": "user", "content": "hi"}],
                "tools": [{"type": "function", "function": {"name": "f", "strict": true}}]
            }),
            "chat",
            "messages",
            false,
        );
        assert!(message.contains("strict"), "{message}");
        let message = conv_err(
            json!({"messages": [{"role": "function", "name": "f", "content": "x"}]}),
            "chat",
            "messages",
            false,
        );
        assert!(message.contains("legacy role 'function'"), "{message}");
    }

    #[test]
    fn accepts_strict_false_and_text_tool_result_blocks() {
        let body = json!({
            "max_tokens": 5,
            "messages": [
                {"role": "assistant", "content": [
                    {"type": "tool_use", "id": "t1", "name": "f", "input": {}}
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "t1", "content": [
                        {"type": "text", "text": "one"},
                        {"type": "text", "text": "two"}
                    ]}
                ]}
            ],
            "tools": [{
                "name": "f",
                "input_schema": {"type": "object"},
                "strict": false
            }]
        });
        let out = conv(body, "messages", "chat", false);
        assert_eq!(
            out["messages"][1],
            json!({"role": "tool", "tool_call_id": "t1", "content": "one\ntwo"})
        );
        assert_eq!(out["tools"][0]["function"]["name"], "f");
    }

    #[test]
    fn rejects_unpaired_tool_calls_and_results() {
        let missing = conv_err(
            json!({
                "messages": [
                    {"role": "user", "content": "go"},
                    {"role": "assistant", "content": null, "tool_calls": [{
                        "id": "c1", "type": "function",
                        "function": {"name": "f", "arguments": "{}"}
                    }]}
                ]
            }),
            "chat",
            "messages",
            false,
        );
        assert!(missing.contains("missing tool result"), "{missing}");
        let unknown = conv_err(
            json!({
                "input": [
                    {"type": "message", "role": "user", "content": "go"},
                    {"type": "function_call_output", "call_id": "nope", "output": "x"}
                ]
            }),
            "responses",
            "chat",
            false,
        );
        assert!(unknown.contains("unknown tool call"), "{unknown}");
    }

    #[test]
    fn rejects_assistant_images_from_messages() {
        let message = conv_err(
            json!({
                "max_tokens": 5,
                "messages": [{"role": "assistant", "content": [
                    {"type": "image", "source": {"type": "url", "url": "https://example.com/a.png"}}
                ]}]
            }),
            "messages",
            "chat",
            false,
        );
        assert!(
            message.contains("unsupported content block type 'image'"),
            "{message}"
        );
    }

    #[test]
    fn rejects_tool_result_errors_from_messages() {
        let message = conv_err(
            json!({
                "max_tokens": 5,
                "messages": [{"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "t1", "content": "x", "is_error": true}
                ]}]
            }),
            "messages",
            "chat",
            false,
        );
        assert!(message.contains("is_error"), "{message}");
    }

    #[test]
    fn rejects_responses_store_true_on_cross_protocol_conversion() {
        let message = conv_err(
            json!({"input": "hi", "store": true, "max_output_tokens": 5}),
            "responses",
            "chat",
            false,
        );
        assert!(message.contains("store"), "{message}");
    }

    #[test]
    fn rejects_stop_sequences_when_target_is_responses() {
        let message = conv_err(
            json!({
                "max_tokens": 5,
                "stop_sequences": ["x"],
                "messages": [{"role": "user", "content": "hi"}]
            }),
            "messages",
            "responses",
            false,
        );
        assert!(message.contains("stop sequences"), "{message}");
    }

    #[test]
    fn rejects_reasoning_effort_when_target_is_messages() {
        let message = conv_err(
            json!({
                "messages": [{"role": "user", "content": "hi"}],
                "reasoning_effort": "high",
                "max_tokens": 5
            }),
            "chat",
            "messages",
            false,
        );
        assert!(message.contains("reasoning effort"), "{message}");
    }

    #[test]
    fn messages_target_requires_a_token_limit() {
        let message = conv_err(
            json!({"messages": [{"role": "user", "content": "hi"}]}),
            "chat",
            "messages",
            false,
        );
        assert!(message.contains("max_tokens"), "{message}");
    }

    #[test]
    fn rejects_empty_or_non_object_requests() {
        assert!(
            convert(&json!({"input": "hi"}), "responses", "chat", "", false)
                .unwrap_err()
                .contains("model")
        );
        assert!(convert(&json!([]), "chat", "responses", "m", false)
            .unwrap_err()
            .contains("JSON object"));
        assert!(convert(&json!({}), "openai", "chat", "m", false)
            .unwrap_err()
            .contains("unsupported protocol"));
        assert!(convert(&json!({}), "chat", "anthropic", "m", false)
            .unwrap_err()
            .contains("unsupported protocol"));
    }

    #[test]
    fn rejects_empty_collections_and_multiple_system_only_input() {
        assert!(conv_err(json!({"messages": []}), "chat", "messages", false)
            .contains("must not be empty"));
        assert!(conv_err(json!({"input": []}), "responses", "chat", false)
            .contains("must not be empty"));
        let message = conv_err(
            json!({
                "input": [{"type": "message", "role": "system", "content": "sys"}],
                "max_output_tokens": 5
            }),
            "responses",
            "messages",
            false,
        );
        assert!(
            message.contains("at least one user or assistant message"),
            "{message}"
        );
    }
}
