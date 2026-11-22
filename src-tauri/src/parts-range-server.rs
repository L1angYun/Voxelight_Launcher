//! A raw HTTP server for part and Range tests: each connection gets the next
//! scripted reply, and the request headers and the body bytes sent are recorded.
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
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
    /// Write the body in chunks of this size, pausing between them.
    paced: Option<(usize, Duration)>,
    /// Advertise that the reply can answer byte ranges.
    accept_ranges: bool,
    /// Wait this long before sending the headers.
    delay: Option<Duration>,
}

impl Scripted {
    pub(crate) fn ok(body: &[u8], etag: &str) -> Self {
        Self { status: 200, headers: vec![("ETag", etag.into())], body: body.to_vec(), ..Self::default() }
    }
    pub(crate) fn partial(whole: &[u8], from: usize, etag: &str) -> Self {
        let range = format!("bytes {from}-{}/{}", whole.len() - 1, whole.len());
        Self { status: 206, headers: vec![("ETag", etag.into()), ("Content-Range", range)], body: whole[from..].to_vec(), ..Self::default() }
    }
    /// A reply that follows the request: `Range: bytes=N-` or `Range: bytes=A-B`
    /// is answered with those bytes (a 206), anything else with the whole body.
    /// An `If-Range` that does not match the ETag also gets the whole body.
    pub(crate) fn ranged(whole: &[u8], etag: &str) -> Self {
        Self { status: 200, headers: vec![("ETag", etag.into())], body: whole.to_vec(), ranged: Some(etag.into()), ..Self::default() }
    }
    /// The concrete answer to a request, for a reply that follows its Range.
    fn for_request(mut self, headers: &HashMap<String, String>) -> Self {
        let Some(etag) = self.ranged.take() else { return self };
        if headers.get("if-range").is_some_and(|value| value != &etag) {
            return self;
        }
        let Some((from, to)) = headers
            .get("range")
            .and_then(|value| byte_range(value, self.body.len()))
        else {
            return self;
        };
        let length = self.body.len();
        self.headers = vec![
            ("ETag", etag),
            ("Content-Range", format!("bytes {from}-{to}/{length}")),
        ];
        self.body = self.body[from..=to].to_vec();
        self.status = 206;
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
    /// Wait `delay` before sending anything.
    pub(crate) fn delayed(mut self, delay: Duration) -> Self {
        self.delay = Some(delay);
        self
    }
    /// Write the body in chunks of `bytes_per_chunk` with `pause` between them.
    pub(crate) fn paced(mut self, bytes_per_chunk: usize, pause: Duration) -> Self {
        self.paced = Some((bytes_per_chunk.max(1), pause));
        self
    }
    /// Advertise `Accept-Ranges: bytes` on the reply.
    pub(crate) fn accepting_ranges(mut self) -> Self {
        self.accept_ranges = true;
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

/// The inclusive byte range of a `Range` header for a body of `length`.
/// `None` keeps today's whole-body 200 answer for a range it cannot serve.
fn byte_range(value: &str, length: usize) -> Option<(usize, usize)> {
    let spec = value.strip_prefix("bytes=")?;
    if let Some(from) = spec.strip_suffix('-') {
        let from: usize = from.parse().ok()?;
        // `bytes=0-` keeps its whole-body answer; a start outside it is unservable.
        return (from > 0 && from < length).then(|| (from, length - 1));
    }
    let (from, to) = spec.split_once('-')?;
    let from: usize = from.parse().ok()?;
    let to: usize = to.parse().ok()?;
    if from > to || from >= length {
        return None;
    }
    Some((from, to.min(length - 1)))
}

/// Wait up to `timeout` for the test to release the server; true when it did.
fn wait_until_released(released: &AtomicBool, timeout: Duration) -> bool {
    let until = std::time::Instant::now() + timeout;
    while !released.load(Ordering::SeqCst) {
        let now = std::time::Instant::now();
        if now >= until {
            break;
        }
        // Short pauses stay short; long waits still notice a release.
        std::thread::sleep((until - now).min(Duration::from_millis(10)));
    }
    released.load(Ordering::SeqCst)
}

/// Answers each connection with the next scripted reply and records the
/// request headers (lower-cased names) and how many body bytes it sent.
/// Each reply is written on its own thread, so a stalled reply does not
/// keep the next connection waiting.
pub(crate) struct RangeServer {
    pub(crate) address: String,
    requests: Arc<std::sync::Mutex<Vec<HashMap<String, String>>>>,
    pub(crate) sent: Arc<std::sync::atomic::AtomicUsize>,
    sent_by_request: Arc<std::sync::Mutex<Vec<usize>>>,
    released: Arc<std::sync::atomic::AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl RangeServer {
    pub(crate) fn new(script: Vec<Scripted>) -> Self {
        Self::start(script, false)
    }

    /// Like `new`, but once the script is used up the last reply answers
    /// every further connection.
    pub(crate) fn repeating(script: Vec<Scripted>) -> Self {
        Self::start(script, true)
    }

    fn start(script: Vec<Scripted>, repeat: bool) -> Self {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap().to_string();
        let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sent = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let sent_by_request = Arc::new(std::sync::Mutex::new(Vec::new()));
        let released = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let thread = {
            let (requests, sent, sent_by_request, released) = (
                requests.clone(),
                sent.clone(),
                sent_by_request.clone(),
                released.clone(),
            );
            std::thread::spawn(move || {
                let mut writers = Vec::new();
                let mut replies = script.into_iter();
                let mut last = None;
                loop {
                    let reply = match replies.next() {
                        Some(reply) => {
                            last = Some(reply.clone());
                            reply
                        }
                        None if repeat => match &last {
                            Some(reply) => reply.clone(),
                            None => break,
                        },
                        None => break,
                    };
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
                    let index = {
                        let mut recorded = requests.lock().unwrap();
                        recorded.push(headers);
                        sent_by_request.lock().unwrap().push(0);
                        recorded.len() - 1
                    };
                    let (sent, sent_by_request, released) = (
                        sent.clone(),
                        sent_by_request.clone(),
                        released.clone(),
                    );
                    writers.push(std::thread::spawn(move || {
                        if reply.silent {
                            wait_until_released(&released, Duration::from_secs(10));
                            return;
                        }
                        if let Some(delay) = reply.delay {
                            if wait_until_released(&released, delay) {
                                return;
                            }
                        }
                        let length = if reply.no_length {
                            String::new()
                        } else {
                            format!("Content-Length: {}\r\n", reply.body.len())
                        };
                        let mut head = format!("HTTP/1.1 {} Scripted\r\n{length}Connection: close\r\n", reply.status);
                        if reply.accept_ranges {
                            head.push_str("Accept-Ranges: bytes\r\n");
                        }
                        for (name, value) in &reply.headers {
                            head.push_str(&format!("{name}: {value}\r\n"));
                        }
                        head.push_str("\r\n");
                        let _ = std::io::Write::write_all(&mut stream, head.as_bytes());
                        let limit = reply.cut_after.or(reply.stall_after).unwrap_or(reply.body.len()).min(reply.body.len());
                        let body = &reply.body[..limit];
                        let (chunk_size, pause) = match reply.paced {
                            Some((size, pause)) => (size.max(1), Some(pause)),
                            None => (64 * 1024, None),
                        };
                        let chunks = body.chunks(chunk_size);
                        let count = chunks.len();
                        for (position, chunk) in chunks.enumerate() {
                            if std::io::Write::write_all(&mut stream, chunk).is_err() {
                                break;
                            }
                            sent.fetch_add(chunk.len(), Ordering::SeqCst);
                            if let Some(bytes) = sent_by_request.lock().unwrap().get_mut(index) {
                                *bytes += chunk.len();
                            }
                            if position + 1 < count {
                                if released.load(Ordering::SeqCst) {
                                    break;
                                }
                                if let Some(pause) = pause {
                                    if wait_until_released(&released, pause) {
                                        break;
                                    }
                                }
                            }
                        }
                        let _ = std::io::Write::flush(&mut stream);
                        if reply.stall_after.is_some() {
                            wait_until_released(&released, Duration::from_secs(10));
                        }
                    }));
                }
                for writer in writers {
                    let _ = writer.join();
                }
            })
        };
        Self { address, requests, sent, sent_by_request, released, thread: Some(thread) }
    }

    pub(crate) fn header(&self, request: usize, name: &str) -> Option<String> {
        self.requests.lock().unwrap().get(request).and_then(|headers| headers.get(name).cloned())
    }

    /// The request's `Range` header, the usual per-request lookup.
    pub(crate) fn range(&self, request: usize) -> Option<String> {
        self.header(request, "range")
    }

    /// The body bytes sent on that connection, counted per written chunk.
    pub(crate) fn sent_by(&self, request: usize) -> usize {
        self.sent_by_request.lock().unwrap().get(request).copied().unwrap_or(0)
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

#[cfg(test)]
mod server_tests {
    use super::*;
    use std::{
        collections::HashMap,
        io::{Read, Write},
        net::TcpStream,
    };

    struct Answer {
        status: u16,
        headers: HashMap<String, String>,
        body: Vec<u8>,
    }

    /// A plain HTTP/1.1 client: send one request and read until the server closes.
    fn fetch(server: &RangeServer, headers: &[(&str, &str)]) -> Answer {
        let mut stream = TcpStream::connect(&server.address).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut request = format!("GET /file HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n", server.address);
        for (name, value) in headers {
            request.push_str(&format!("{name}: {value}\r\n"));
        }
        request.push_str("\r\n");
        stream.write_all(request.as_bytes()).unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).unwrap();
        let split = response
            .windows(4)
            .position(|bytes| bytes == b"\r\n\r\n")
            .expect("a complete response head");
        let head = String::from_utf8_lossy(&response[..split]).into_owned();
        let mut lines = head.lines();
        let status = lines.next().unwrap().split_whitespace().nth(1).unwrap().parse().unwrap();
        let headers = lines
            .filter_map(|line| line.split_once(':'))
            .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned()))
            .collect();
        Answer { status, headers, body: response[split + 4..].to_vec() }
    }

    fn whole() -> Vec<u8> {
        (0u8..10).collect()
    }

    #[test]
    fn closed_range_answers_exactly_its_bytes() {
        let whole = whole();
        let server = RangeServer::new(vec![Scripted::ranged(&whole, "\"v\"")]);
        let answer = fetch(&server, &[("Range", "bytes=2-5")]);
        assert_eq!(answer.status, 206);
        assert_eq!(answer.headers.get("content-range").map(String::as_str), Some("bytes 2-5/10"));
        assert_eq!(answer.headers.get("etag").map(String::as_str), Some("\"v\""));
        assert_eq!(answer.body, whole[2..=5].to_vec());
        assert_eq!(server.range(0).as_deref(), Some("bytes=2-5"));
        assert_eq!(server.sent_by(0), 4);
        assert_eq!(server.sent.load(Ordering::SeqCst), 4);
        assert_eq!(answer.headers.get("accept-ranges"), None, "the default stays without Accept-Ranges");
    }

    #[test]
    fn open_range_from_zero_is_still_the_whole_body() {
        let whole = whole();
        let server = RangeServer::new(vec![Scripted::ranged(&whole, "\"v\"")]);
        let answer = fetch(&server, &[("Range", "bytes=0-")]);
        assert_eq!(answer.status, 200);
        assert_eq!(answer.headers.get("content-range"), None);
        assert_eq!(answer.body, whole);
        assert_eq!(server.sent_by(0), 10);
    }

    #[test]
    fn if_range_must_match_the_reply_etag() {
        let whole = whole();
        let server = RangeServer::new(vec![
            Scripted::ranged(&whole, "\"v\""),
            Scripted::ranged(&whole, "\"v\""),
        ]);
        let stale = fetch(&server, &[("Range", "bytes=2-5"), ("If-Range", "\"old\"")]);
        assert_eq!(stale.status, 200);
        assert_eq!(stale.headers.get("content-range"), None);
        assert_eq!(stale.body, whole);
        let fresh = fetch(&server, &[("Range", "bytes=2-5"), ("If-Range", "\"v\"")]);
        assert_eq!(fresh.status, 206);
        assert_eq!(fresh.body, whole[2..=5].to_vec());
    }

    #[test]
    fn accepting_ranges_is_advertised_even_on_a_206() {
        let whole = whole();
        let server = RangeServer::new(vec![Scripted::ranged(&whole, "\"v\"").accepting_ranges()]);
        let answer = fetch(&server, &[("Range", "bytes=1-3")]);
        assert_eq!(answer.status, 206);
        assert_eq!(answer.headers.get("accept-ranges").map(String::as_str), Some("bytes"));
        assert_eq!(answer.body, whole[1..=3].to_vec());
    }

    #[test]
    fn repeating_serves_the_last_reply_again() {
        let server = RangeServer::repeating(vec![
            Scripted::ok(b"first", "\"1\""),
            Scripted::ok(b"last", "\"2\""),
        ]);
        let bodies: Vec<Vec<u8>> = (0..4).map(|_| fetch(&server, &[]).body).collect();
        assert_eq!(
            bodies,
            vec![b"first".to_vec(), b"last".to_vec(), b"last".to_vec(), b"last".to_vec()]
        );
        assert_eq!(server.count(), 4);
        assert_eq!(server.sent_by(3), 4);
    }

    #[test]
    fn open_ended_range_is_unchanged() {
        let whole = whole();
        let server = RangeServer::new(vec![Scripted::ranged(&whole, "\"v\"")]);
        let answer = fetch(&server, &[("Range", "bytes=3-")]);
        assert_eq!(answer.status, 206);
        assert_eq!(answer.headers.get("content-range").map(String::as_str), Some("bytes 3-9/10"));
        assert_eq!(answer.body, whole[3..].to_vec());
        assert_eq!(server.sent_by(0), 7);
    }

    #[test]
    fn sent_by_counts_only_the_chunks_written_before_a_cut() {
        let server = RangeServer::new(vec![Scripted::ranged(b"0123456789", "\"v\"").cut(3)]);
        let answer = fetch(&server, &[("Range", "bytes=0-9")]);
        assert_eq!(answer.status, 206);
        assert_eq!(answer.body, b"012".to_vec());
        assert_eq!(server.sent_by(0), 3);
        assert_eq!(server.sent.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn paced_replies_write_every_chunk_after_its_pause() {
        let body = vec![b'p'; 9];
        let server = RangeServer::new(vec![Scripted::ok(&body, "\"p\"").paced(3, Duration::from_millis(20))]);
        let started = std::time::Instant::now();
        let answer = fetch(&server, &[]);
        assert_eq!(answer.body, body);
        assert!(started.elapsed() >= Duration::from_millis(30), "three chunks carry two 20 ms pauses");
        assert_eq!(server.sent_by(0), 9);
    }
}
