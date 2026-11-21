use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Spaces requests at least `min_interval` apart across threads.
pub(crate) struct Pacer {
    min_interval: Duration,
    next_free: Mutex<Option<Instant>>,
}

impl Pacer {
    pub(crate) const fn new(min_interval: Duration) -> Self {
        Self {
            min_interval,
            next_free: Mutex::new(None),
        }
    }

    /// Reserves the next slot at or after `now` and returns how long the caller
    /// must wait before sending (`Duration::ZERO` when the slot is free now).
    /// Concurrent callers get distinct, increasing slots.
    pub(crate) fn reserve(&self, now: Instant) -> Duration {
        let mut next_free = match self.next_free.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };

        match *next_free {
            None => {
                *next_free = Some(now + self.min_interval);
                Duration::ZERO
            }
            Some(slot) if slot <= now => {
                *next_free = Some(now + self.min_interval);
                Duration::ZERO
            }
            Some(slot) => {
                *next_free = Some(slot + self.min_interval);
                slot.duration_since(now)
            }
        }
    }
}

/// How long to wait before retry number `attempt` (1-based, at most
/// `max_retries`) after a 429 or a transient failure.
///
/// A `Retry-After` value is honored, capped at `cap`: delay-seconds, or an
/// HTTP-date counted from `now` (a date already past means no wait). Anything
/// else (garbage or a missing header) falls back to exponential backoff:
/// `base * 2^(attempt - 1)`, also capped at `cap`.
/// Returns `None` when `attempt > max_retries`.
pub(crate) fn retry_delay(
    retry_after: Option<&str>,
    attempt: u32,
    max_retries: u32,
    base: Duration,
    cap: Duration,
    now: chrono::DateTime<chrono::Utc>,
) -> Option<Duration> {
    if attempt == 0 || attempt > max_retries {
        return None;
    }

    let retry_after = retry_after.map(str::trim);
    if let Some(seconds) = retry_after.and_then(|value| value.parse::<u64>().ok()) {
        return Some(Duration::from_secs(seconds).min(cap));
    }
    if let Some(date) = retry_after.and_then(|value| chrono::DateTime::parse_from_rfc2822(value).ok()) {
        let wait = (date.with_timezone(&chrono::Utc) - now).to_std().unwrap_or(Duration::ZERO);
        return Some(wait.min(cap));
    }

    let factor = 1u32
        .checked_shl(attempt - 1)
        .unwrap_or(u32::MAX);
    let backoff = base.checked_mul(factor).unwrap_or(cap);
    Some(backoff.min(cap))
}

/// A bounded cache whose entries expire `ttl` after insertion.
pub(crate) struct TtlCache<V: Clone> {
    ttl: Duration,
    capacity: usize,
    entries: Mutex<HashMap<String, (Instant, V)>>,
}

impl<V: Clone> TtlCache<V> {
    pub(crate) fn new(ttl: Duration, capacity: usize) -> Self {
        Self {
            ttl,
            capacity,
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// Returns a live entry, or `None`. Expired entries are removed when seen.
    pub(crate) fn get(&self, key: &str, now: Instant) -> Option<V> {
        let mut entries = match self.entries.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };

        let live = match entries.get(key) {
            Some((inserted_at, value))
                if now.saturating_duration_since(*inserted_at) < self.ttl =>
            {
                Some(value.clone())
            }
            _ => None,
        };

        if live.is_none() {
            // This also makes a no-op removal when the key was absent, which is
            // harmless.
            entries.remove(key);
        }

        live
    }

    /// Inserts or replaces an entry. At capacity, expired entries are dropped
    /// first, then (only if space is still needed) the oldest entry is evicted,
    /// so the map never exceeds `capacity`.
    pub(crate) fn insert(&self, key: String, value: V, now: Instant) {
        let mut entries = match self.entries.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };

        if self.capacity == 0 {
            entries.clear();
            return;
        }

        if entries.len() >= self.capacity {
            entries.retain(|_, (inserted_at, _)| {
                now.saturating_duration_since(*inserted_at) < self.ttl
            });

            if entries.len() >= self.capacity && !entries.contains_key(&key) {
                let oldest_key = entries
                    .iter()
                    .min_by(|left, right| {
                        (left.1).0
                            .cmp(&(right.1).0)
                            .then_with(|| left.0.cmp(right.0))
                    })
                    .map(|(oldest_key, _)| oldest_key.clone());

                if let Some(oldest_key) = oldest_key {
                    entries.remove(&oldest_key);
                }
            }
        }

        entries.insert(key, (now, value));
    }
}

fn push_component(key: &mut String, component: &str) {
    key.push_str(&component.len().to_string());
    key.push(':');
    key.push_str(component);
    key.push('\u{1f}');
}

/// Builds a cache key from the method, path, sorted query pairs and the
/// body itself (request bodies here are small JSON lists).
///
/// There is deliberately no `headers` argument: request headers, and
/// therefore credentials, can never become part of a cache key.
pub(crate) fn cache_key(
    method: &str,
    path: &str,
    query: &[(String, String)],
    body: Option<&[u8]>,
) -> String {
    let mut sorted_query: Vec<(&str, &str)> = query
        .iter()
        .map(|(name, value)| (name.as_str(), value.as_str()))
        .collect();
    sorted_query.sort_unstable();

    let mut key = String::new();
    push_component(&mut key, method);
    push_component(&mut key, path);
    push_component(&mut key, &sorted_query.len().to_string());

    for (name, value) in sorted_query {
        push_component(&mut key, name);
        push_component(&mut key, value);
    }

    match body {
        Some(body) => push_component(&mut key, &format!("body:{}", String::from_utf8_lossy(body))),
        None => push_component(&mut key, "body:none"),
    }

    key
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};
    use std::thread;

    #[test]
    fn pacer_first_call_is_free_and_second_is_spaced() {
        let interval = Duration::from_millis(100);
        let pacer = Pacer::new(interval);
        let now = Instant::now();

        assert_eq!(pacer.reserve(now), Duration::ZERO);
        assert_eq!(pacer.reserve(now), interval);
    }

    #[test]
    fn pacer_is_free_after_the_interval_has_passed() {
        let interval = Duration::from_millis(100);
        let pacer = Pacer::new(interval);
        let now = Instant::now();

        assert_eq!(pacer.reserve(now), Duration::ZERO);
        assert_eq!(pacer.reserve(now + interval), Duration::ZERO);
    }

    #[test]
    fn pacer_threads_get_distinct_increasing_slots() {
        let interval = Duration::from_millis(25);
        let pacer = Arc::new(Pacer::new(interval));
        let barrier = Arc::new(Barrier::new(8));
        let now = Instant::now();

        let handles: Vec<_> = (0..8)
            .map(|_| {
                let pacer = Arc::clone(&pacer);
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    pacer.reserve(now)
                })
            })
            .collect();

        let mut waits: Vec<Duration> = handles
            .into_iter()
            .map(|handle| handle.join().expect("pacer worker panicked"))
            .collect();
        waits.sort_unstable();

        let expected: Vec<Duration> = (0..8).map(|index| interval * index).collect();
        assert_eq!(waits, expected);
    }

    /// A fixed clock: 2026-10-21 07:27:55 UTC.
    fn now() -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339("2026-10-21T07:27:55Z")
            .unwrap()
            .with_timezone(&chrono::Utc)
    }

    #[test]
    fn retry_delay_honors_numeric_retry_after_and_cap() {
        let base = Duration::from_millis(250);
        let cap = Duration::from_secs(10);

        assert_eq!(
            retry_delay(Some("3"), 1, 3, base, cap, now()),
            Some(Duration::from_secs(3))
        );
        assert_eq!(
            retry_delay(Some(" 3 "), 1, 3, base, cap, now()),
            Some(Duration::from_secs(3))
        );
        assert_eq!(
            retry_delay(Some("120"), 1, 3, base, cap, now()),
            Some(cap)
        );
    }

    #[test]
    fn retry_delay_honors_an_http_date_from_now() {
        let base = Duration::from_millis(250);
        let cap = Duration::from_secs(10);

        // Five seconds after the fixed clock.
        assert_eq!(
            retry_delay(Some("Wed, 21 Oct 2026 07:28:00 GMT"), 1, 3, base, cap, now()),
            Some(Duration::from_secs(5))
        );
        // A date already past: retry without waiting.
        assert_eq!(
            retry_delay(Some("Wed, 21 Oct 2015 07:28:00 GMT"), 2, 3, base, cap, now()),
            Some(Duration::ZERO)
        );
        // An hour ahead: capped.
        assert_eq!(
            retry_delay(Some("Wed, 21 Oct 2026 08:28:00 GMT"), 3, 3, base, cap, now()),
            Some(cap)
        );
    }

    #[test]
    fn retry_delay_exponential_fallback_for_garbage_and_no_header() {
        let base = Duration::from_millis(250);
        let cap = Duration::from_secs(10);
        let headers = [Some("abc"), Some("Wed, 32 Oct 2026 07:28:00 GMT"), None];
        let expected = [
            Duration::from_millis(250),
            Duration::from_millis(500),
            Duration::from_millis(1_000),
        ];

        for header in headers {
            for (index, expected_delay) in expected.iter().enumerate() {
                assert_eq!(
                    retry_delay(header, index as u32 + 1, 3, base, cap, now()),
                    Some(*expected_delay)
                );
            }
        }
    }

    #[test]
    fn retry_delay_stops_after_max_retries_and_never_exceeds_cap() {
        let base = Duration::from_millis(250);
        let cap = Duration::from_secs(10);

        assert_eq!(retry_delay(None, 4, 3, base, cap, now()), None);
        assert_eq!(retry_delay(Some("3"), 4, 3, base, cap, now()), None);
        assert_eq!(retry_delay(None, 1, 0, base, cap, now()), None);

        for attempt in 1..=20 {
            let fallback = retry_delay(Some("not-a-number"), attempt, 20, base, cap, now())
                .expect("attempt is within max_retries");
            assert!(fallback <= cap);

            let header = retry_delay(Some("120"), attempt, 20, base, cap, now())
                .expect("attempt is within max_retries");
            assert!(header <= cap);
        }
    }

    #[test]
    fn ttl_cache_get_is_live_before_ttl_and_removes_at_ttl() {
        let ttl = Duration::from_secs(10);
        let cache = TtlCache::new(ttl, 4);
        let now = Instant::now();

        cache.insert("key".to_string(), "value".to_string(), now);
        assert_eq!(
            cache.get("key", now + Duration::from_millis(9_999)),
            Some("value".to_string())
        );
        assert_eq!(cache.get("key", now + ttl), None);
        assert_eq!(cache.entries.lock().unwrap().len(), 0);
    }

    #[test]
    fn ttl_cache_get_after_ttl_also_removes_entry() {
        let ttl = Duration::from_secs(10);
        let cache = TtlCache::new(ttl, 4);
        let now = Instant::now();

        cache.insert("key".to_string(), 7, now);
        assert_eq!(cache.get("key", now + ttl + Duration::from_millis(1)), None);
        assert_eq!(cache.entries.lock().unwrap().len(), 0);
    }

    #[test]
    fn ttl_cache_never_exceeds_capacity_and_evicts_oldest_live() {
        let ttl = Duration::from_secs(60);
        let cache = TtlCache::new(ttl, 2);
        let now = Instant::now();

        cache.insert("a".to_string(), 1, now);
        cache.insert("b".to_string(), 2, now + Duration::from_millis(1));
        cache.insert("c".to_string(), 3, now + Duration::from_millis(2));

        assert!(cache.entries.lock().unwrap().len() <= 2);
        assert_eq!(cache.get("a", now + Duration::from_millis(3)), None);
        assert_eq!(cache.get("b", now + Duration::from_millis(3)), Some(2));
        assert_eq!(cache.get("c", now + Duration::from_millis(3)), Some(3));

        for index in 0..20 {
            cache.insert(
                format!("later-{index}"),
                index,
                now + Duration::from_millis(100 + index),
            );
            assert!(cache.entries.lock().unwrap().len() <= 2);
        }
    }

    #[test]
    fn ttl_cache_drops_expired_entries_before_evicting_live_ones() {
        let ttl = Duration::from_secs(10);
        let cache = TtlCache::new(ttl, 3);
        let now = Instant::now();

        cache.insert("expired".to_string(), 1, now);
        cache.insert("older-live".to_string(), 2, now + Duration::from_secs(5));
        cache.insert("newer-live".to_string(), 3, now + Duration::from_secs(6));

        let later = now + Duration::from_secs(12);
        cache.insert("new".to_string(), 4, later);

        assert_eq!(cache.entries.lock().unwrap().len(), 3);
        assert_eq!(cache.get("expired", later), None);
        assert_eq!(cache.get("older-live", later), Some(2));
        assert_eq!(cache.get("newer-live", later), Some(3));
        assert_eq!(cache.get("new", later), Some(4));

        let zero_capacity: TtlCache<i32> = TtlCache::new(ttl, 0);
        zero_capacity.insert("ignored".to_string(), 1, now);
        assert_eq!(zero_capacity.entries.lock().unwrap().len(), 0);
    }

    #[test]
    fn ttl_cache_replaces_existing_key_without_evicting_another() {
        let ttl = Duration::from_secs(60);
        let cache = TtlCache::new(ttl, 2);
        let now = Instant::now();

        cache.insert("a".to_string(), 1, now);
        cache.insert("b".to_string(), 2, now + Duration::from_millis(1));
        cache.insert("a".to_string(), 9, now + Duration::from_millis(2));

        assert_eq!(cache.entries.lock().unwrap().len(), 2);
        assert_eq!(cache.get("a", now + Duration::from_millis(3)), Some(9));
        assert_eq!(cache.get("b", now + Duration::from_millis(3)), Some(2));
    }

    #[test]
    fn cache_key_is_independent_of_query_order() {
        let query_one = vec![
            ("z".to_string(), "last".to_string()),
            ("a".to_string(), "first".to_string()),
        ];
        let query_two = vec![
            ("a".to_string(), "first".to_string()),
            ("z".to_string(), "last".to_string()),
        ];

        assert_eq!(
            cache_key("GET", "/api/mods", &query_one, None),
            cache_key("GET", "/api/mods", &query_two, None)
        );
    }

    #[test]
    fn cache_key_distinguishes_bodies_but_is_stable_for_same_body() {
        let query = vec![("q".to_string(), "value".to_string())];
        let first = cache_key("POST", "/api/search", &query, Some(b"first body"));
        let second = cache_key("POST", "/api/search", &query, Some(b"second body"));
        let first_again = cache_key("POST", "/api/search", &query, Some(b"first body"));

        assert_ne!(first, second);
        assert_eq!(first, first_again);
        assert_ne!(
            cache_key("POST", "/api/search", &query, None),
            cache_key("POST", "/api/search", &query, Some(b""))
        );
    }
}
