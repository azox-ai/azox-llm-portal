//! Response conversion independent of the HTTP transport.
//!
//! `StreamTranslator::push` accepts arbitrary byte boundaries and returns complete
//! UTF-8 SSE frames. Call `finish` at EOF to validate termination. `collect`
//! converts a complete non-streaming JSON body. No HTTP status is inferred.
//! Only one assistant choice is representable; unsupported content is an error.

use serde_json::{json, Value};
use std::{collections::BTreeMap, fmt};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Protocol {
    Chat,
    Responses,
    Messages,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConversionError(pub String);
impl fmt::Display for ConversionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for ConversionError {}
type Result<T> = std::result::Result<T, ConversionError>;
fn error(s: impl Into<String>) -> ConversionError {
    ConversionError(s.into())
}
fn string<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn required<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| error(format!("missing string {key}")))
}

#[derive(Default, Clone, Debug)]
struct Tool {
    id: String,
    name: String,
    args: String,
}
#[derive(Default, Clone, Debug)]
struct State {
    id: String,
    model: String,
    text: String,
    tools: BTreeMap<usize, Tool>,
    input: Option<u64>,
    output: Option<u64>,
    reason: Option<String>,
}
impl State {
    fn usage(&mut self, v: &Value, p: Protocol) {
        let (i, o) = match p {
            Protocol::Chat => ("prompt_tokens", "completion_tokens"),
            _ => ("input_tokens", "output_tokens"),
        };
        if let Some(n) = v.get(i).and_then(Value::as_u64) {
            self.input = Some(n);
        }
        if let Some(n) = v.get(o).and_then(Value::as_u64) {
            self.output = Some(n);
        }
    }
    fn usage_json(&self, p: Protocol) -> Value {
        let i = self.input.unwrap_or(0);
        let o = self.output.unwrap_or(0);
        match p {
            Protocol::Chat => json!({"prompt_tokens":i,"completion_tokens":o,"total_tokens":i+o}),
            Protocol::Responses => json!({"input_tokens":i,"output_tokens":o,"total_tokens":i+o}),
            Protocol::Messages => json!({"input_tokens":i,"output_tokens":o}),
        }
    }
    fn reason(&self, p: Protocol) -> &'static str {
        let r = self.reason.as_deref().unwrap_or(if self.tools.is_empty() {
            "stop"
        } else {
            "tool_calls"
        });
        match p {
            Protocol::Chat => match r {
                "max_tokens" | "length" | "max_output_tokens" => "length",
                "tool_use" | "tool_calls" => "tool_calls",
                "content_filter" => "content_filter",
                _ => "stop",
            },
            Protocol::Messages => match r {
                "max_tokens" | "length" | "max_output_tokens" => "max_tokens",
                "tool_use" | "tool_calls" => "tool_use",
                "stop_sequence" => "stop_sequence",
                _ => "end_turn",
            },
            Protocol::Responses => match r {
                "max_tokens" | "length" | "max_output_tokens" => "incomplete",
                _ => "completed",
            },
        }
    }
    fn body(&self, p: Protocol) -> Result<Value> {
        let mut blocks = Vec::new();
        if !self.text.is_empty() {
            blocks.push(json!({"type":"text","text":self.text}));
        }
        for t in self.tools.values() {
            let args: Value = serde_json::from_str(&t.args)
                .map_err(|e| error(format!("invalid tool arguments: {e}")))?;
            blocks.push(json!({"type":"tool_use","id":t.id,"name":t.name,"input":args}));
        }
        Ok(match p {
            Protocol::Messages => {
                json!({"id":self.id,"type":"message","role":"assistant","model":self.model,"content":blocks,"stop_reason":self.reason(p),"stop_sequence":null,"usage":self.usage_json(p)})
            }
            Protocol::Chat => {
                let tools: Vec<_> = self.tools.values().map(|t| json!({"id":t.id,"type":"function","function":{"name":t.name,"arguments":t.args}})).collect();
                let mut message = json!({"role":"assistant","content":if self.text.is_empty() && !tools.is_empty() { Value::Null } else { json!(self.text) }});
                if !tools.is_empty() {
                    message["tool_calls"] = json!(tools);
                }
                json!({"id":self.id,"object":"chat.completion","model":self.model,"choices":[{"index":0,"message":message,"finish_reason":self.reason(p)}],"usage":self.usage_json(p)})
            }
            Protocol::Responses => {
                let mut output = Vec::new();
                if !self.text.is_empty() {
                    output.push(json!({"id":format!("msg_{}",self.id),"type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":self.text,"annotations":[]}]}));
                }
                for t in self.tools.values() {
                    output.push(json!({"type":"function_call","id":t.id,"call_id":t.id,"name":t.name,"arguments":t.args,"status":"completed"}));
                }
                let mut v = json!({"id":self.id,"object":"response","model":self.model,"status":self.reason(p),"output":output,"usage":self.usage_json(p)});
                if self.reason(p) == "incomplete" {
                    v["incomplete_details"] = json!({"reason":"max_output_tokens"});
                }
                v
            }
        })
    }
}

fn parse_body(p: Protocol, v: &Value) -> Result<State> {
    if v.get("error").is_some() || string(v, "type") == "error" {
        return Err(error(format!(
            "upstream error: {}",
            v.get("error").unwrap_or(v)
        )));
    }
    let mut s = State {
        id: required(v, "id")?.into(),
        model: required(v, "model")?.into(),
        ..Default::default()
    };
    if let Some(u) = v.get("usage") {
        s.usage(u, p);
    }
    match p {
        Protocol::Chat => {
            let choices = v
                .get("choices")
                .and_then(Value::as_array)
                .ok_or_else(|| error("missing choices"))?;
            if choices.len() != 1 {
                return Err(error("only one chat choice is supported"));
            }
            let c = &choices[0];
            let m = c.get("message").ok_or_else(|| error("missing message"))?;
            if let Some(x) = m.get("content") {
                if let Some(t) = x.as_str() {
                    s.text = t.into();
                } else if !x.is_null() {
                    return Err(error("unsupported chat content"));
                }
            }
            if m.get("refusal").is_some_and(|x| !x.is_null()) {
                return Err(error("unsupported refusal"));
            }
            if let Some(ts) = m.get("tool_calls") {
                for (i, t) in ts
                    .as_array()
                    .ok_or_else(|| error("invalid tool_calls"))?
                    .iter()
                    .enumerate()
                {
                    if string(t, "type") != "function" {
                        return Err(error("unsupported chat tool type"));
                    }
                    let f = t.get("function").ok_or_else(|| error("missing function"))?;
                    s.tools.insert(
                        i,
                        Tool {
                            id: required(t, "id")?.into(),
                            name: required(f, "name")?.into(),
                            args: required(f, "arguments")?.into(),
                        },
                    );
                }
            }
            s.reason = c
                .get("finish_reason")
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
        Protocol::Messages => {
            for b in v
                .get("content")
                .and_then(Value::as_array)
                .ok_or_else(|| error("missing content"))?
            {
                match string(b, "type") {
                    "text" => s.text.push_str(required(b, "text")?),
                    "thinking" | "redacted_thinking" => {}
                    "tool_use" => {
                        let input = b.get("input").ok_or_else(|| error("missing tool input"))?;
                        let i = s.tools.len();
                        s.tools.insert(
                            i,
                            Tool {
                                id: required(b, "id")?.into(),
                                name: required(b, "name")?.into(),
                                args: input.to_string(),
                            },
                        );
                    }
                    t => return Err(error(format!("unsupported messages content: {t}"))),
                }
            }
            s.reason = v
                .get("stop_reason")
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
        Protocol::Responses => {
            for item in v
                .get("output")
                .and_then(Value::as_array)
                .ok_or_else(|| error("missing output"))?
            {
                match string(item, "type") {
                    "reasoning" => {}
                    "message" => {
                        for b in item
                            .get("content")
                            .and_then(Value::as_array)
                            .ok_or_else(|| error("missing message content"))?
                        {
                            if string(b, "type") != "output_text" {
                                return Err(error(format!(
                                    "unsupported responses content: {}",
                                    string(b, "type")
                                )));
                            }
                            if b.get("annotations")
                                .and_then(Value::as_array)
                                .is_some_and(|a| !a.is_empty())
                            {
                                return Err(error("unsupported output annotations"));
                            }
                            s.text.push_str(required(b, "text")?);
                        }
                    }
                    "function_call" => {
                        let i = s.tools.len();
                        s.tools.insert(
                            i,
                            Tool {
                                id: required(item, "call_id")?.into(),
                                name: required(item, "name")?.into(),
                                args: required(item, "arguments")?.into(),
                            },
                        );
                    }
                    t => return Err(error(format!("unsupported responses output: {t}"))),
                }
            }
            if string(v, "status") == "incomplete" {
                s.reason = Some("max_output_tokens".into());
            }
        }
    }
    Ok(s)
}

/// Convert one complete JSON response. Upstream error envelopes become errors.
pub fn collect(source: Protocol, target: Protocol, body: &[u8]) -> Result<Value> {
    let v: Value = serde_json::from_slice(body).map_err(|e| error(format!("invalid JSON: {e}")))?;
    parse_body(source, &v)?.body(target)
}

#[derive(Debug)]
enum Delta {
    Start,
    Text(String),
    ToolStart(usize),
    ToolArgs(usize, String),
    Done,
}

/// Stateful SSE translator. A translator is single-use; a failed push must not be retried.
pub struct StreamTranslator {
    source: Protocol,
    target: Protocol,
    buffer: Vec<u8>,
    state: State,
    started: bool,
    completed: bool,
    terminal: bool,
    failed: bool,
    blocks: BTreeMap<usize, usize>,
    text_block: Option<usize>,
    next_block: usize,
}
impl StreamTranslator {
    pub fn new(source: Protocol, target: Protocol) -> Self {
        Self {
            source,
            target,
            buffer: Vec::new(),
            state: State::default(),
            started: false,
            completed: false,
            terminal: false,
            failed: false,
            blocks: BTreeMap::new(),
            text_block: None,
            next_block: 0,
        }
    }
    /// Feed any number of bytes; each returned string is a complete SSE frame.
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<String>> {
        if self.failed {
            return Err(error("translator already failed"));
        }
        self.buffer.extend_from_slice(bytes);
        let result = self.consume();
        if result.is_err() {
            self.failed = true;
        }
        result
    }
    /// Return the accumulated response after a completed stream.
    pub fn body(&self) -> Result<Value> {
        if !self.terminal {
            return Err(error("stream is not complete"));
        }
        self.state.body(self.target)
    }
    /// Signal EOF. Incomplete frames or missing terminal events are errors.
    pub fn finish(&mut self) -> Result<Vec<String>> {
        if self.failed {
            return Err(error("translator already failed"));
        }
        let result = (|| {
            let out = self.consume()?;
            if !self.buffer.is_empty() {
                return Err(error("truncated SSE frame"));
            }
            if !self.terminal {
                return Err(error("stream ended without terminal event"));
            }
            Ok(out)
        })();
        if result.is_err() {
            self.failed = true;
        }
        result
    }
    fn consume(&mut self) -> Result<Vec<String>> {
        let mut out = Vec::new();
        while let Some((end, n)) = frame_end(&self.buffer) {
            let frame = self.buffer[..end].to_vec();
            self.buffer.drain(..end + n);
            let text =
                std::str::from_utf8(&frame).map_err(|_| error("invalid UTF-8 in SSE frame"))?;
            let mut event = "";
            let mut data = Vec::new();
            for line in text.lines() {
                let line = line.trim_end_matches('\r');
                if line.starts_with(':') || line.is_empty() {
                    continue;
                }
                let (k, v) = line.split_once(':').unwrap_or((line, ""));
                let v = v.strip_prefix(' ').unwrap_or(v);
                match k {
                    "event" => event = v,
                    "data" => data.push(v),
                    "id" | "retry" => {}
                    _ => return Err(error(format!("unsupported SSE field: {k}"))),
                }
            }
            if data.is_empty() {
                continue;
            }
            let data = data.join("\n");
            if self.terminal && data == "[DONE]" {
                continue;
            }
            if self.terminal {
                return Err(error("event after stream termination"));
            }
            if data == "[DONE]" {
                if self.source != Protocol::Chat || !self.completed {
                    return Err(error("unexpected [DONE]"));
                }
                self.terminal = true;
                self.emit(Delta::Done, &mut out)?;
                continue;
            }
            let v: Value =
                serde_json::from_str(&data).map_err(|e| error(format!("invalid SSE JSON: {e}")))?;
            let deltas = self.decode(event, &v)?;
            for d in deltas {
                self.emit(d, &mut out)?;
            }
        }
        Ok(out)
    }
    fn decode(&mut self, event: &str, v: &Value) -> Result<Vec<Delta>> {
        if v.get("error").is_some() || event == "error" || string(v, "type") == "error" {
            return Err(error(format!(
                "upstream error: {}",
                v.get("error").unwrap_or(v)
            )));
        }
        let mut d = Vec::new();
        match self.source {
            Protocol::Chat => {
                if self.completed
                    && !v
                        .get("choices")
                        .and_then(Value::as_array)
                        .is_some_and(Vec::is_empty)
                {
                    return Err(error("chat data after finish"));
                }
                if let Some(id) = v.get("id").and_then(Value::as_str) {
                    self.state.id = id.into();
                }
                if let Some(m) = v.get("model").and_then(Value::as_str) {
                    self.state.model = m.into();
                }
                if !self.started {
                    self.started = true;
                    d.push(Delta::Start);
                }
                if let Some(u) = v.get("usage") {
                    self.state.usage(u, Protocol::Chat);
                }
                let choices = v
                    .get("choices")
                    .and_then(Value::as_array)
                    .ok_or_else(|| error("missing choices"))?;
                if choices.len() > 1 {
                    return Err(error("only one chat choice is supported"));
                }
                if let Some(c) = choices.first() {
                    if c.get("index").and_then(Value::as_u64).unwrap_or(0) != 0 {
                        return Err(error("unsupported chat choice index"));
                    }
                    let delta = c.get("delta").ok_or_else(|| error("missing delta"))?;
                    if delta.get("refusal").is_some_and(|x| !x.is_null())
                        || delta.get("function_call").is_some()
                    {
                        return Err(error("unsupported chat delta"));
                    }
                    if let Some(x) = delta.get("content") {
                        if let Some(t) = x.as_str() {
                            self.state.text.push_str(t);
                            d.push(Delta::Text(t.into()));
                        } else if !x.is_null() {
                            return Err(error("unsupported chat content delta"));
                        }
                    }
                    if let Some(ts) = delta.get("tool_calls") {
                        for t in ts.as_array().ok_or_else(|| error("invalid tool_calls"))? {
                            let i = t
                                .get("index")
                                .and_then(Value::as_u64)
                                .ok_or_else(|| error("missing tool index"))?
                                as usize;
                            if t.get("type")
                                .is_some_and(|x| x.as_str() != Some("function"))
                            {
                                return Err(error("unsupported tool type"));
                            }
                            let tool = self.state.tools.entry(i).or_default();
                            if let Some(id) = t.get("id").and_then(Value::as_str) {
                                tool.id.push_str(id);
                            }
                            let f = t.get("function").unwrap_or(&Value::Null);
                            if let Some(name) = f.get("name").and_then(Value::as_str) {
                                tool.name.push_str(name);
                            }
                            if !self.blocks.contains_key(&i)
                                && !tool.id.is_empty()
                                && !tool.name.is_empty()
                            {
                                d.push(Delta::ToolStart(i));
                                self.blocks.insert(i, usize::MAX);
                            }
                            if let Some(a) = f.get("arguments").and_then(Value::as_str) {
                                tool.args.push_str(a);
                                d.push(Delta::ToolArgs(i, a.into()));
                            }
                        }
                    }
                    if let Some(r) = c.get("finish_reason").and_then(Value::as_str) {
                        self.state.reason = Some(r.into());
                        self.completed = true;
                    }
                }
            }
            Protocol::Messages => {
                let typ = string(v, "type");
                if !event.is_empty() && event != typ {
                    return Err(error("SSE event/type mismatch"));
                }
                match typ {
                    "ping" => {}
                    "message_start" => {
                        if self.started {
                            return Err(error("duplicate message_start"));
                        }
                        let m = v.get("message").ok_or_else(|| error("missing message"))?;
                        self.state.id = required(m, "id")?.into();
                        self.state.model = required(m, "model")?.into();
                        if let Some(u) = m.get("usage") {
                            self.state.usage(u, Protocol::Messages);
                        }
                        self.started = true;
                        d.push(Delta::Start);
                    }
                    "content_block_start" => {
                        let i = index(v)?;
                        let b = v
                            .get("content_block")
                            .ok_or_else(|| error("missing content block"))?;
                        match string(b, "type") {
                            "text" => {
                                let t = string(b, "text");
                                if !t.is_empty() {
                                    self.state.text.push_str(t);
                                    d.push(Delta::Text(t.into()));
                                }
                            }
                            "tool_use" => {
                                let args = match b.get("input") {
                                    None | Some(Value::Null) => String::new(),
                                    Some(x) if x == &json!({}) => String::new(),
                                    Some(x) => x.to_string(),
                                };
                                self.state.tools.insert(
                                    i,
                                    Tool {
                                        id: required(b, "id")?.into(),
                                        name: required(b, "name")?.into(),
                                        args: args.clone(),
                                    },
                                );
                                d.push(Delta::ToolStart(i));
                                if !args.is_empty() {
                                    d.push(Delta::ToolArgs(i, args));
                                }
                            }
                            "thinking" | "redacted_thinking" => {}
                            t => return Err(error(format!("unsupported messages block: {t}"))),
                        }
                    }
                    "content_block_delta" => {
                        let i = index(v)?;
                        let x = v.get("delta").ok_or_else(|| error("missing block delta"))?;
                        match string(x, "type") {
                            "text_delta" => {
                                let t = required(x, "text")?;
                                self.state.text.push_str(t);
                                d.push(Delta::Text(t.into()));
                            }
                            "input_json_delta" => {
                                let a = required(x, "partial_json")?;
                                self.state
                                    .tools
                                    .get_mut(&i)
                                    .ok_or_else(|| error("unknown tool block"))?
                                    .args
                                    .push_str(a);
                                d.push(Delta::ToolArgs(i, a.into()));
                            }
                            "thinking_delta" | "signature_delta" | "citations_delta" => {}
                            t => return Err(error(format!("unsupported messages delta: {t}"))),
                        }
                    }
                    "content_block_stop" => {}
                    "message_delta" => {
                        let x = v
                            .get("delta")
                            .ok_or_else(|| error("missing message delta"))?;
                        self.state.reason = x
                            .get("stop_reason")
                            .and_then(Value::as_str)
                            .map(str::to_owned);
                        if let Some(u) = v.get("usage") {
                            self.state.usage(u, Protocol::Messages);
                        }
                    }
                    "message_stop" => {
                        self.completed = true;
                        self.terminal = true;
                        d.push(Delta::Done);
                    }
                    t => return Err(error(format!("unsupported messages event: {t}"))),
                }
            }
            Protocol::Responses => {
                let typ = string(v, "type");
                if !event.is_empty() && event != typ {
                    return Err(error("SSE event/type mismatch"));
                }
                match typ {
                    "response.created" => {
                        if self.started {
                            return Err(error("duplicate response.created"));
                        }
                        let r = v.get("response").ok_or_else(|| error("missing response"))?;
                        self.state.id = required(r, "id")?.into();
                        self.state.model = required(r, "model")?.into();
                        self.started = true;
                        d.push(Delta::Start);
                    }
                    "response.in_progress"
                    | "response.output_text.done"
                    | "response.function_call_arguments.done" => {}
                    // Reasoning is upstream-internal metadata with no representation in
                    // the other protocols. It is skipped (not fabricated) so the main
                    // text/tool/usage path of reasoning models still converts.
                    "response.reasoning_summary_part.added"
                    | "response.reasoning_summary_part.done"
                    | "response.reasoning_summary_text.delta"
                    | "response.reasoning_summary_text.done"
                    | "response.reasoning_text.delta"
                    | "response.reasoning_text.done" => {}
                    "response.content_part.added" | "response.content_part.done" => {
                        let part = v.get("part").ok_or_else(|| error("missing content part"))?;
                        if string(part, "type") == "reasoning_text" {
                            return Ok(d);
                        }
                        if string(part, "type") != "output_text"
                            || part
                                .get("annotations")
                                .and_then(Value::as_array)
                                .is_some_and(|a| !a.is_empty())
                        {
                            return Err(error("unsupported responses content part"));
                        }
                    }
                    "response.output_item.done" => {
                        let item = v
                            .get("item")
                            .ok_or_else(|| error("missing completed item"))?;
                        if !matches!(
                            string(item, "type"),
                            "message" | "function_call" | "reasoning"
                        ) {
                            return Err(error("unsupported completed item"));
                        }
                    }
                    "response.output_item.added" => {
                        let i = index_field(v, "output_index")?;
                        let item = v.get("item").ok_or_else(|| error("missing item"))?;
                        match string(item, "type") {
                            "message" | "reasoning" => {}
                            "function_call" => {
                                self.state.tools.insert(
                                    i,
                                    Tool {
                                        id: required(item, "call_id")?.into(),
                                        name: required(item, "name")?.into(),
                                        args: String::new(),
                                    },
                                );
                                d.push(Delta::ToolStart(i));
                            }
                            t => return Err(error(format!("unsupported responses item: {t}"))),
                        }
                    }
                    "response.output_text.delta" => {
                        let t = required(v, "delta")?;
                        self.state.text.push_str(t);
                        d.push(Delta::Text(t.into()));
                    }
                    "response.function_call_arguments.delta" => {
                        let i = index_field(v, "output_index")?;
                        let a = required(v, "delta")?;
                        self.state
                            .tools
                            .get_mut(&i)
                            .ok_or_else(|| error("unknown function call"))?
                            .args
                            .push_str(a);
                        d.push(Delta::ToolArgs(i, a.into()));
                    }
                    "response.completed" | "response.incomplete" => {
                        let r = v.get("response").ok_or_else(|| error("missing response"))?;
                        if let Some(u) = r.get("usage") {
                            self.state.usage(u, Protocol::Responses);
                        }
                        if typ == "response.incomplete" {
                            self.state.reason = Some("max_output_tokens".into());
                        }
                        self.completed = true;
                        self.terminal = true;
                        d.push(Delta::Done);
                    }
                    t => return Err(error(format!("unsupported responses event: {t}"))),
                }
            }
        }
        Ok(d)
    }
    fn emit(&mut self, delta: Delta, out: &mut Vec<String>) -> Result<()> {
        let s = &self.state;
        match (self.target,delta) {
            (Protocol::Chat,Delta::Start) => out.push(sse(None,json!({"id":s.id,"object":"chat.completion.chunk","model":s.model,"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}))),
            (Protocol::Chat,Delta::Text(t)) => out.push(sse(None,json!({"id":s.id,"object":"chat.completion.chunk","model":s.model,"choices":[{"index":0,"delta":{"content":t},"finish_reason":null}]}))),
            (Protocol::Chat,Delta::ToolStart(i)) => { let j=self.next_block; self.next_block+=1; self.blocks.insert(i,j); let t=&s.tools[&i]; out.push(sse(None,json!({"id":s.id,"object":"chat.completion.chunk","model":s.model,"choices":[{"index":0,"delta":{"tool_calls":[{"index":j,"id":t.id,"type":"function","function":{"name":t.name,"arguments":""}}]},"finish_reason":null}]}))); },
            (Protocol::Chat,Delta::ToolArgs(i,a)) => { let j=*self.blocks.get(&i).filter(|x|**x!=usize::MAX).ok_or_else(||error("tool arguments before tool identity"))?; out.push(sse(None,json!({"id":s.id,"object":"chat.completion.chunk","model":s.model,"choices":[{"index":0,"delta":{"tool_calls":[{"index":j,"function":{"arguments":a}}]},"finish_reason":null}]}))); },
            (Protocol::Chat,Delta::Done) => {out.push(sse(None,json!({"id":s.id,"object":"chat.completion.chunk","model":s.model,"choices":[{"index":0,"delta":{},"finish_reason":s.reason(Protocol::Chat)}],"usage":s.usage_json(Protocol::Chat)})));out.push("data: [DONE]\n\n".into());},
            (Protocol::Messages,Delta::Start) => out.push(sse(Some("message_start"),json!({"type":"message_start","message":{"id":s.id,"type":"message","role":"assistant","model":s.model,"content":[],"stop_reason":null,"stop_sequence":null,"usage":s.usage_json(Protocol::Messages)}}))),
            (Protocol::Messages,Delta::Text(t)) => { let i=match self.text_block {Some(i)=>i,None=>{let i=self.next_block;self.next_block+=1;self.text_block=Some(i);out.push(sse(Some("content_block_start"),json!({"type":"content_block_start","index":i,"content_block":{"type":"text","text":""}})));i}};out.push(sse(Some("content_block_delta"),json!({"type":"content_block_delta","index":i,"delta":{"type":"text_delta","text":t}}))); },
            (Protocol::Messages,Delta::ToolStart(i)) => {let j=self.next_block;self.next_block+=1;self.blocks.insert(i,j);let t=&s.tools[&i];out.push(sse(Some("content_block_start"),json!({"type":"content_block_start","index":j,"content_block":{"type":"tool_use","id":t.id,"name":t.name,"input":{}}})));},
            (Protocol::Messages,Delta::ToolArgs(i,a)) => {let j=*self.blocks.get(&i).filter(|x|**x!=usize::MAX).ok_or_else(||error("tool arguments before tool identity"))?;out.push(sse(Some("content_block_delta"),json!({"type":"content_block_delta","index":j,"delta":{"type":"input_json_delta","partial_json":a}})));},
            (Protocol::Messages,Delta::Done) => {for i in 0..self.next_block {out.push(sse(Some("content_block_stop"),json!({"type":"content_block_stop","index":i})));}out.push(sse(Some("message_delta"),json!({"type":"message_delta","delta":{"stop_reason":s.reason(Protocol::Messages),"stop_sequence":null},"usage":{"output_tokens":s.output.unwrap_or(0)}})));out.push(sse(Some("message_stop"),json!({"type":"message_stop"})));},
            (Protocol::Responses,Delta::Start) => out.push(sse(Some("response.created"),json!({"type":"response.created","response":{"id":s.id,"object":"response","model":s.model,"status":"in_progress","output":[]}}))),
            (Protocol::Responses,Delta::Text(t)) => {let i=match self.text_block {Some(i)=>i,None=>{let i=self.next_block;self.next_block+=1;self.text_block=Some(i);out.push(sse(Some("response.output_item.added"),json!({"type":"response.output_item.added","output_index":i,"item":{"id":format!("msg_{}",s.id),"type":"message","role":"assistant","status":"in_progress","content":[]}})));out.push(sse(Some("response.content_part.added"),json!({"type":"response.content_part.added","output_index":i,"content_index":0,"item_id":format!("msg_{}",s.id),"part":{"type":"output_text","text":"","annotations":[]}})));i}};out.push(sse(Some("response.output_text.delta"),json!({"type":"response.output_text.delta","output_index":i,"content_index":0,"item_id":format!("msg_{}",s.id),"delta":t})));},
            (Protocol::Responses,Delta::ToolStart(i)) => {let j=self.next_block;self.next_block+=1;self.blocks.insert(i,j);let t=&s.tools[&i];out.push(sse(Some("response.output_item.added"),json!({"type":"response.output_item.added","output_index":j,"item":{"id":t.id,"type":"function_call","call_id":t.id,"name":t.name,"arguments":"","status":"in_progress"}})));},
            (Protocol::Responses,Delta::ToolArgs(i,a)) => {let j=*self.blocks.get(&i).filter(|x|**x!=usize::MAX).ok_or_else(||error("tool arguments before tool identity"))?;out.push(sse(Some("response.function_call_arguments.delta"),json!({"type":"response.function_call_arguments.delta","output_index":j,"item_id":s.tools[&i].id,"delta":a})));},
            (Protocol::Responses,Delta::Done) => {let body=s.body(Protocol::Responses)?; let typ=if s.reason(Protocol::Responses)=="incomplete" {"response.incomplete"}else{"response.completed"};out.push(sse(Some(typ),json!({"type":typ,"response":body})));}
        }
        Ok(())
    }
}
fn index(v: &Value) -> Result<usize> {
    index_field(v, "index")
}
fn index_field(v: &Value, k: &str) -> Result<usize> {
    v.get(k)
        .and_then(Value::as_u64)
        .and_then(|n| usize::try_from(n).ok())
        .ok_or_else(|| error(format!("missing {k}")))
}
fn sse(event: Option<&str>, v: Value) -> String {
    match event {
        Some(e) => format!("event: {e}\ndata: {v}\n\n"),
        None => format!("data: {v}\n\n"),
    }
}
fn frame_end(b: &[u8]) -> Option<(usize, usize)> {
    for i in 0..b.len() {
        if b[i..].starts_with(b"\n\n") {
            return Some((i, 2));
        }
        if b[i..].starts_with(b"\r\n\r\n") {
            return Some((i, 4));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nonstream_tool_and_usage() {
        let v = json!({"id":"x","model":"m","choices":[{"message":{"role":"assistant","content":"hello","tool_calls":[{"id":"c","type":"function","function":{"name":"f","arguments":"{\"x\":1}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":4}});
        let m = collect(Protocol::Chat, Protocol::Messages, v.to_string().as_bytes()).unwrap();
        assert_eq!(m["content"][1]["input"]["x"], 1);
        assert_eq!(m["usage"]["output_tokens"], 4);
        assert_eq!(m["stop_reason"], "tool_use");
        let r = collect(
            Protocol::Messages,
            Protocol::Responses,
            m.to_string().as_bytes(),
        )
        .unwrap();
        assert_eq!(r["output"][1]["call_id"], "c");
    }
    #[test]
    fn arbitrary_boundaries_and_usage() {
        let input=concat!("data: {\"id\":\"a\",\"model\":\"m\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hé\"},\"finish_reason\":null}]}\r\n\r\n", "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n", "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":1}}\n\n", "data: [DONE]\n\n");
        let mut t = StreamTranslator::new(Protocol::Chat, Protocol::Messages);
        let mut out = Vec::new();
        for b in input.as_bytes() {
            out.extend(t.push(&[*b]).unwrap());
        }
        out.extend(t.finish().unwrap());
        let text = out.join("");
        assert!(text.contains("hé"));
        assert!(text.contains("message_stop"));
        assert!(text.contains("output_tokens\":1"));
    }
    #[test]
    fn rejects_unknown_and_truncated() {
        let mut t = StreamTranslator::new(Protocol::Messages, Protocol::Chat);
        assert!(t
            .push(b"event: mystery\ndata: {\"type\":\"mystery\"}\n\n")
            .is_err());
        let mut t = StreamTranslator::new(Protocol::Chat, Protocol::Chat);
        t.push(b"data: {").unwrap();
        assert!(t.finish().is_err());
    }
}
