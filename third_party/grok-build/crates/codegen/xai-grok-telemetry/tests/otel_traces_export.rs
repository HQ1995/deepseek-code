//! Wire test: a real span must reach the OTLP traces endpoint through the
//! provider `build_otel_layer` installs.
//!
//! The span exporter's blocking HTTP client is built lazily on the first
//! export — on the batch processor's own std thread — instead of inside
//! `init_tracing`, ahead of the first frame, where every launch with export
//! enabled used to pay its ~100ms. This drives the whole path once: span ->
//! batch processor -> deferred client build -> real HTTP POST -> collector.

use std::collections::HashMap;
use std::io::{Read as _, Write as _};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use opentelemetry::trace::{Span as _, Tracer as _};
use prost::Message as _;
use xai_grok_auth::{AuthCredentialProvider, CredentialSnapshot, HttpAuth};
use xai_grok_telemetry::client;
use xai_grok_telemetry::config::{TelemetryConfig, TelemetryMode};
use xai_grok_telemetry::otel_layer::{
    OtelClientInfo, OtelExporterConfig, OtelLayerConfig, build_otel_layer, shutdown_otel,
};

/// One received HTTP request.
#[derive(Clone)]
struct Collected {
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

/// Minimal HTTP/1.1 collector over a plain `TcpListener`: reads each request
/// (head plus `content-length` bytes), answers `200`, and records it. Kept off
/// Tokio on purpose — the exporter's blocking client must never run inside an
/// async executor.
fn start_collector() -> (String, Arc<Mutex<Vec<Collected>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind collector");
    let addr = listener.local_addr().expect("collector addr");
    let received: Arc<Mutex<Vec<Collected>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&received);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let mut raw = Vec::new();
            let mut buf = [0u8; 8192];
            while !request_complete(&raw) {
                match stream.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => raw.extend_from_slice(&buf[..n]),
                    Err(_) => break,
                }
            }
            if let Some(request) = parse_request(&raw) {
                sink.lock().unwrap().push(request);
            }
            let _ = stream
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
            let _ = stream.flush();
        }
    });
    (format!("http://{addr}/v1/traces"), received)
}

fn head_end(raw: &[u8]) -> Option<usize> {
    raw.windows(4).position(|window| window == b"\r\n\r\n")
}

fn request_complete(raw: &[u8]) -> bool {
    let Some(head_end) = head_end(raw) else {
        return false;
    };
    let head = String::from_utf8_lossy(&raw[..head_end]);
    let content_length = head
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            if name.eq_ignore_ascii_case("content-length") {
                value.trim().parse::<usize>().ok()
            } else {
                None
            }
        })
        .unwrap_or(0);
    raw.len() >= head_end + 4 + content_length
}

fn parse_request(raw: &[u8]) -> Option<Collected> {
    let head_end = head_end(raw)?;
    let head = String::from_utf8_lossy(&raw[..head_end]);
    let mut lines = head.lines();
    let path = lines.next()?.split_whitespace().nth(1)?.to_string();
    let mut headers = HashMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    Some(Collected {
        path,
        headers,
        body: raw[head_end + 4..].to_vec(),
    })
}

/// Credentials double: a static bearer token, never refreshed.
struct StaticProvider;

impl HttpAuth for StaticProvider {
    fn apply(&self, builder: reqwest::RequestBuilder, _base_url: &str) -> reqwest::RequestBuilder {
        builder
    }
}

#[async_trait]
impl AuthCredentialProvider for StaticProvider {
    fn snapshot(&self) -> CredentialSnapshot {
        CredentialSnapshot {
            token: Some("wire-test-token".into()),
            ..Default::default()
        }
    }

    async fn refresh_after_unauthorized(&self) -> bool {
        false
    }
}

/// Not `#[tokio::test]`: the batch processor drives exports from its own std
/// thread, and the blocking OTLP client panics when dropped inside an async
/// executor, so the test body stays off Tokio too.
#[test]
fn span_export_reaches_the_endpoint_through_the_deferred_client() {
    let (traces_url, received) = start_collector();

    // The exporter's gate (`is_session_metrics_enabled`) must be on. The
    // session-metrics mode also keeps `sync_profile` off its Tokio spawn.
    client::init(
        TelemetryConfig::default(),
        TelemetryMode::SessionMetrics,
        None,
        None,
        None,
        None,
        "0.0.0-test".into(),
        None,
        reqwest::Client::new(),
    );

    let _layer = build_otel_layer::<tracing_subscriber::Registry>(
        OtelClientInfo {
            client_name: "wire-test",
            client_version: "0.0.0-test",
            service_version: "0.0.0-test",
            app_entrypoint: "cli",
        },
        OtelLayerConfig {
            credentials: Arc::new(StaticProvider),
            token_header_value: "xai-grok-cli".into(),
            alpha_test_key: None,
            exporter: OtelExporterConfig {
                traces_url,
                extra_headers: Vec::new(),
                export_interval: Some(Duration::from_millis(50)),
                timeout: Some(Duration::from_secs(5)),
                enabled: true,
            },
        },
    );

    // One span through the global tracer that `build_otel_layer` installed.
    let tracer = opentelemetry::global::tracer("wire-test");
    let mut span = tracer.start("wire-test-span");
    span.end();

    // Shutdown flushes the batch; the first export resolves the deferred
    // HTTP client on the batch-processor thread.
    shutdown_otel();

    let deadline = Instant::now() + Duration::from_secs(10);
    while received.lock().unwrap().is_empty() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    let requests = received.lock().unwrap().clone();
    let request = requests
        .first()
        .expect("collector must receive the traces POST");
    assert_eq!(request.path, "/v1/traces");
    assert_eq!(
        request.headers.get("authorization").map(String::as_str),
        Some("Bearer wire-test-token"),
    );
    let decoded =
        opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest::decode(
            request.body.as_slice(),
        )
        .expect("export body must be an OTLP traces request");
    let names: Vec<&str> = decoded
        .resource_spans
        .iter()
        .flat_map(|resource| resource.scope_spans.iter())
        .flat_map(|scope| scope.spans.iter())
        .map(|span| span.name.as_str())
        .collect();
    assert!(
        names.contains(&"wire-test-span"),
        "span names on the wire: {names:?}",
    );
}
