//! Memory-bounded streaming for SQL dump imports.
//!
//! The old importer read the whole `.sql` file, decoded it, and split it into a
//! `Vec<String>` of every statement — ~3× the file size resident before a
//! single statement ran, which OOMs on multi-GB dumps. This module streams the
//! file instead: a fixed-size `BufReader` chunk → an `encoding_rs` *streaming*
//! decoder → an incremental [`Splitter`] that yields one statement at a time,
//! holding only the current in-progress statement. Resident memory is bounded by
//! the largest single statement, not the file.
//!
//! [`Splitter`] is a stateful port of [`crate::db::split_statements`]; its output
//! is asserted identical to that reference in the tests below.

use std::io::{self, BufReader, Read};

const CHUNK: usize = 64 * 1024;

/// Scan state carried across incremental feeds. Each variant mirrors a point in
/// the whole-string scan of `split_statements` where the next byte's meaning
/// depends on state that may straddle a chunk boundary.
#[derive(Clone, Copy)]
enum Scan {
    Normal,
    /// Saw `-` at top level; a second `-` starts a line comment.
    Dash,
    /// Saw `/` at top level; a following `*` starts a block comment.
    Slash,
    /// Inside a `--`/`#` line comment (until `\n`).
    LineComment,
    /// Inside a `/* … */` block comment.
    BlockComment,
    /// Inside a block comment, saw `*`; a following `/` closes it.
    BlockStar,
    /// Inside a `'`/`"`/`` ` `` quoted string (the quote byte).
    Quote(u8),
    /// Inside a quote, saw `\`; the next byte is consumed literally.
    QuoteEsc(u8),
    /// Inside a quote, saw the quote byte; a repeat is a doubled escape,
    /// anything else closes the quote.
    QuoteClose(u8),
}

/// Incremental SQL statement splitter. Feed decoded text with [`feed`], pull
/// finished statements with [`pop`], and call [`finish`] at EOF to flush the
/// trailing statement. Semantics match [`crate::db::split_statements`] exactly:
/// splits on top-level `;`, ignores `;` inside `'`/`"`/`` ` `` (with `\` escapes
/// and doubled-quote escapes) and inside `-- `/`#`/`/* */` comments, trims each
/// statement and drops empties, and keeps interior comments attached. DELIMITER
/// blocks are not handled (same limitation as the reference).
///
/// [`feed`]: Splitter::feed
/// [`pop`]: Splitter::pop
/// [`finish`]: Splitter::finish
pub(crate) struct Splitter {
    /// Undelivered decoded text: the current in-progress statement plus any
    /// not-yet-scanned tail. The already-emitted prefix is drained on refill.
    pending: String,
    /// Byte offset in `pending` where the current statement begins.
    start: usize,
    /// Scan cursor; never rewinds, so total work is O(bytes).
    pos: usize,
    state: Scan,
    ready: std::collections::VecDeque<String>,
    finished: bool,
}

impl Splitter {
    pub(crate) fn new() -> Self {
        Splitter {
            pending: String::new(),
            start: 0,
            pos: 0,
            state: Scan::Normal,
            ready: std::collections::VecDeque::new(),
            finished: false,
        }
    }

    /// Feed the next decoded chunk. Completed statements become available via
    /// [`pop`](Splitter::pop). `text` must be valid UTF-8 (the streaming decoder
    /// guarantees this — it never splits a multi-byte sequence across feeds).
    pub(crate) fn feed(&mut self, text: &str) {
        // Drop the already-emitted prefix so `pending` stays bounded by the
        // current statement, then rebase the cursors. `start` is always a char
        // boundary (0 or just past a `;`), so `drain` never panics.
        if self.start > 0 {
            self.pending.drain(..self.start);
            self.pos -= self.start;
            self.start = 0;
        }
        self.pending.push_str(text);
        self.scan();
    }

    fn scan(&mut self) {
        while self.pos < self.pending.len() {
            let c = self.pending.as_bytes()[self.pos];
            match self.state {
                Scan::Normal => match c {
                    b'-' => {
                        self.state = Scan::Dash;
                        self.pos += 1;
                    }
                    b'#' => {
                        self.state = Scan::LineComment;
                        self.pos += 1;
                    }
                    b'/' => {
                        self.state = Scan::Slash;
                        self.pos += 1;
                    }
                    b'\'' | b'"' | b'`' => {
                        self.state = Scan::Quote(c);
                        self.pos += 1;
                    }
                    b';' => {
                        let owned = self.pending[self.start..self.pos].trim().to_string();
                        if !owned.is_empty() {
                            self.ready.push_back(owned);
                        }
                        self.pos += 1;
                        self.start = self.pos;
                    }
                    _ => self.pos += 1,
                },
                // A lone `-`/`/` was a normal byte; the current byte still needs
                // Normal handling (it may itself be `;`, a quote, …), so return
                // to Normal WITHOUT advancing.
                Scan::Dash => {
                    if c == b'-' {
                        self.state = Scan::LineComment;
                        self.pos += 1;
                    } else {
                        self.state = Scan::Normal;
                    }
                }
                Scan::Slash => {
                    if c == b'*' {
                        self.state = Scan::BlockComment;
                        self.pos += 1;
                    } else {
                        self.state = Scan::Normal;
                    }
                }
                Scan::LineComment => {
                    if c == b'\n' {
                        self.state = Scan::Normal;
                    }
                    self.pos += 1;
                }
                Scan::BlockComment => {
                    if c == b'*' {
                        self.state = Scan::BlockStar;
                    }
                    self.pos += 1;
                }
                Scan::BlockStar => {
                    if c == b'/' {
                        self.state = Scan::Normal;
                    } else if c != b'*' {
                        self.state = Scan::BlockComment;
                    }
                    self.pos += 1;
                }
                Scan::Quote(q) => {
                    if c == b'\\' {
                        self.state = Scan::QuoteEsc(q);
                    } else if c == q {
                        self.state = Scan::QuoteClose(q);
                    }
                    self.pos += 1;
                }
                Scan::QuoteEsc(q) => {
                    self.state = Scan::Quote(q);
                    self.pos += 1;
                }
                Scan::QuoteClose(q) => {
                    if c == q {
                        // Doubled quote (`''`): still inside the string.
                        self.state = Scan::Quote(q);
                        self.pos += 1;
                    } else {
                        // Quote closed; reprocess the current byte in Normal.
                        self.state = Scan::Normal;
                    }
                }
            }
        }
    }

    pub(crate) fn pop(&mut self) -> Option<String> {
        self.ready.pop_front()
    }

    /// Flush the trailing statement at EOF (no terminating `;`). Idempotent.
    pub(crate) fn finish(&mut self) {
        if self.finished {
            return;
        }
        self.finished = true;
        let owned = self.pending[self.start..].trim().to_string();
        if !owned.is_empty() {
            self.ready.push_back(owned);
        }
    }
}

/// Streams `Result<String>` statements from a SQL dump: reads fixed chunks,
/// decodes them with `encoding_rs`' streaming decoder (handling multi-byte
/// sequences split across chunk boundaries, and BOM stripping, exactly like the
/// old whole-buffer `decode`), and splits incrementally. Tracks raw bytes
/// consumed for byte-based progress. Implements `Iterator`, so callers just
/// pull statements; the sqlite executor moves it into `spawn_blocking`.
pub(crate) struct SqlStatementReader<R: Read> {
    inner: R,
    decoder: encoding_rs::Decoder,
    splitter: Splitter,
    scratch: String,
    buf: Box<[u8; CHUNK]>,
    bytes_read: u64,
    done: bool,
}

impl SqlStatementReader<BufReader<std::fs::File>> {
    /// Open a dump file for streaming with the named encoding (`utf-8` default —
    /// same label handling as `db::decode_sql`).
    pub(crate) fn open(path: &str, encoding: Option<&str>) -> io::Result<Self> {
        let file = std::fs::File::open(path)?;
        Ok(Self::from_reader(BufReader::new(file), encoding))
    }
}

impl<R: Read> SqlStatementReader<R> {
    pub(crate) fn from_reader(inner: R, encoding: Option<&str>) -> Self {
        let enc = encoding
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .and_then(|l| encoding_rs::Encoding::for_label(l.as_bytes()))
            .unwrap_or(encoding_rs::UTF_8);
        SqlStatementReader {
            inner,
            decoder: enc.new_decoder(),
            splitter: Splitter::new(),
            scratch: String::new(),
            buf: Box::new([0u8; CHUNK]),
            bytes_read: 0,
            done: false,
        }
    }

    /// Raw file bytes consumed so far — drives the byte-based progress bar.
    pub(crate) fn bytes_read(&self) -> u64 {
        self.bytes_read
    }

    /// Decode `src` and feed the result to the splitter. `decode_to_string`
    /// writes into the String's *spare capacity* and reports `OutputFull` (0
    /// written) if there is none, so capacity must be reserved first; the loop
    /// is a safety net if a single reservation ever undershoots.
    fn decode_and_feed(&mut self, src: &[u8], last: bool) {
        let mut rest = src;
        loop {
            self.scratch.clear();
            let need = self
                .decoder
                .max_utf8_buffer_length(rest.len())
                .unwrap_or(rest.len().saturating_mul(4) + 16);
            self.scratch.reserve(need.max(16));
            let (result, read, _) = self.decoder.decode_to_string(rest, &mut self.scratch, last);
            self.splitter.feed(&self.scratch);
            match result {
                encoding_rs::CoderResult::InputEmpty => break,
                encoding_rs::CoderResult::OutputFull => {
                    if read == 0 {
                        break; // shouldn't happen after reserve(); guard against a spin
                    }
                    rest = &rest[read..];
                }
            }
        }
    }
}

impl<R: Read> Iterator for SqlStatementReader<R> {
    type Item = io::Result<String>;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            if let Some(s) = self.splitter.pop() {
                return Some(Ok(s));
            }
            if self.done {
                return None;
            }
            match self.inner.read(&mut self.buf[..]) {
                Err(e) => {
                    self.done = true;
                    return Some(Err(e));
                }
                Ok(0) => {
                    // EOF: flush the decoder's held partial sequence (if any),
                    // then flush the splitter's trailing statement.
                    self.decode_and_feed(&[], true);
                    self.splitter.finish();
                    self.done = true;
                }
                Ok(n) => {
                    self.bytes_read += n as u64;
                    // Copy out of `self.buf` so `decode_and_feed(&mut self, …)`
                    // isn't borrowing `self.buf` and `self` at once.
                    let chunk = self.buf[..n].to_vec();
                    self.decode_and_feed(&chunk, false);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::split_statements;

    /// Feed the splitter one char at a time (every char boundary is a feed
    /// boundary) to exercise every carried-state transition.
    fn charwise(sql: &str) -> Vec<String> {
        let mut sp = Splitter::new();
        let mut b = [0u8; 4];
        for ch in sql.chars() {
            sp.feed(ch.encode_utf8(&mut b));
        }
        sp.finish();
        let mut out = Vec::new();
        while let Some(s) = sp.pop() {
            out.push(s);
        }
        out
    }

    fn oneshot(sql: &str) -> Vec<String> {
        let mut sp = Splitter::new();
        sp.feed(sql);
        sp.finish();
        let mut out = Vec::new();
        while let Some(s) = sp.pop() {
            out.push(s);
        }
        out
    }

    /// The splitter (fed whole AND char-by-char) must equal the reference.
    fn assert_equiv(sql: &str) {
        let want = split_statements(sql);
        assert_eq!(oneshot(sql), want, "oneshot mismatch for {sql:?}");
        assert_eq!(charwise(sql), want, "charwise mismatch for {sql:?}");
    }

    #[test]
    fn equivalence_matrix() {
        let cases = [
            "",
            "   \n\t ",
            "SELECT 1",
            "SELECT 1;",
            "SELECT 1; SELECT 2",
            "SELECT 1;;;SELECT 2;",
            "SELECT ';' AS semi;",
            "SELECT 'a\\'b' FROM t;",             // backslash escape
            "SELECT 'a''b' FROM t;",              // doubled-quote escape
            "SELECT \"a;b\" FROM t;",             // double-quoted identifier
            "SELECT `a;b` FROM t;",               // backtick identifier
            "INSERT INTO t VALUES ('x;y', 'z');",
            "-- a; comment\nSELECT 1;",           // line comment with ;
            "# hash; comment\nSELECT 1;",         // hash comment
            "SELECT 1; -- trailing comment",      // comment attaches to stmt 2
            "/* block; comment */ SELECT 1;",
            "/*!40101 SET NAMES utf8 */;",        // conditional comment (kept)
            "SELECT 1 /* mid;stmt */ FROM t;",
            "SELECT '\\'; DROP TABLE x; -- ' AS still_in_string;",
            "a - b;",                             // lone dash, not a comment
            "a / b;",                             // lone slash, not a comment
            "SELECT 1 -;",                        // dash right before terminator
            "/* unterminated block comment",      // EOF inside block comment
            "SELECT 'unterminated string",        // EOF inside quote
            "SELECT 'ends with backslash\\",      // EOF after in-quote backslash
            "SELECT '**/;/**';",                  // stars/slashes inside a string
            "SELECT * FROM t WHERE x='don''t; go';",
            "café; SELECT 'naïve;';",             // multi-byte content
            "/**/;/**/;SELECT 1;",
        ];
        for c in cases {
            assert_equiv(c);
        }
    }

    #[test]
    fn giant_statement_single_yield() {
        // A statement far larger than one feed must come out whole, once.
        let big = format!("INSERT INTO t VALUES ({});", "1,".repeat(200_000));
        let out = oneshot(&big);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0], big.trim_end_matches(';'));
        assert_eq!(charwise(&big), out);
        assert_eq!(split_statements(&big), out);
    }

    #[test]
    fn reader_over_cursor_matches_reference() {
        let sql = "SELECT 1; INSERT INTO t VALUES ('a;b'); -- c\nSELECT 'x''y'; café;";
        let want = split_statements(sql);
        let reader =
            SqlStatementReader::from_reader(io::Cursor::new(sql.as_bytes().to_vec()), Some("utf-8"));
        let got: Vec<String> = reader.map(|r| r.unwrap()).collect();
        assert_eq!(got, want);
    }

    /// A `Read` that hands back a single byte per call — forces the streaming
    /// decoder to reassemble multi-byte chars split across reads.
    struct OneByte<R: Read>(R);
    impl<R: Read> Read for OneByte<R> {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            if buf.is_empty() {
                return Ok(0);
            }
            self.0.read(&mut buf[..1])
        }
    }

    #[test]
    fn reader_handles_multibyte_split_across_reads() {
        // UTF-8 multi-byte chars, one byte per read.
        let sql = "SELECT 'café;naïve;日本語' AS s; SELECT 2;";
        let want = split_statements(sql);
        let reader = SqlStatementReader::from_reader(
            OneByte(io::Cursor::new(sql.as_bytes().to_vec())),
            None,
        );
        let got: Vec<String> = reader.map(|r| r.unwrap()).collect();
        assert_eq!(got, want);

        // Non-UTF-8 (windows-1252): 0xE9 = 'é', decoded per-byte.
        let latin1 = b"SELECT 'caf\xE9' AS s; SELECT 2;";
        let reader2 = SqlStatementReader::from_reader(
            OneByte(io::Cursor::new(latin1.to_vec())),
            Some("windows-1252"),
        );
        let got2: Vec<String> = reader2.map(|r| r.unwrap()).collect();
        assert_eq!(got2, vec!["SELECT 'café' AS s".to_string(), "SELECT 2".to_string()]);
    }
}
