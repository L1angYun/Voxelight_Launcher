//! A raw HTTP server for part and Range tests: each connection gets the next
//! scripted reply, and the request headers and the body bytes sent are recorded.
use std::{
    collections::HashMap,
    sync::{atomic::Ordering, Arc},
    time::Duration,
};

/// One scripted answer of the Range test server.
#[derive(Clone, Default)]
pub(crate) struct Scripted {
    pub(crate) status: u16,
    pub(crate) headers: Vec<(&'static str, String)>,
    pub(crate) body: Vec<u8>,
    /// Send nothing, not even headers, until the test releases the connection.
    silent: bool,
    /// Declare no Content-Length: the body ends when the connection closes.
    no_length: bool,
    /// Send only this many body bytes, then close (Content-Length still declares all).
    cut_after: Option<usize>,
    /// Send this many body bytes, then wait until the test releases the connection.
    stall_after: Option<usize>,
    /// The ETag of a reply that follows the request's `Range`.
    ranged: Option<String>,
}

impl Scripted {
    pub(crate) fn ok(body: &[u8], etag: &str) -> Self {
        Self { status: 200, headers: vec![("ETag", etag.into())], body: body.to_vec(), ..Self::default() }
    }
    pub(crate) fn partial(whole: &[u8], from: usize, etag: &str) -> Self {
        let range = format!("bytes {from}-{}/{}", whole.len() - 1, whole.len());
        Self { status: 206, headers: vec![("ETag", etag.into()), ("Content-Range", range)], body: whole[from..].to_vec(), ..Self::default() }
    }
    /// A reply that follows the request: `Range: bytes=N-` with a start inside
    /// the body is answered with the rest, anything else with the whole body.
    pub(crate) fn ranged(whole: &[u8], etag: &str) -> Self {
        Self { status: 200, headers: vec![("ETag", etag.into())], body: whole.to_vec(), ranged: Some(etag.into()), ..Self::default() }
    }
    /// The concrete answer to a request, for a reply that follows its Range.
    fn for_request(mut self, headers: &HashMap<String, String>) -> Self {
        let Some(etag) = self.ranged.take() else { return self };
        let from = headers
            .get("range")
            .and_then(|value| value.strip_prefix("bytes="))
            .and_then(|value| value.strip_suffix('-'))
            .and_then(|value| value.parse::<usize>().ok());
        if let Some(from) = from.filter(|from| *from > 0 && *from < self.body.len()) {
            let length = self.body.len();
            self.headers = vec![("ETag", etag), ("Content-Range", format!("bytes {from}-{}/{length}", length - 1))];
            self.body = self.body.split_off(from);
            self.status = 206;
        }
        self
    }
    pub(crate) fn cut(mut self, after: usize) -> Self {
        self.cut_after = Some(after);
        self
    }
    pub(crate) fn stall(mut self, after: usize) -> Self {
        self.stall_after = Some(after);
        self
    }
    pub(crate) fn with_headers(mut self, headers: Vec<(&'static str, String)>) -> Self {
        self.headers = headers;
        self
    }
    pub(crate) fn with_body(mut self, body: Vec<u8>) -> Self {
        self.body = body;
        self
    }
    pub(crate) fn without_length(mut self) -> Self {
        self.no_length = true;
        self
    }
    pub(crate) fn status(code: u16) -> Self {
        Self { status: code, ..Self::default() }
    }
    pub(crate) fn silent() -> Self {
        Self { status: 200, silent: true, ..Self::default() }
    }
}

/// Answers each connection with the next scripted reply and records the
/// request headers (lower-cased names) and how many body bytes it sent.
/// Each reply is written on its own thread, so a stalled reply does not
/// keep the next connection waiting.
pub(crate) struct RangeServer {
    pub(crate) address: String,
    requests: Arc<std::sync::Mutex<Vec<HashMap<String, String>>>>,
    pub(crate) sent: Arc<std::sync::atomic::AtomicUsize>,
    released: Arc<std::sync::atomic::AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl RangeServer {
    pub(crate) fn new(script: Vec<Scripted>) -> Self {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap().to_string();
        let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sent = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let released = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let thread = {
            let (requests, sent, released) = (requests.clone(), sent.clone(), released.clone());
            std::thread::spawn(move || {
                let mut writers = Vec::new();
                for reply in script {
                    let Ok((mut stream, _)) = listener.accept() else { break };
                    if released.load(Ordering::SeqCst) {
                        break;
                    }
                    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                    let mut request = Vec::new();
                    let mut buffer = [0u8; 4096];
                    while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                        match std::io::Read::read(&mut stream, &mut buffer) {
                            Ok(0) | Err(_) => break,
                            Ok(count) => request.extend_from_slice(&buffer[..count]),
                        }
                    }
                    let text = String::from_utf8_lossy(&request).into_owned();
                    let mut headers: HashMap<String, String> = text
                        .lines()
                        .skip(1)
                        .filter_map(|line| line.split_once(':'))
                        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned()))
                        .collect();
                    if let Some(target) = text.lines().next().and_then(|line| line.split_whitespace().nth(1)) {
                        headers.insert(":path".into(), target.to_owned());
                    }
                    let reply = reply.for_request(&headers);
                    requests.lock().unwrap().push(headers);
                    let (sent, released) = (sent.clone(), released.clone());
                    writers.push(std::thread::spawn(move || {
                        if reply.silent {
                            let until = std::time::Instant::now() + Duration::from_secs(10);
                            while !released.load(Ordering::SeqCst) && std::time::Instant::now() < until {
                                std::thread::sleep(Duration::from_millis(10));
                            }
                            return;
                        }
                        let length = if reply.no_length { String::new() } else { format!("Content-Length: {}\r\n", reply.body.len()) };
                        let mut head = format!("HTTP/1.1 {} Scripted\r\n{length}Connection: close\r\n", reply.status);
                        for (name, value) in &reply.headers {
                            head.push_str(&format!("{name}: {value}\r\n"));
                        }
                        head.push_str("\r\n");
                        let _ = std::io::Write::write_all(&mut stream, head.as_bytes());
                        let limit = reply.cut_after.or(reply.stall_after).unwrap_or(reply.body.len()).min(reply.body.len());
                        if std::io::Write::write_all(&mut stream, &reply.body[..limit]).is_ok() {
                            sent.fetch_add(limit, Ordering::SeqCst);
                        }
                        let _ = std::io::Write::flush(&mut stream);
                        if reply.stall_after.is_some() {
                            let until = std::time::Instant::now() + Duration::from_secs(10);
                            while !released.load(Ordering::SeqCst) && std::time::Instant::now() < until {
                                std::thread::sleep(Duration::from_millis(10));
                            }
                        }
                    }));
                }
                for writer in writers {
                    let _ = writer.join();
                }
            })
        };
        Self { address, requests, sent, released, thread: Some(thread) }
    }

    pub(crate) fn header(&self, request: usize, name: &str) -> Option<String> {
        self.requests.lock().unwrap().get(request).and_then(|headers| headers.get(name).cloned())
    }

    pub(crate) fn count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}

impl Drop for RangeServer {
    fn drop(&mut self) {
        self.released.store(true, Ordering::SeqCst);
        // Unblock a pending accept so the thread can end.
        let _ = std::net::TcpStream::connect(&self.address);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
