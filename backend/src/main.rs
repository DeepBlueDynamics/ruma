use std::{
    collections::VecDeque,
    env,
    net::SocketAddr,
    sync::{Arc, atomic::{AtomicU64, Ordering}},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    body::Bytes,
    extract::{Path, RawQuery, State, WebSocketUpgrade, ws::{Message, WebSocket}},
    http::{HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{any, get},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use tokio::sync::{RwLock, broadcast, watch};
use tower_http::{cors::CorsLayer, services::ServeDir, trace::TraceLayer};

/// The Hyperia sidecar this control centre federates with.
///
/// In development Vite proxied `/hyperia-api` to the sidecar, so the browser
/// only ever spoke same-origin. Production served `frontend/dist` straight from
/// this server with no equivalent route, so every `/hyperia-api/*` call 404'd
/// and the client reported HYPERIA OFFLINE while the sidecar was perfectly
/// healthy. This makes the proxy a first-class part of the server instead of a
/// dev-only convenience.
#[derive(Clone)]
struct Hyperia {
    base: String,
    token: Option<String>,
    client: reqwest::Client,
}

impl Hyperia {
    fn from_env() -> Self {
        // `localhost` is deliberately not the default: when this server runs in
        // a container the sidecar lives on the host gateway, and assuming
        // loopback is the single most repeated mistake in this project.
        let base = env::var("HYPERIA_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:9800".to_string())
            .trim_end_matches('/')
            .trim_end_matches("/mcp")
            .to_string();
        Self {
            base,
            token: env::var("HYPERIA_AGENT_TOKEN").ok().filter(|value| !value.is_empty()),
            client: reqwest::Client::new(),
        }
    }

    fn authorize(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.token {
            Some(token) => request.bearer_auth(token),
            None => request,
        }
    }

    /// Ask Hyperia to open this control centre as a web pane. This is the whole
    /// of the "add-on" integration: the server announces itself to the host
    /// workspace rather than expecting somebody to open a browser tab.
    async fn open_pane(&self, url: &str) -> Result<(), String> {
        let payload = serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": { "name": "open_web_pane", "arguments": { "url": url } },
        });
        // Serialised by hand rather than via reqwest's `json` feature: this
        // client is deliberately built with default-features off, so the only
        // thing that feature would add here is a second JSON implementation.
        let body = serde_json::to_string(&payload).expect("serialize server-owned payload");
        let request = self
            .client
            .post(format!("{}/mcp", self.base))
            .header(header::ACCEPT, "application/json, text/event-stream")
            .header(header::CONTENT_TYPE, "application/json")
            .body(body);
        let response = self.authorize(request).send().await.map_err(|error| error.to_string())?;
        if response.status().is_success() { Ok(()) } else { Err(format!("status {}", response.status())) }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Satellite {
    id: &'static str,
    name: &'static str,
    mode: &'static str,
    eb_no: f32,
    snr: f32,
    agc: f32,
    data_rate_kbps: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    sequence: u64,
    elapsed_seconds: f64,
    satellites: Vec<Satellite>,
}

struct AppState {
    latest: watch::Receiver<Snapshot>,
    stream: broadcast::Sender<Snapshot>,
    hyperia: Hyperia,
    client_logs: RwLock<VecDeque<StoredClientLog>>,
    client_log_sequence: AtomicU64,
    desk_heights: RwLock<std::collections::HashMap<String, f32>>,
    control: broadcast::Sender<ControlCommand>,
}

/// Standing-desk travel. The scene clamps authoritatively against the authored
/// `Desk_Height_Pivot`; this is a server-side sanity bound so a bad tool call
/// cannot ask for a desk two metres tall.
const DESK_HEIGHT_MIN: f32 = 0.65;
const DESK_HEIGHT_MAX: f32 = 1.25;

/// Commands pushed to every connected room client.
///
/// A height endpoint is useless on its own: this server serves `frontend/dist`
/// but has no way to reach the running scene. This is that channel - the piece
/// any MCP tool ultimately calls through.
#[derive(Clone, Serialize)]
#[serde(tag = "t", rename_all = "camelCase")]
enum ControlCommand {
    #[serde(rename_all = "camelCase")]
    DeskHeight { desk_id: String, metres: f32 },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeskHeightInput {
    desk_id: String,
    metres: f32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeskHeightState {
    heights: std::collections::HashMap<String, f32>,
    min: f32,
    max: f32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VersionInfo {
    name: &'static str,
    version: &'static str,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientLogInput {
    level: String,
    message: String,
    stack: Option<String>,
    source: Option<String>,
    timestamp: Option<String>,
    url: Option<String>,
}

#[derive(Deserialize)]
struct ClientLogBatch {
    logs: Vec<ClientLogInput>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredClientLog {
    sequence: u64,
    received_at_ms: u64,
    level: String,
    message: String,
    stack: Option<String>,
    source: Option<String>,
    timestamp: Option<String>,
    url: Option<String>,
}

#[derive(Serialize)]
struct ClientLogSnapshot {
    logs: Vec<StoredClientLog>,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let initial = snapshot(0);
    let (latest_tx, latest_rx) = watch::channel(initial);
    let (stream_tx, _) = broadcast::channel(64);
    let hyperia = Hyperia::from_env();
    let state = Arc::new(AppState {
        latest: latest_rx,
        stream: stream_tx.clone(),
        hyperia: hyperia.clone(),
        client_logs: RwLock::new(VecDeque::with_capacity(512)),
        client_log_sequence: AtomicU64::new(0),
        desk_heights: RwLock::new(std::collections::HashMap::new()),
        control: broadcast::channel(64).0,
    });

    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(250));
        let mut sequence = 0;
        loop {
            tick.tick().await;
            sequence += 1;
            let next = snapshot(sequence);
            latest_tx.send_replace(next.clone());
            let _ = stream_tx.send(next);
        }
    });

    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/version", get(version))
        .route("/api/client-logs", get(recent_client_logs).post(record_client_logs))
        .route("/api/v1/snapshot", get(current_snapshot))
        .route("/ws/v1/simulation", get(simulation_socket))
        .route("/api/v1/desk-height", get(desk_heights).post(set_desk_height))
        .route("/ws/v1/control", get(control_socket))
        .route("/hyperia-api/{*path}", any(hyperia_api_proxy))
        .fallback_service(ServeDir::new("frontend/dist").append_index_html_on_directories(true))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let port: u16 = env::var("OPS_ROOM_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(8080);
    let address = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(address).await.expect("bind server");
    tracing::info!(%address, hyperia = %hyperia.base, "operations command centre ready");

    // Single-command launch: bring the pane up ourselves once the socket is
    // accepting, so `cargo run -p ops-room-server -- --open` is the whole
    // ceremony. Opening is best-effort - a headless or scripted run must not
    // fail because no Hyperia is listening.
    let open_pane = env::args().any(|argument| argument == "--open")
        || env::var("OPS_ROOM_OPEN_PANE").is_ok_and(|value| value == "1");
    if open_pane {
        let url = env::var("OPS_ROOM_PANE_URL").unwrap_or_else(|_| format!("http://localhost:{port}"));
        tokio::spawn(async move {
            match hyperia.open_pane(&url).await {
                Ok(()) => tracing::info!(%url, "opened control centre pane in Hyperia"),
                Err(error) => tracing::warn!(%url, %error, "could not open Hyperia pane; open it manually"),
            }
        });
    }

    axum::serve(listener, app).with_graceful_shutdown(shutdown()).await.expect("serve");
}

async fn desk_heights(State(state): State<Arc<AppState>>) -> Json<DeskHeightState> {
    Json(DeskHeightState {
        heights: state.desk_heights.read().await.clone(),
        min: DESK_HEIGHT_MIN,
        max: DESK_HEIGHT_MAX,
    })
}

async fn set_desk_height(
    State(state): State<Arc<AppState>>,
    Json(input): Json<DeskHeightInput>,
) -> Response {
    if input.desk_id.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "deskId required").into_response();
    }
    if !input.metres.is_finite() {
        return (StatusCode::BAD_REQUEST, "metres must be a number").into_response();
    }
    let metres = input.metres.clamp(DESK_HEIGHT_MIN, DESK_HEIGHT_MAX);
    state.desk_heights.write().await.insert(input.desk_id.clone(), metres);
    // Ignore the send error: no connected room client is normal, and the value
    // is retained so the next client to attach picks it up from the snapshot.
    let _ = state.control.send(ControlCommand::DeskHeight { desk_id: input.desk_id.clone(), metres });
    Json(serde_json::json!({ "deskId": input.desk_id, "metres": metres, "clamped": metres != input.metres })).into_response()
}

async fn control_socket(ws: WebSocketUpgrade, State(state): State<Arc<AppState>>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| stream_control(socket, state))
}

/// Control channel to the running room. Sends the retained state on connect so
/// a reloaded client is immediately consistent, then streams live commands.
async fn stream_control(mut socket: WebSocket, state: Arc<AppState>) {
    let mut updates = state.control.subscribe();
    let snapshot: Vec<ControlCommand> = state
        .desk_heights
        .read()
        .await
        .iter()
        .map(|(desk_id, metres)| ControlCommand::DeskHeight { desk_id: desk_id.clone(), metres: *metres })
        .collect();
    for command in snapshot {
        if send_json(&mut socket, &command).await.is_err() { return; }
    }
    loop {
        match updates.recv().await {
            Ok(command) => { if send_json(&mut socket, &command).await.is_err() { break; } }
            // A lagging control client can safely skip: commands are idempotent
            // state assignments, not deltas, so the next one is still correct.
            Err(broadcast::error::RecvError::Lagged(_)) => continue,
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
}

/// Same-origin bridge to the Hyperia sidecar: `/hyperia-api/status` becomes
/// `{HYPERIA_URL}/api/status`, matching the rewrite Vite performed in dev so the
/// client behaves identically in both modes.
async fn hyperia_api_proxy(
    State(state): State<Arc<AppState>>,
    method: Method,
    Path(path): Path<String>,
    RawQuery(query): RawQuery,
    body: Bytes,
) -> Response {
    let hyperia = &state.hyperia;
    let mut url = format!("{}/api/{}", hyperia.base, path);
    if let Some(query) = query.filter(|value| !value.is_empty()) {
        url.push('?');
        url.push_str(&query);
    }
    let request = hyperia.client.request(method, &url).body(body);
    let upstream = match hyperia.authorize(request).send().await {
        Ok(response) => response,
        // Report the sidecar being down as a gateway error rather than a 404,
        // so "Hyperia is offline" stays distinguishable from "route missing".
        Err(error) => {
            tracing::warn!(%url, %error, "hyperia upstream unreachable");
            return (StatusCode::BAD_GATEWAY, format!("hyperia unreachable: {error}")).into_response();
        }
    };
    let status = upstream.status();
    let content_type = upstream.headers().get(header::CONTENT_TYPE).cloned();
    match upstream.bytes().await {
        Ok(bytes) => {
            let mut response = (status, bytes).into_response();
            let value = content_type.unwrap_or(HeaderValue::from_static("application/json"));
            response.headers_mut().insert(header::CONTENT_TYPE, value);
            response
        }
        Err(error) => (StatusCode::BAD_GATEWAY, format!("hyperia body error: {error}")).into_response(),
    }
}

async fn health() -> &'static str { "ok" }

async fn version() -> Json<VersionInfo> {
    Json(VersionInfo { name: env!("CARGO_PKG_NAME"), version: env!("CARGO_PKG_VERSION") })
}

async fn recent_client_logs(State(state): State<Arc<AppState>>) -> Json<ClientLogSnapshot> {
    let logs = state.client_logs.read().await.iter().cloned().collect();
    Json(ClientLogSnapshot { logs })
}

async fn record_client_logs(
    State(state): State<Arc<AppState>>,
    Json(batch): Json<ClientLogBatch>,
) -> StatusCode {
    const MAX_CLIENT_LOGS: usize = 500;
    let received_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let mut stored = state.client_logs.write().await;
    for input in batch.logs.into_iter().take(100) {
        let entry = StoredClientLog {
            sequence: state.client_log_sequence.fetch_add(1, Ordering::Relaxed) + 1,
            received_at_ms,
            level: input.level,
            message: input.message,
            stack: input.stack,
            source: input.source,
            timestamp: input.timestamp,
            url: input.url,
        };
        match entry.level.as_str() {
            "error" => tracing::error!(source = ?entry.source, message = %entry.message, "browser client"),
            "warn" => tracing::warn!(source = ?entry.source, message = %entry.message, "browser client"),
            _ => tracing::info!(source = ?entry.source, message = %entry.message, "browser client"),
        }
        stored.push_back(entry);
        while stored.len() > MAX_CLIENT_LOGS { stored.pop_front(); }
    }
    StatusCode::NO_CONTENT
}

async fn current_snapshot(State(state): State<Arc<AppState>>) -> Json<Snapshot> {
    Json(state.latest.borrow().clone())
}

async fn simulation_socket(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| stream_simulation(socket, state))
}

async fn stream_simulation(mut socket: WebSocket, state: Arc<AppState>) {
    let initial = state.latest.borrow().clone();
    if send_json(&mut socket, &initial).await.is_err() { return; }
    let mut updates = state.stream.subscribe();
    while let Ok(snapshot) = updates.recv().await {
        if send_json(&mut socket, &snapshot).await.is_err() { break; }
    }
}

async fn send_json(socket: &mut WebSocket, value: &impl Serialize) -> Result<(), axum::Error> {
    let text = serde_json::to_string(value).expect("serialize server-owned message");
    socket.send(Message::Text(text.into())).await
}

fn snapshot(sequence: u64) -> Snapshot {
    let t = sequence as f32 * 0.25;
    let signal = |phase: f32| 9.5 + (t * 0.11 + phase).sin() * 1.8;
    Snapshot {
        sequence,
        elapsed_seconds: t as f64,
        satellites: vec![
            Satellite { id: "aster-9k", name: "ASTER-9K", mode: "TRACK", eb_no: signal(0.0), snr: signal(0.0) + 3.1, agc: -48.0, data_rate_kbps: 150 },
            Satellite { id: "meridian-2", name: "MERIDIAN-2", mode: "ACQ", eb_no: signal(2.1), snr: signal(2.1) + 2.8, agc: -51.0, data_rate_kbps: 150 },
            Satellite { id: "relay-7", name: "RELAY-7", mode: "TRACK", eb_no: signal(4.2), snr: signal(4.2) + 3.3, agc: -46.0, data_rate_kbps: 450 },
        ],
    }
}

async fn shutdown() {
    let _ = tokio::signal::ctrl_c().await;
}
