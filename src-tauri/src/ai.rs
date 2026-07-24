//! Built-in AI assistant — a stateless streaming proxy to the configured LLM
//! provider (Anthropic Messages API, or an OpenAI-compatible Chat Completions
//! API). The agentic tool-use loop, approval gating, and tool execution all
//! live in the frontend (`src/ai/`); this module only:
//!   * keeps each provider's API key in the OS keychain (never in the webview),
//!   * translates a provider-neutral request into the provider's wire format,
//!   * streams text deltas to the UI over a `Channel`, and
//!   * returns the finished assistant turn (text + tool_use blocks) as the
//!     authoritative result the frontend appends to its history.
//!
//! v1 deliberately omits extended/adaptive thinking, so an assistant turn is
//! just text + tool_use blocks — no thinking-block replay requirement to model.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use tauri::ipc::Channel;

// ---- Provider-neutral wire types (mirror src/types.ts) ----------------------

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiTool {
    pub name: String,
    pub description: String,
    /// A JSON Schema object describing the tool input.
    pub input_schema: Value,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AiBlock {
    Text {
        text: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    #[serde(rename_all = "camelCase")]
    ToolResult {
        tool_use_id: String,
        content: String,
        #[serde(default)]
        is_error: bool,
    },
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiMessage {
    /// "user" or "assistant". Tool results ride in a "user" message as
    /// `ToolResult` blocks (Anthropic shape); the OpenAI adapter re-splits them
    /// into `role:"tool"` messages.
    pub role: String,
    pub content: Vec<AiBlock>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

/// The finished assistant turn — the authoritative result the frontend appends
/// to history and drives the tool loop from.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiTurn {
    pub content: Vec<AiBlock>,
    pub stop_reason: String,
    pub usage: AiUsage,
}

/// Streamed to the UI during a turn (live typing + a "calling tool" hint). The
/// authoritative content is the returned `AiTurn`; these are display-only.
#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AiEvent {
    TextDelta { text: String },
    ToolUseStart { id: String, name: String },
}

// ---- Keychain-backed key commands -------------------------------------------

/// Save (or, with `None`/empty, clear) a provider's API key in the OS keychain.
/// The user pastes their own key in Settings; it is never returned to the UI.
#[tauri::command]
pub fn ai_key_save(provider: String, key: Option<String>) -> Result<(), String> {
    crate::profiles::set_secret("ai", &provider, "api_key", key.as_deref())
}

/// Whether a non-empty API key is stored for the provider (UI "saved" hint).
#[tauri::command]
pub fn ai_key_exists(provider: String) -> bool {
    matches!(
        crate::profiles::get_secret("ai", &provider, "api_key"),
        Ok(Some(v)) if !v.is_empty()
    )
}

// ---- The streaming completion command ---------------------------------------

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ai_complete(
    provider: String,
    model: String,
    base_url: Option<String>,
    system: Option<String>,
    messages: Vec<AiMessage>,
    tools: Vec<AiTool>,
    max_tokens: Option<u32>,
    on_event: Channel<AiEvent>,
) -> Result<AiTurn, String> {
    let key = crate::profiles::get_secret("ai", &provider, "api_key")
        .ok()
        .flatten()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            format!("No API key saved for '{provider}'. Add it in Settings → AI Assistant.")
        })?;
    let max_tokens = max_tokens.unwrap_or(4096);
    match provider.as_str() {
        "anthropic" => {
            anthropic_complete(&key, &model, system.as_deref(), &messages, &tools, max_tokens, &on_event)
                .await
        }
        "openai" => {
            let base = base_url
                .as_deref()
                .map(|b| b.trim())
                .filter(|b| !b.is_empty())
                .unwrap_or("https://api.openai.com/v1")
                .trim_end_matches('/')
                .to_string();
            openai_complete(&key, &base, &model, system.as_deref(), &messages, &tools, max_tokens, &on_event)
                .await
        }
        other => Err(format!("Unknown AI provider: {other}")),
    }
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("http client: {e}"))
}

/// Char-safe truncation of an error body so a huge HTML/JSON error page doesn't
/// flood the chat.
fn trim_err(s: &str) -> String {
    let t = s.trim();
    let short: String = t.chars().take(600).collect();
    if short.chars().count() < t.chars().count() {
        format!("{short}…")
    } else {
        short
    }
}

/// Splits an SSE byte stream into lines across chunk boundaries. Lines only ever
/// break on `\n`, and a full line is complete UTF-8, so lossy-decoding a whole
/// line can't corrupt a multibyte char split across two network chunks.
#[derive(Default)]
struct SseBuf {
    buf: Vec<u8>,
}

impl SseBuf {
    fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(chunk);
        let mut lines = Vec::new();
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=pos).collect();
            let s = String::from_utf8_lossy(&line);
            lines.push(s.trim_end_matches(['\r', '\n']).to_string());
        }
        lines
    }
}

// ---- Anthropic (Messages API) ----------------------------------------------

async fn anthropic_complete(
    key: &str,
    model: &str,
    system: Option<&str>,
    messages: &[AiMessage],
    tools: &[AiTool],
    max_tokens: u32,
    on_event: &Channel<AiEvent>,
) -> Result<AiTurn, String> {
    let body = build_anthropic_body(model, system, messages, tools, max_tokens);
    let resp = client()?
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Anthropic request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Anthropic {status}: {}", trim_err(&text)));
    }

    let mut acc = Accum::default();
    let mut sse = SseBuf::default();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Anthropic stream error: {e}"))?;
        for line in sse.push(&chunk) {
            if let Some(data) = line.strip_prefix("data:") {
                let data = data.trim();
                if data.is_empty() {
                    continue;
                }
                if let Ok(v) = serde_json::from_str::<Value>(data) {
                    for ev in anthropic_step(&mut acc, &v) {
                        on_event.send(ev).ok();
                    }
                }
            }
        }
    }
    Ok(acc.into_turn())
}

fn build_anthropic_body(
    model: &str,
    system: Option<&str>,
    messages: &[AiMessage],
    tools: &[AiTool],
    max_tokens: u32,
) -> Value {
    let msgs: Vec<Value> = messages
        .iter()
        .map(|m| {
            let content: Vec<Value> = m.content.iter().map(anthropic_block).collect();
            json!({ "role": m.role, "content": content })
        })
        .collect();
    let mut body = json!({
        "model": model,
        "max_tokens": max_tokens,
        "stream": true,
        "messages": msgs,
    });
    if let Some(s) = system {
        if !s.is_empty() {
            body["system"] = json!(s);
        }
    }
    if !tools.is_empty() {
        let tools_json: Vec<Value> = tools
            .iter()
            .map(|t| json!({ "name": t.name, "description": t.description, "input_schema": t.input_schema }))
            .collect();
        body["tools"] = json!(tools_json);
    }
    body
}

fn anthropic_block(b: &AiBlock) -> Value {
    match b {
        AiBlock::Text { text } => json!({ "type": "text", "text": text }),
        AiBlock::ToolUse { id, name, input } => {
            json!({ "type": "tool_use", "id": id, "name": name, "input": input })
        }
        AiBlock::ToolResult {
            tool_use_id,
            content,
            is_error,
        } => json!({
            "type": "tool_result",
            "tool_use_id": tool_use_id,
            "content": content,
            "is_error": is_error,
        }),
    }
}

/// One Anthropic SSE event → accumulator mutation + any display events to emit.
fn anthropic_step(acc: &mut Accum, v: &Value) -> Vec<AiEvent> {
    let mut out = Vec::new();
    match v["type"].as_str() {
        Some("message_start") => {
            if let Some(u) = v["message"]["usage"]["input_tokens"].as_u64() {
                acc.usage.input_tokens = u;
            }
        }
        Some("content_block_start") => {
            let idx = v["index"].as_u64().unwrap_or(0) as usize;
            let cb = &v["content_block"];
            match cb["type"].as_str() {
                Some("text") => {
                    acc.blocks.insert(idx, BlockAcc::text());
                }
                Some("tool_use") => {
                    let id = cb["id"].as_str().unwrap_or("").to_string();
                    let name = cb["name"].as_str().unwrap_or("").to_string();
                    out.push(AiEvent::ToolUseStart {
                        id: id.clone(),
                        name: name.clone(),
                    });
                    acc.blocks.insert(idx, BlockAcc::tool(id, name));
                }
                _ => {}
            }
        }
        Some("content_block_delta") => {
            let idx = v["index"].as_u64().unwrap_or(0) as usize;
            let d = &v["delta"];
            match d["type"].as_str() {
                Some("text_delta") => {
                    if let Some(t) = d["text"].as_str() {
                        if let Some(b) = acc.blocks.get_mut(&idx) {
                            b.text.push_str(t);
                        }
                        out.push(AiEvent::TextDelta { text: t.to_string() });
                    }
                }
                Some("input_json_delta") => {
                    if let Some(pj) = d["partial_json"].as_str() {
                        if let Some(b) = acc.blocks.get_mut(&idx) {
                            b.json.push_str(pj);
                        }
                    }
                }
                _ => {}
            }
        }
        Some("message_delta") => {
            if let Some(sr) = v["delta"]["stop_reason"].as_str() {
                acc.stop_reason = sr.to_string();
            }
            if let Some(u) = v["usage"]["output_tokens"].as_u64() {
                acc.usage.output_tokens = u;
            }
        }
        _ => {}
    }
    out
}

#[derive(Default)]
struct BlockAcc {
    is_tool: bool,
    id: String,
    name: String,
    text: String,
    json: String,
}

impl BlockAcc {
    fn text() -> Self {
        Self::default()
    }
    fn tool(id: String, name: String) -> Self {
        Self {
            is_tool: true,
            id,
            name,
            ..Default::default()
        }
    }
}

#[derive(Default)]
struct Accum {
    blocks: BTreeMap<usize, BlockAcc>,
    stop_reason: String,
    usage: AiUsage,
}

impl Accum {
    fn into_turn(self) -> AiTurn {
        let mut content = Vec::new();
        for (_i, b) in self.blocks {
            if b.is_tool {
                let input =
                    serde_json::from_str(&b.json).unwrap_or_else(|_| json!({}));
                content.push(AiBlock::ToolUse {
                    id: b.id,
                    name: b.name,
                    input,
                });
            } else if !b.text.is_empty() {
                content.push(AiBlock::Text { text: b.text });
            }
        }
        AiTurn {
            content,
            stop_reason: if self.stop_reason.is_empty() {
                "end_turn".into()
            } else {
                self.stop_reason
            },
            usage: self.usage,
        }
    }
}

// ---- OpenAI-compatible (Chat Completions) ----------------------------------

async fn openai_complete(
    key: &str,
    base: &str,
    model: &str,
    system: Option<&str>,
    messages: &[AiMessage],
    tools: &[AiTool],
    max_tokens: u32,
    on_event: &Channel<AiEvent>,
) -> Result<AiTurn, String> {
    let body = build_openai_body(model, system, messages, tools, max_tokens);
    let resp = client()?
        .post(format!("{base}/chat/completions"))
        .bearer_auth(key)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("OpenAI request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("OpenAI {status}: {}", trim_err(&text)));
    }

    let mut acc = OaAccum::default();
    let mut sse = SseBuf::default();
    let mut stream = resp.bytes_stream();
    'outer: while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("OpenAI stream error: {e}"))?;
        for line in sse.push(&chunk) {
            if let Some(data) = line.strip_prefix("data:") {
                let data = data.trim();
                if data.is_empty() {
                    continue;
                }
                if data == "[DONE]" {
                    break 'outer;
                }
                if let Ok(v) = serde_json::from_str::<Value>(data) {
                    for ev in openai_step(&mut acc, &v) {
                        on_event.send(ev).ok();
                    }
                }
            }
        }
    }
    Ok(acc.into_turn())
}

fn build_openai_body(
    model: &str,
    system: Option<&str>,
    messages: &[AiMessage],
    tools: &[AiTool],
    max_tokens: u32,
) -> Value {
    let mut msgs: Vec<Value> = Vec::new();
    if let Some(s) = system {
        if !s.is_empty() {
            msgs.push(json!({ "role": "system", "content": s }));
        }
    }
    for m in messages {
        let mut text = String::new();
        let mut tool_calls: Vec<Value> = Vec::new();
        for b in &m.content {
            match b {
                AiBlock::Text { text: t } => text.push_str(t),
                AiBlock::ToolUse { id, name, input } => tool_calls.push(json!({
                    "id": id,
                    "type": "function",
                    "function": {
                        "name": name,
                        "arguments": serde_json::to_string(input).unwrap_or_else(|_| "{}".into()),
                    },
                })),
                // A tool result becomes its own `role:"tool"` message, in order,
                // right after the assistant turn that requested it.
                AiBlock::ToolResult {
                    tool_use_id,
                    content,
                    ..
                } => msgs.push(json!({
                    "role": "tool",
                    "tool_call_id": tool_use_id,
                    "content": content,
                })),
            }
        }
        if m.role == "assistant" {
            if !text.is_empty() || !tool_calls.is_empty() {
                let mut a = json!({ "role": "assistant" });
                a["content"] = if text.is_empty() { Value::Null } else { json!(text) };
                if !tool_calls.is_empty() {
                    a["tool_calls"] = json!(tool_calls);
                }
                msgs.push(a);
            }
        } else if !text.is_empty() {
            msgs.push(json!({ "role": "user", "content": text }));
        }
    }
    let mut body = json!({
        "model": model,
        "stream": true,
        "stream_options": { "include_usage": true },
        "max_tokens": max_tokens,
        "messages": msgs,
    });
    if !tools.is_empty() {
        let tools_json: Vec<Value> = tools
            .iter()
            .map(|t| json!({
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.input_schema,
                },
            }))
            .collect();
        body["tools"] = json!(tools_json);
        body["tool_choice"] = json!("auto");
    }
    body
}

#[derive(Default)]
struct OaAccum {
    text: String,
    /// index → (id, name, arguments-json-fragment)
    tools: BTreeMap<usize, (String, String, String)>,
    started: HashSet<usize>,
    finish_reason: String,
    usage: AiUsage,
}

impl OaAccum {
    fn into_turn(self) -> AiTurn {
        let mut content = Vec::new();
        if !self.text.is_empty() {
            content.push(AiBlock::Text { text: self.text });
        }
        for (_i, (id, name, args)) in self.tools {
            let input = serde_json::from_str(&args).unwrap_or_else(|_| json!({}));
            content.push(AiBlock::ToolUse { id, name, input });
        }
        let stop_reason = match self.finish_reason.as_str() {
            "tool_calls" => "tool_use",
            "stop" => "end_turn",
            "length" => "max_tokens",
            "" => "end_turn",
            other => other,
        }
        .to_string();
        AiTurn {
            content,
            stop_reason,
            usage: self.usage,
        }
    }
}

/// One OpenAI SSE chunk → accumulator mutation + any display events to emit.
fn openai_step(acc: &mut OaAccum, v: &Value) -> Vec<AiEvent> {
    let mut out = Vec::new();
    if let Some(pt) = v["usage"]["prompt_tokens"].as_u64() {
        acc.usage.input_tokens = pt;
    }
    if let Some(ct) = v["usage"]["completion_tokens"].as_u64() {
        acc.usage.output_tokens = ct;
    }
    let choice = &v["choices"][0];
    if let Some(fr) = choice["finish_reason"].as_str() {
        acc.finish_reason = fr.to_string();
    }
    let d = &choice["delta"];
    if let Some(c) = d["content"].as_str() {
        if !c.is_empty() {
            acc.text.push_str(c);
            out.push(AiEvent::TextDelta { text: c.to_string() });
        }
    }
    if let Some(tcs) = d["tool_calls"].as_array() {
        for tc in tcs {
            let idx = tc["index"].as_u64().unwrap_or(0) as usize;
            let entry = acc.tools.entry(idx).or_default();
            if let Some(id) = tc["id"].as_str() {
                if !id.is_empty() {
                    entry.0 = id.to_string();
                }
            }
            if let Some(n) = tc["function"]["name"].as_str() {
                if !n.is_empty() {
                    entry.1.push_str(n);
                }
            }
            if let Some(a) = tc["function"]["arguments"].as_str() {
                entry.2.push_str(a);
            }
            // Emit a "calling tool" hint once per tool index, when its name is known.
            if !entry.1.is_empty() && acc.started.insert(idx) {
                out.push(AiEvent::ToolUseStart {
                    id: entry.0.clone(),
                    name: entry.1.clone(),
                });
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_msg(role: &str, t: &str) -> AiMessage {
        AiMessage {
            role: role.into(),
            content: vec![AiBlock::Text { text: t.into() }],
        }
    }

    #[test]
    fn sse_splits_across_chunk_boundaries() {
        let mut b = SseBuf::default();
        assert!(b.push(b"data: {\"a\":").is_empty());
        let lines = b.push(b"1}\n\n");
        assert_eq!(lines, vec!["data: {\"a\":1}".to_string(), String::new()]);
    }

    #[test]
    fn anthropic_body_maps_tools_and_system() {
        let tools = vec![AiTool {
            name: "run_command".into(),
            description: "run a shell command".into(),
            input_schema: json!({"type":"object","properties":{"command":{"type":"string"}}}),
        }];
        let body = build_anthropic_body("claude-opus-4-8", Some("be terse"), &[text_msg("user", "hi")], &tools, 4096);
        assert_eq!(body["model"], "claude-opus-4-8");
        assert_eq!(body["stream"], true);
        assert_eq!(body["system"], "be terse");
        assert_eq!(body["tools"][0]["name"], "run_command");
        assert_eq!(body["messages"][0]["content"][0]["type"], "text");
    }

    #[test]
    fn openai_body_splits_tool_result_into_tool_message() {
        let messages = vec![
            text_msg("user", "check disk"),
            AiMessage {
                role: "assistant".into(),
                content: vec![AiBlock::ToolUse {
                    id: "call_1".into(),
                    name: "run_command".into(),
                    input: json!({"command":"df -h"}),
                }],
            },
            AiMessage {
                role: "user".into(),
                content: vec![AiBlock::ToolResult {
                    tool_use_id: "call_1".into(),
                    content: "Filesystem ...".into(),
                    is_error: false,
                }],
            },
        ];
        let body = build_openai_body("gpt-4o", None, &messages, &[], 4096);
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs[0]["role"], "user");
        assert_eq!(msgs[1]["role"], "assistant");
        assert_eq!(msgs[1]["tool_calls"][0]["function"]["name"], "run_command");
        assert_eq!(msgs[2]["role"], "tool");
        assert_eq!(msgs[2]["tool_call_id"], "call_1");
    }

    #[test]
    fn anthropic_stream_assembles_text_and_tool_use() {
        let mut acc = Accum::default();
        let events = [
            json!({"type":"message_start","message":{"usage":{"input_tokens":10}}}),
            json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me check. "}}),
            json!({"type":"content_block_stop","index":0}),
            json!({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"run_command"}}),
            json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"command\":"}}),
            json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\"df -h\"}"}}),
            json!({"type":"content_block_stop","index":1}),
            json!({"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}),
        ];
        let mut deltas = String::new();
        for e in &events {
            for ev in anthropic_step(&mut acc, e) {
                if let AiEvent::TextDelta { text } = ev {
                    deltas.push_str(&text);
                }
            }
        }
        assert_eq!(deltas, "Let me check. ");
        let turn = acc.into_turn();
        assert_eq!(turn.stop_reason, "tool_use");
        assert_eq!(turn.usage.input_tokens, 10);
        assert_eq!(turn.content.len(), 2);
        match &turn.content[1] {
            AiBlock::ToolUse { name, input, .. } => {
                assert_eq!(name, "run_command");
                assert_eq!(input["command"], "df -h");
            }
            _ => panic!("expected tool_use block"),
        }
    }

    #[test]
    fn openai_stream_assembles_tool_call() {
        let mut acc = OaAccum::default();
        let chunks = [
            json!({"choices":[{"delta":{"content":"Checking"},"finish_reason":null}]}),
            json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"run_command","arguments":"{\"comm"}}]},"finish_reason":null}]}),
            json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"and\":\"ls\"}"}}]},"finish_reason":null}]}),
            json!({"choices":[{"delta":{},"finish_reason":"tool_calls"}]}),
            json!({"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":5}}),
        ];
        for c in &chunks {
            openai_step(&mut acc, c);
        }
        let turn = acc.into_turn();
        assert_eq!(turn.stop_reason, "tool_use");
        assert_eq!(turn.usage.input_tokens, 12);
        assert_eq!(turn.content.len(), 2);
        match &turn.content[1] {
            AiBlock::ToolUse { id, name, input } => {
                assert_eq!(id, "call_1");
                assert_eq!(name, "run_command");
                assert_eq!(input["command"], "ls");
            }
            _ => panic!("expected tool_use block"),
        }
    }
}
