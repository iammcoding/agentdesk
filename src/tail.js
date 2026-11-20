/*
 * Follows a growing log file. It starts near the end (logs can be hundreds of MB), hands over
 * the recent lines as a backfill so the desk can draw where the agent is now, then polls for
 * new bytes. Polling (not fs.watch) because fs.watch misses appends on some systems.
 */
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const CHUNK = 1 << 20;

export class Tail {
  constructor(file, { onLine, onBackfillDone, backfillBytes = 1 << 20, interval = 400 } = {}) {
    this.file = file;
    this.onLine = onLine;
    this.onBackfillDone = onBackfillDone;
    this.backfillBytes = backfillBytes;
    this.interval = interval;
    this.offset = 0;
    this.rest = '';
    this.decoder = new StringDecoder('utf8');
    this.timer = null;
    this.stopped = false;
    this.reading = false;
  }

  start() {
    let size = 0;
    try { size = fs.statSync(this.file).size; } catch { /* not there yet */ }
    this.offset = Math.max(0, size - this.backfillBytes);
    const skipFirst = this.offset > 0; // we landed mid-line
    this.readTo(size, true, skipFirst);
    this.onBackfillDone && this.onBackfillDone();
    this.timer = setInterval(() => this.poll(), this.interval);
    if (this.timer.unref) this.timer.unref();
    return this;
  }

  poll() {
    if (this.stopped || this.reading) return;
    let size;
    try { size = fs.statSync(this.file).size; } catch { return; }
    if (size < this.offset) { this.offset = 0; this.rest = ''; this.decoder = new StringDecoder('utf8'); } // truncated or replaced
    if (size > this.offset) this.readTo(size, false, false);
  }

  readTo(size, replay, skipFirst) {
    this.reading = true;
    let fd;
    try {
      fd = fs.openSync(this.file, 'r');
      const buf = Buffer.alloc(Math.min(CHUNK, Math.max(1, size - this.offset)));
      let first = skipFirst;
      while (this.offset < size && !this.stopped) {
        const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - this.offset), this.offset);
        if (n <= 0) break;
        this.offset += n;
        const text = this.rest + this.decoder.write(buf.subarray(0, n));
        const lines = text.split('\n');
        this.rest = lines.pop();
        for (const line of lines) {
          if (first) { first = false; continue; }
          if (line.trim()) this.onLine(line, replay);
        }
      }
    } catch { /* file vanished mid-read: next poll retries */ }
    finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} this.reading = false; }
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }
}
