use axum::{
    Json, Router,
    body::Body,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use futures_util::{StreamExt, TryStreamExt};
use serde::Deserialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{io::AsyncBufReadExt, sync::Semaphore};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
struct App {
    token: String,
    clients: Arc<Mutex<HashMap<String, reqwest::Client>>>,
    jobs: Arc<Mutex<HashMap<String, CancellationToken>>>,
    total: Arc<Semaphore>,
    bulk: Arc<Semaphore>,
    proxy_cache: Arc<Mutex<HashMap<String, (Instant, ProxyPolicy)>>>,
}
type ProxyPolicy = Result<Option<Vec<String>>, &'static str>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Job {
    id: String,
    url: String,
    #[serde(default = "get")]
    method: String,
    #[serde(default)]
    headers: HashMap<String, String>,
    body: Option<String>,
    file: Option<String>,
    proxy: Option<String>,
    #[serde(default = "timeout")]
    timeout_ms: u64,
    #[serde(default = "limit")]
    max_bytes: u64,
    #[serde(default = "priority")]
    priority: u8,
    #[serde(default = "follow")]
    redirect: String,
    allowed_domains: Option<Vec<String>>,
    allowed_origin: Option<String>,
}
fn get() -> String {
    "GET".into()
}
fn follow() -> String {
    "follow".into()
}
fn timeout() -> u64 {
    120_000
}
fn limit() -> u64 {
    16 << 20
}
fn priority() -> u8 {
    2
}

fn error(message: &str) -> Response {
    (
        StatusCode::BAD_GATEWAY,
        [("x-mora-network-error", "1")],
        message.to_owned(),
    )
        .into_response()
}

// No URL, headers, proxy credentials or upstream error text crosses the error/log boundary.
fn client(app: &App, proxy: &Option<String>) -> Result<reqwest::Client, &'static str> {
    let key = serde_json::to_string(proxy).unwrap();
    let mut clients = app.clients.lock().unwrap();
    if let Some(client) = clients.get(&key) {
        return Ok(client.clone());
    }
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .pool_max_idle_per_host(5)
        .pool_idle_timeout(Duration::from_secs(90));
    if let Some(proxy) = proxy {
        builder = if proxy.is_empty() {
            builder.no_proxy()
        } else {
            builder.proxy(reqwest::Proxy::all(proxy).map_err(|_| "invalid proxy")?)
        };
    }
    let built = builder.build().map_err(|_| "HTTP client unavailable")?;
    // Provider proxy settings are finite; do not retain arbitrary old credential sets forever.
    if clients.len() >= 16 {
        clients.clear();
    }
    clients.insert(key, built.clone());
    Ok(built)
}

fn allowed(url: &reqwest::Url, domains: Option<&Vec<String>>, origin: Option<&str>) -> bool {
    if !["http", "https"].contains(&url.scheme())
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return false;
    }
    let Some(domains) = domains else {
        return true;
    };
    if origin.is_some_and(|origin| url.origin().ascii_serialization() == origin) {
        return true;
    }
    url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && url.host_str().is_some_and(|host| {
            domains
                .iter()
                .any(|domain| host == domain || host.ends_with(&format!(".{domain}")))
        })
}

async fn execute(app: App, job: Job, cancel: CancellationToken) -> Result<Response, &'static str> {
    if job.timeout_ms == 0 || job.max_bytes == 0 || job.priority > 3 {
        return Err("invalid request limits");
    }
    let url = reqwest::Url::parse(&job.url).map_err(|_| "invalid HTTP URL")?;
    if !allowed(
        &url,
        job.allowed_domains.as_ref(),
        job.allowed_origin.as_deref(),
    ) {
        return Err("HTTP URL rejected");
    }
    // Two slots remain available for current/next playback even during bulk downloads.
    let bulk = if job.priority >= 2 {
        Some(
            app.bulk
                .clone()
                .acquire_owned()
                .await
                .map_err(|_| "network stopped")?,
        )
    } else {
        None
    };
    let total = app
        .total
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| "network stopped")?;
    let mut current = url;
    let mut method: reqwest::Method = job.method.parse().map_err(|_| "invalid method")?;
    let mut request_headers = HeaderMap::new();
    for (name, value) in &job.headers {
        request_headers.insert(
            name.parse::<reqwest::header::HeaderName>()
                .map_err(|_| "invalid header")?,
            value.parse().map_err(|_| "invalid header")?,
        );
    }
    let mut body = job
        .body
        .as_ref()
        .map(|body| STANDARD.decode(body))
        .transpose()
        .map_err(|_| "invalid request body")?;
    let mut final_response = None;
    for redirects in 0..=5 {
        let proxies = match &job.proxy {
            Some(proxy) => vec![Some(proxy.clone())],
            None => system_proxy(&app, &current)
                .await?
                .map(|proxies| proxies.into_iter().map(Some).collect())
                .unwrap_or_else(|| vec![None]),
        };
        let response = send_with_proxies(
            &app,
            &current,
            &method,
            &request_headers,
            &body,
            job.timeout_ms,
            &proxies,
        )
        .await?;
        let status = response.status().as_u16();
        if ![301, 302, 303, 307, 308].contains(&status) || job.redirect == "manual" {
            final_response = Some(response);
            break;
        }
        if job.redirect == "error" || redirects == 5 {
            return Err("redirect rejected");
        }
        let Some(location) = response.headers().get("location") else {
            final_response = Some(response);
            break;
        };
        let next = current
            .join(location.to_str().map_err(|_| "invalid redirect")?)
            .map_err(|_| "invalid redirect")?;
        if !allowed(
            &next,
            job.allowed_domains.as_ref(),
            job.allowed_origin.as_deref(),
        ) {
            return Err("redirect target rejected");
        }
        if current.origin() != next.origin() {
            for header in [
                "authorization",
                "cookie",
                "cookie2",
                "proxy-authorization",
                "www-authenticate",
                "host",
            ] {
                request_headers.remove(header);
            }
        }
        if (status == 303 && method != reqwest::Method::HEAD)
            || ([301, 302].contains(&status) && method == reqwest::Method::POST)
        {
            method = reqwest::Method::GET;
            body = None;
            for header in [
                "content-length",
                "content-type",
                "content-encoding",
                "transfer-encoding",
            ] {
                request_headers.remove(header);
            }
        }
        current = next;
    }
    let response = final_response.ok_or("redirect rejected")?;
    let status = response.status();
    let null_body =
        job.method.eq_ignore_ascii_case("HEAD") || [204, 205, 304].contains(&status.as_u16());
    if !null_body && response.content_length().is_some_and(|n| n > job.max_bytes) {
        return Err("response exceeds size limit");
    }
    let mut headers = response.headers().clone();
    headers.remove("x-mora-network-error");
    headers.remove("connection");
    headers.remove("transfer-encoding");
    headers.remove("x-mora-head-content-length");
    if job.method.eq_ignore_ascii_case("HEAD") {
        if let Some(length) = headers.remove("content-length") {
            headers.insert("x-mora-head-content-length", length);
        }
    }
    headers.insert(
        "x-mora-response-url",
        response
            .url()
            .as_str()
            .parse()
            .map_err(|_| "invalid response URL")?,
    );
    if let Some(file) = &job.file {
        if !status.is_success() {
            return Err("download HTTP status rejected");
        }
        let output = tokio::task::block_in_place(|| {
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(file)
        })
        .map_err(|_| "cannot create download file")?;
        let mut output = PartialFile {
            file: Some(output),
            path: file.clone(),
            complete: false,
        };
        let mut bytes = 0u64;
        let mut stream = response.bytes_stream();
        let result = async {
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|_| "HTTP body interrupted")?;
                bytes += chunk.len() as u64;
                if bytes > job.max_bytes {
                    return Err("response exceeds size limit");
                }
                tokio::task::block_in_place(|| {
                    std::io::Write::write_all(output.file.as_mut().unwrap(), &chunk)
                })
                .map_err(|_| "download write failed")?;
            }
            tokio::task::block_in_place(|| std::io::Write::flush(output.file.as_mut().unwrap()))
                .map_err(|_| "download write failed")?;
            Ok(())
        };
        let result = tokio::select! { _ = cancel.cancelled() => Err("request cancelled"), result = result => result };
        result?;
        output.complete = true;
        return Ok(
            Json(serde_json::json!({"bytes": bytes, "status": status.as_u16()})).into_response(),
        );
    }
    let mut bytes = 0u64;
    let stream = response
        .bytes_stream()
        .map_err(|_| std::io::Error::other("HTTP body interrupted"))
        .and_then(move |chunk| {
            bytes += chunk.len() as u64;
            let result = if bytes > job.max_bytes {
                Err(std::io::Error::other("response exceeds size limit"))
            } else {
                Ok(chunk)
            };
            std::future::ready(result)
        });
    // Keep concurrency permits and cancellation registration until the body is drained/dropped.
    let guard = JobGuard {
        app,
        id: job.id,
        _bulk: bulk,
        _total: total,
    };
    let stream = futures_util::stream::unfold(
        (Box::pin(stream), guard, cancel),
        |(mut stream, guard, cancel)| async move {
            let next =
                tokio::select! { _ = cancel.cancelled() => None, next = stream.next() => next };
            next.map(|chunk| (chunk, (stream, guard, cancel)))
        },
    );
    Ok((status, headers, Body::from_stream(stream)).into_response())
}

struct PartialFile {
    file: Option<std::fs::File>,
    path: String,
    complete: bool,
}
impl Drop for PartialFile {
    fn drop(&mut self) {
        drop(self.file.take());
        if !self.complete {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

struct JobGuard {
    app: App,
    id: String,
    _bulk: Option<tokio::sync::OwnedSemaphorePermit>,
    _total: tokio::sync::OwnedSemaphorePermit,
}
impl Drop for JobGuard {
    fn drop(&mut self) {
        self.app.jobs.lock().unwrap().remove(&self.id);
    }
}

async fn run(State(app): State<App>, headers: HeaderMap, Json(job): Json<Job>) -> Response {
    if headers.get("authorization").and_then(|v| v.to_str().ok()) != Some(&app.token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let cancel = CancellationToken::new();
    let id = job.id.clone();
    app.jobs.lock().unwrap().insert(id.clone(), cancel.clone());
    let timeout_ms = job.timeout_ms;
    let result = tokio::select! {
        _ = cancel.cancelled() => Err("request cancelled"),
        result = tokio::time::timeout(Duration::from_millis(timeout_ms), execute(app.clone(), job, cancel.clone())) => result.unwrap_or(Err("HTTP request timed out")),
    };
    match result {
        Ok(response) => {
            // A file response has no live upstream body.
            if response.headers().get("x-mora-response-url").is_none() {
                app.jobs.lock().unwrap().remove(&id);
            }
            response
        }
        Err(message) => {
            app.jobs.lock().unwrap().remove(&id);
            error(message)
        }
    }
}

#[derive(Deserialize)]
struct Cancel {
    id: String,
}
async fn cancel(State(app): State<App>, headers: HeaderMap, Json(job): Json<Cancel>) -> StatusCode {
    if headers.get("authorization").and_then(|v| v.to_str().ok()) != Some(&app.token) {
        return StatusCode::UNAUTHORIZED;
    }
    if let Some(cancel) = app.jobs.lock().unwrap().get(&job.id) {
        cancel.cancel();
    }
    StatusCode::NO_CONTENT
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    let token = std::env::var("MORA_NETWORK_TOKEN").expect("network capability missing");
    if token.len() < 32 {
        std::process::exit(2);
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("loopback unavailable");
    let port = listener.local_addr().unwrap().port();
    let app = App {
        token,
        clients: Default::default(),
        jobs: Default::default(),
        total: Arc::new(Semaphore::new(5)),
        bulk: Arc::new(Semaphore::new(3)),
        proxy_cache: Default::default(),
    };
    println!("{{\"port\":{port},\"automaticProxySupported\":true}}");
    let router = Router::new()
        .route("/request", post(run))
        .route("/cancel", post(cancel))
        .with_state(app);
    let shutdown = async {
        let mut line = String::new();
        let _ = tokio::io::BufReader::new(tokio::io::stdin())
            .read_line(&mut line)
            .await;
    };
    let _ = axum::serve(listener, router)
        .with_graceful_shutdown(shutdown)
        .await;
}

async fn send_with_proxies(
    app: &App,
    url: &reqwest::Url,
    method: &reqwest::Method,
    headers: &HeaderMap,
    body: &Option<Vec<u8>>,
    timeout_ms: u64,
    proxies: &[Option<String>],
) -> Result<reqwest::Response, &'static str> {
    for (index, proxy) in proxies.iter().enumerate() {
        let mut request = client(app, proxy)?
            .request(method.clone(), url.clone())
            .headers(headers.clone())
            .timeout(Duration::from_millis(timeout_ms));
        if let Some(body) = body {
            request = request.body(body.clone());
        }
        match request.send().await {
            Ok(response) => return Ok(response),
            // Connect failures happen before an origin request body is sent; never replay a sent POST.
            Err(error) if error.is_connect() && index + 1 < proxies.len() => continue,
            Err(_) => return Err("HTTP connection failed"),
        }
    }
    Err("system proxy policy is empty")
}

async fn system_proxy(app: &App, url: &reqwest::Url) -> ProxyPolicy {
    // Explicit environment settings retain reqwest's NO_PROXY matching and precedence.
    if [format!("{}_proxy", url.scheme()), "all_proxy".into()]
        .iter()
        .any(|name| {
            [name.clone(), name.to_uppercase()]
                .iter()
                .any(|name| std::env::var(name).is_ok_and(|value| !value.is_empty()))
        })
    {
        return Ok(None);
    }
    let key = url.as_str().to_owned();
    if let Some((at, proxy)) = app.proxy_cache.lock().unwrap().get(&key) {
        if at.elapsed() < Duration::from_secs(60) {
            return proxy.clone();
        }
    }
    let target = key.clone();
    let result = tokio::task::spawn_blocking(move || resolve_system_proxy(&target))
        .await
        .map_err(|_| "system proxy resolution failed")?;
    let mut cache = app.proxy_cache.lock().unwrap();
    if cache.len() >= 128 {
        cache.clear();
    }
    cache.insert(key, (Instant::now(), result.clone()));
    result
}

fn parse_proxy_policy(value: &str, scheme: &str) -> Result<Vec<String>, &'static str> {
    let entries: Vec<_> = value
        .split(';')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect();
    let selected = entries
        .iter()
        .find_map(|entry| {
            entry
                .split_once('=')
                .filter(|(name, _)| name.eq_ignore_ascii_case(scheme))
                .map(|(_, value)| value)
        })
        .map(|value| vec![value])
        .unwrap_or_else(|| {
            entries
                .iter()
                .filter(|entry| !entry.contains('='))
                .copied()
                .collect()
        });
    if selected.is_empty() {
        return Err("system proxy policy unsupported");
    }
    selected.into_iter().map(parse_proxy_entry).collect()
}

fn parse_proxy_entry(chosen: &str) -> Result<String, &'static str> {
    if chosen.eq_ignore_ascii_case("DIRECT") {
        return Ok(String::new());
    }
    let proxy = if let Some((kind, address)) = chosen.split_once(' ') {
        if kind.eq_ignore_ascii_case("PROXY") {
            format!("http://{}", address.trim())
        } else if kind.eq_ignore_ascii_case("SOCKS") || kind.eq_ignore_ascii_case("SOCKS5") {
            format!("socks5h://{}", address.trim())
        } else {
            return Err("system proxy policy unsupported");
        }
    } else if chosen.contains("://") {
        chosen.to_owned()
    } else {
        format!("http://{chosen}")
    };
    let parsed = reqwest::Url::parse(&proxy).map_err(|_| "system proxy policy unsupported")?;
    if !["http", "https", "socks5", "socks5h"].contains(&parsed.scheme())
        || parsed.host_str().is_none()
    {
        return Err("system proxy policy unsupported");
    }
    Ok(proxy)
}

#[cfg(windows)]
fn resolve_system_proxy(target: &str) -> ProxyPolicy {
    use std::ptr::null;
    use windows_sys::Win32::{
        Foundation::{GetLastError, GlobalFree},
        Networking::WinHttp::*,
    };
    unsafe fn wide(pointer: *const u16) -> String {
        if pointer.is_null() {
            return String::new();
        }
        let mut len = 0;
        while len < 32768 && unsafe { *pointer.add(len) } != 0 {
            len += 1;
        }
        String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(pointer, len) })
    }
    let mut config = WINHTTP_CURRENT_USER_IE_PROXY_CONFIG::default();
    unsafe {
        if WinHttpGetIEProxyConfigForCurrentUser(&mut config) == 0 {
            return Err("system proxy configuration unavailable");
        }
        let result = (|| {
            let has_url = !config.lpszAutoConfigUrl.is_null() && *config.lpszAutoConfigUrl != 0;
            if config.fAutoDetect == 0 && !has_url {
                return Ok(None);
            }
            let agent: Vec<_> = "MORA native network"
                .encode_utf16()
                .chain(Some(0))
                .collect();
            let session = WinHttpOpen(
                agent.as_ptr(),
                WINHTTP_ACCESS_TYPE_NO_PROXY,
                null(),
                null(),
                0,
            );
            if session.is_null() {
                return Err("system proxy resolution failed");
            }
            WinHttpSetTimeouts(session, 5000, 5000, 5000, 5000);
            let mut options = WINHTTP_AUTOPROXY_OPTIONS::default();
            if has_url {
                options.dwFlags |= WINHTTP_AUTOPROXY_CONFIG_URL;
                options.lpszAutoConfigUrl = config.lpszAutoConfigUrl;
            }
            if config.fAutoDetect != 0 {
                options.dwFlags |= WINHTTP_AUTOPROXY_AUTO_DETECT;
                options.dwAutoDetectFlags =
                    WINHTTP_AUTO_DETECT_TYPE_DHCP | WINHTTP_AUTO_DETECT_TYPE_DNS_A;
            }
            // Do not silently send the user's Windows credentials to a PAC server.
            options.fAutoLogonIfChallenged = 0;
            let target_wide: Vec<_> = target.encode_utf16().chain(Some(0)).collect();
            let mut info = WINHTTP_PROXY_INFO::default();
            let ok =
                WinHttpGetProxyForUrl(session, target_wide.as_ptr(), &mut options, &mut info) != 0;
            let code = GetLastError();
            WinHttpCloseHandle(session);
            let result = if ok {
                if info.dwAccessType == WINHTTP_ACCESS_TYPE_NO_PROXY {
                    Ok(Some(vec![String::new()]))
                } else if info.dwAccessType == WINHTTP_ACCESS_TYPE_NAMED_PROXY {
                    parse_proxy_policy(
                        &wide(info.lpszProxy),
                        reqwest::Url::parse(target)
                            .map_err(|_| "invalid HTTP URL")?
                            .scheme(),
                    )
                    .map(Some)
                } else {
                    Err("system proxy policy unsupported")
                }
            } else if code == 12180 && !has_url {
                Ok(Some(vec![String::new()]))
            } else {
                Err("system proxy resolution failed")
            };
            for pointer in [info.lpszProxy, info.lpszProxyBypass] {
                if !pointer.is_null() {
                    GlobalFree(pointer.cast());
                }
            }
            result
        })();
        for pointer in [
            config.lpszAutoConfigUrl,
            config.lpszProxy,
            config.lpszProxyBypass,
        ] {
            if !pointer.is_null() {
                GlobalFree(pointer.cast());
            }
        }
        result
    }
}
#[cfg(not(windows))]
fn resolve_system_proxy(_: &str) -> ProxyPolicy {
    Ok(None)
}

#[test]
fn proxy_policy_parsing() {
    assert_eq!(
        parse_proxy_policy("http=one:80;https=two:443", "https"),
        Ok(vec!["http://two:443".into()])
    );
    assert_eq!(
        parse_proxy_policy("PROXY cache.example:8080; DIRECT", "https"),
        Ok(vec!["http://cache.example:8080".into(), String::new()])
    );
    assert_eq!(
        parse_proxy_policy("DIRECT", "https"),
        Ok(vec![String::new()])
    );
    assert_eq!(
        parse_proxy_policy("SOCKS5 cache.example:1080", "https"),
        Ok(vec!["socks5h://cache.example:1080".into()])
    );
    assert!(parse_proxy_policy("ftp://cache.example", "https").is_err());
    assert!(parse_proxy_policy("http=one:80", "https").is_err());
}

#[tokio::test]
async fn ordered_proxy_failover_sends_post_once() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = reqwest::Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        loop {
            let mut buffer = [0; 1024];
            let len = socket.read(&mut buffer).await.unwrap();
            request.extend_from_slice(&buffer[..len]);
            if request.ends_with(b"body-sent-once") {
                break;
            }
        }
        assert!(request.starts_with(b"POST / HTTP/1.1"));
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
            .await
            .unwrap();
    });
    let app = App {
        token: String::new(),
        clients: Default::default(),
        jobs: Default::default(),
        proxy_cache: Default::default(),
        total: Arc::new(Semaphore::new(5)),
        bulk: Arc::new(Semaphore::new(3)),
    };
    let policies = vec![Some("http://127.0.0.1:1".into()), Some(String::new())];
    let response = send_with_proxies(
        &app,
        &url,
        &reqwest::Method::POST,
        &HeaderMap::new(),
        &Some(b"body-sent-once".to_vec()),
        5000,
        &policies,
    )
    .await
    .unwrap();
    assert_eq!(response.text().await.unwrap(), "ok");
    server.await.unwrap();
}

#[tokio::test]
async fn sent_post_is_not_replayed_after_proxy_disconnect() {
    use tokio::io::AsyncReadExt;
    let target = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = reqwest::Url::parse(&format!("http://{}/", target.local_addr().unwrap())).unwrap();
    let proxy = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let policies = vec![
        Some(format!("http://{}", proxy.local_addr().unwrap())),
        Some(String::new()),
    ];
    let server = tokio::spawn(async move {
        let (mut socket, _) = proxy.accept().await.unwrap();
        let mut request = Vec::new();
        loop {
            let mut buffer = [0; 1024];
            let len = socket.read(&mut buffer).await.unwrap();
            request.extend_from_slice(&buffer[..len]);
            if request.ends_with(b"body-sent-once") {
                break;
            }
        }
    });
    let app = App {
        token: String::new(),
        clients: Default::default(),
        jobs: Default::default(),
        proxy_cache: Default::default(),
        total: Arc::new(Semaphore::new(5)),
        bulk: Arc::new(Semaphore::new(3)),
    };
    assert!(
        send_with_proxies(
            &app,
            &url,
            &reqwest::Method::POST,
            &HeaderMap::new(),
            &Some(b"body-sent-once".to_vec()),
            5000,
            &policies
        )
        .await
        .is_err()
    );
    server.await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(100), target.accept())
            .await
            .is_err()
    );
}
