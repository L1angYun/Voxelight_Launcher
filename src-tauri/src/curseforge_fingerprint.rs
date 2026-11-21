//! CurseForge file fingerprints.
//!
//! CurseForge fingerprints are MurmurHash2 (32-bit, seed 1) values computed
//! over the file contents after removing the ASCII whitespace bytes
//! `0x09`, `0x0A`, `0x0D` and `0x20`. The length mixed into the initial hash
//! is the normalized (whitespace-removed) length.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

const SEED: u32 = 1;
const M: u32 = 0x5bd1_e995;
const R: u32 = 24;

/// Files are streamed in reads of this size, so no more than this many bytes
/// (plus a few bookkeeping values) are held in memory at a time.
const READ_CHUNK_SIZE: usize = 128 * 1024;

#[inline]
fn is_ignored_whitespace(byte: u8) -> bool {
    matches!(byte, b'\t' | b'\n' | b'\r' | b' ')
}

/// Incremental MurmurHash2 over whitespace-normalized bytes.
///
/// The total normalized length must be known up front because MurmurHash2
/// mixes it into the initial state. Bytes may be supplied in arbitrary
/// chunks; a partial 4-byte block is carried across `update` calls.
struct NormalizedMurmur2 {
    h: u32,
    tail: [u8; 4],
    tail_len: usize,
}

impl NormalizedMurmur2 {
    fn new(normalized_len: u32) -> Self {
        Self {
            h: SEED ^ normalized_len,
            tail: [0; 4],
            tail_len: 0,
        }
    }

    #[inline]
    fn mix_block(&mut self, block: u32) {
        let mut k = block.wrapping_mul(M);
        k ^= k >> R;
        k = k.wrapping_mul(M);

        self.h = self.h.wrapping_mul(M) ^ k;
    }

    /// Feeds raw file bytes to the hasher, removing ignored whitespace.
    fn update(&mut self, data: &[u8]) {
        for &byte in data {
            if is_ignored_whitespace(byte) {
                continue;
            }
            self.tail[self.tail_len] = byte;
            self.tail_len += 1;
            if self.tail_len == 4 {
                self.mix_block(u32::from_le_bytes(self.tail));
                self.tail_len = 0;
            }
        }
    }

    fn finalize(mut self) -> u32 {
        // Appleby's tail handling (`switch (len & 3)` with fallthrough).
        match self.tail_len {
            3 => {
                self.h ^= u32::from(self.tail[2]) << 16;
                self.h ^= u32::from(self.tail[1]) << 8;
                self.h ^= u32::from(self.tail[0]);
                self.h = self.h.wrapping_mul(M);
            }
            2 => {
                self.h ^= u32::from(self.tail[1]) << 8;
                self.h ^= u32::from(self.tail[0]);
                self.h = self.h.wrapping_mul(M);
            }
            1 => {
                self.h ^= u32::from(self.tail[0]);
                self.h = self.h.wrapping_mul(M);
            }
            _ => {}
        }

        let mut h = self.h;
        h ^= h >> 13;
        h = h.wrapping_mul(M);
        h ^= h >> 15;
        h
    }
}

/// The fingerprint of bytes already in memory.
pub(crate) fn fingerprint_bytes(bytes: &[u8]) -> u32 {
    let normalized_len = bytes
        .iter()
        .filter(|&&byte| !is_ignored_whitespace(byte))
        .count() as u32;

    let mut hasher = NormalizedMurmur2::new(normalized_len);
    hasher.update(bytes);
    hasher.finalize()
}

/// The fingerprint of a file, streamed in 128 KiB reads in two passes (the
/// first counts normalized bytes, the second hashes), refusing files larger
/// than `limit` bytes (raw size) with an io::Error of kind InvalidData.
pub(crate) fn fingerprint_file(path: &Path, limit: u64) -> io::Result<u32> {
    let mut file = File::open(path)?;

    if file.metadata()?.len() > limit {
        return Err(too_large_error(limit));
    }

    let mut buffer = vec![0u8; READ_CHUNK_SIZE];

    // First pass: normalize-count only. MurmurHash2 needs the normalized
    // length before hashing begins.
    let mut normalized_len: u64 = 0;
    let mut raw_len: u64 = 0;
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        raw_len = raw_len.saturating_add(read as u64);
        if raw_len > limit {
            return Err(too_large_error(limit));
        }
        normalized_len += buffer[..read]
            .iter()
            .filter(|&&byte| !is_ignored_whitespace(byte))
            .count() as u64;
    }

    file.seek(SeekFrom::Start(0))?;

    // Second pass: hash the same stream. `update` carries partial 4-byte
    // blocks, so block and whitespace-run boundaries between reads are safe.
    let mut hasher = NormalizedMurmur2::new(normalized_len as u32);
    let mut hashed: u64 = 0;
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hashed = hashed.saturating_add(read as u64);
        if hashed > limit {
            return Err(too_large_error(limit));
        }
        hasher.update(&buffer[..read]);
    }

    Ok(hasher.finalize())
}

fn too_large_error(limit: u64) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("file exceeds the fingerprint size limit of {limit} bytes"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::ErrorKind;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

    /// A uniquely named file under the system temp directory that removes
    /// itself on drop (including when a test panics).
    struct TempFile {
        path: PathBuf,
    }

    impl TempFile {
        fn new(contents: &[u8]) -> Self {
            let unique = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let name = format!(
                "voxelight_cf_fingerprint_{}_{}_{}.bin",
                std::process::id(),
                nanos,
                unique
            );
            // In the crate's tests, write under target/ (the test binary may run
            // at a low integrity level that cannot write to %TEMP%).
            let directory = option_env!("CARGO_MANIFEST_DIR")
                .map(|root| Path::new(root).join("target").join("fingerprint-tests"))
                .unwrap_or_else(std::env::temp_dir);
            fs::create_dir_all(&directory).expect("create the temporary fingerprint folder");
            let path = directory.join(name);
            fs::write(&path, contents).expect("write temporary fingerprint file");
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TempFile {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.path);
        }
    }

    /// Small deterministic xorshift32 generator; no external crates.
    fn pseudo_random_bytes(len: usize, seed: u32) -> Vec<u8> {
        let mut state = seed | 1;
        let mut bytes = Vec::with_capacity(len);
        for _ in 0..len {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            bytes.push((state >> 16) as u8);
        }
        bytes
    }

    fn assert_streaming_matches(data: &[u8]) {
        let file = TempFile::new(data);
        let expected = fingerprint_bytes(data);
        let actual = fingerprint_file(file.path(), data.len() as u64)
            .expect("fingerprint a temporary file within the limit");
        assert_eq!(
            actual,
            expected,
            "streaming mismatch for {} bytes",
            data.len()
        );
    }

    #[test]
    fn whitespace_is_ignored() {
        let base = b"CurseForge fingerprint test 0123456789 abcdefghijklmnopqrstuvwxyz";
        let expected = fingerprint_bytes(base);

        for &whitespace in &[b'\t', b'\n', b'\r', b' '] {
            let mut decorated = Vec::with_capacity(base.len() * 3 + 7);
            decorated.push(whitespace);
            decorated.push(whitespace);
            for &byte in base {
                decorated.push(byte);
                decorated.push(whitespace);
                decorated.push(whitespace);
            }
            decorated.extend_from_slice(&[whitespace; 7]);
            assert_eq!(fingerprint_bytes(&decorated), expected);
        }

        // Mixed whitespace, including runs that span block boundaries and a
        // trailing run, must also disappear.
        let mut mixed = Vec::new();
        for (index, &byte) in base.iter().enumerate() {
            match index % 5 {
                0 => mixed.extend_from_slice(b" \t"),
                1 => mixed.push(b'\n'),
                2 => mixed.extend_from_slice(b"\r\n"),
                3 => mixed.push(b' '),
                _ => {}
            }
            mixed.push(byte);
        }
        mixed.extend_from_slice(b"\t\r\n ");
        assert_eq!(fingerprint_bytes(&mixed), expected);

        // Whitespace-only input is equivalent to empty input.
        assert_eq!(
            fingerprint_bytes(b" \t\r\n\t\r\n "),
            fingerprint_bytes(b"")
        );
    }

    #[test]
    fn streaming_matches_in_memory() {
        for len in 0..=9 {
            let data = pseudo_random_bytes(len, 0x9e37_79b9 ^ len as u32);
            assert_streaming_matches(&data);
        }

        let sizes = [
            131_068, 131_069, 131_070, 131_071, 131_072, 131_073, 131_074, 131_075,
            131_076, 262_140, 262_142, 262_143, 262_144, 262_145, 262_146, 262_148,
        ];
        for &len in &sizes {
            let data = pseudo_random_bytes(len, 0x85eb_ca6b ^ len as u32);
            assert_streaming_matches(&data);
        }
    }

    #[test]
    fn streaming_handles_boundaries_between_reads() {
        let boundary = READ_CHUNK_SIZE;

        // One leading whitespace byte shifts retained block alignment by one,
        // so a four-byte block spans the first 128 KiB read boundary.
        let mut shifted_blocks = vec![b'a'; boundary + 16];
        shifted_blocks[0] = b' ';
        assert_streaming_matches(&shifted_blocks);

        // A whitespace run that starts before the boundary and ends after it.
        let mut straddling_run = pseudo_random_bytes(boundary + 32, 0x1234_5678);
        for byte in &mut straddling_run[boundary - 7..boundary + 9] {
            *byte = b'\n';
        }
        assert_streaming_matches(&straddling_run);

        // The same shifted alignment across the second 128 KiB boundary.
        let mut shifted_blocks_two_reads = vec![b'b'; 2 * boundary + 16];
        shifted_blocks_two_reads[0] = b'\r';
        assert_streaming_matches(&shifted_blocks_two_reads);
    }

    #[test]
    fn file_larger_than_limit_is_refused() {
        let data = pseudo_random_bytes(1025, 0xdead_beef);
        let file = TempFile::new(&data);

        let error = fingerprint_file(file.path(), 1024)
            .expect_err("a file larger than the limit must be refused");
        assert_eq!(error.kind(), ErrorKind::InvalidData);

        // Exactly at the limit is accepted and hashes normally.
        assert_eq!(
            fingerprint_file(file.path(), 1025).unwrap(),
            fingerprint_bytes(&data)
        );

        // The limit applies to the raw size even if normalization would make
        // the file small.
        let whitespace = TempFile::new(&vec![b' '; 1025]);
        let error = fingerprint_file(whitespace.path(), 1024)
            .expect_err("the raw size, not the normalized size, must be limited");
        assert_eq!(error.kind(), ErrorKind::InvalidData);

        // A zero-byte file is not larger than a zero-byte limit.
        let empty = TempFile::new(b"");
        assert_eq!(
            fingerprint_file(empty.path(), 0).unwrap(),
            fingerprint_bytes(b"")
        );
    }

    #[test]
    fn known_answers_match_an_independent_reference() {
        // Computed by a separate MurmurHash2 (seed 1) implementation over the
        // whitespace-stripped bytes.
        let sequence: Vec<u8> = (0..1000u32).map(|i| ((i * 7 + 3) % 256) as u8).collect();
        for (input, expected) in [
            (&b"a"[..], 626_045_324u32),
            (b"hello", 2_788_266_382),
            (b"hello world", 2_824_650_221),
            (b"abcdefgh", 1_080_400_154),
            (&sequence[..], 3_769_720_441),
        ] {
            assert_eq!(fingerprint_bytes(input), expected);
        }
    }

    #[test]
    fn empty_known_answer() {
        // MurmurHash2 with seed 1 and empty input:
        //   h = 1 ^ 0 = 1
        //   h ^= h >> 13      -> 1
        //   h *= 0x5bd1e995   -> 0x5bd1e995
        //   h ^= h >> 15      -> 0x5bd15e36 = 1540447798
        assert_eq!(fingerprint_bytes(b""), 1_540_447_798);
    }
}
