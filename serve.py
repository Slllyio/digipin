"""
Local dev server with HTTP Range request support (required for PMTiles).

Python's built-in http.server doesn't support Range requests, which PMTiles
needs to fetch individual tile byte ranges from the archive.

Usage:
    python serve.py          # default port 8080
    python serve.py 3000     # custom port
    python serve.py 8000 --quiet   # no per-request log lines (CI)
    python serve.py 8000 --gzip    # gzip text responses, like GitHub Pages does
                                   # (for first-load measurements on a shaped link)
"""

import gzip
import io
import os
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


GZIP_TYPES = ("text/", "application/javascript", "application/json", "image/svg+xml", "application/manifest+json")


class RangeHTTPRequestHandler(SimpleHTTPRequestHandler):
    """HTTP handler with Range request support for PMTiles."""

    gzip_text = False   # set by --gzip; see send_gzipped()

    def send_head(self):
        path = self.translate_path(self.path)

        if not os.path.isfile(path):
            return super().send_head()

        # Check for Range header
        range_header = self.headers.get("Range")
        if not range_header:
            if self.gzip_text and "gzip" in (self.headers.get("Accept-Encoding") or ""):
                gz = self.send_gzipped(path)
                if gz is not None:
                    return gz
            return super().send_head()

        # Parse Range: bytes=start-end
        try:
            range_spec = range_header.replace("bytes=", "")
            parts = range_spec.split("-")
            file_size = os.path.getsize(path)

            start = int(parts[0]) if parts[0] else 0
            end = int(parts[1]) if parts[1] else file_size - 1
            end = min(end, file_size - 1)
            length = end - start + 1

            f = open(path, "rb")
            f.seek(start)

            self.send_response(206)
            ctype = self.guess_type(path)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
            self.send_header("Content-Length", str(length))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()

            return f
        except (ValueError, IOError):
            return super().send_head()

    def send_gzipped(self, path):
        """Whole-file gzip for text types (what the production host does), so a
        shaped-link measurement sees production byte counts. None = not text."""
        ctype = self.guess_type(path)
        if not ctype.startswith(GZIP_TYPES):
            return None
        with open(path, "rb") as f:
            raw = f.read()
        body = gzip.compress(raw, compresslevel=6)
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Vary", "Accept-Encoding")
        self.end_headers()
        return io.BytesIO(body)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Range")
        self.end_headers()

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length")
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()


class QuietRangeHTTPRequestHandler(RangeHTTPRequestHandler):
    """Same server, no per-request log line (CI: a browser run makes ~30k)."""

    def log_message(self, format, *args):  # noqa: A002 - stdlib signature
        pass

    def copyfile(self, source, outputfile):
        # A browser test that aborts or navigates away mid-transfer closes the
        # socket; the stdlib would print a full traceback for each one.
        try:
            super().copyfile(source, outputfile)
        except (BrokenPipeError, ConnectionResetError):
            pass


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    quiet = '--quiet' in sys.argv[1:]
    port = int(args[0]) if args else 8080
    directory = os.path.dirname(os.path.abspath(__file__))

    cls = QuietRangeHTTPRequestHandler if quiet else RangeHTTPRequestHandler
    cls.gzip_text = '--gzip' in sys.argv[1:]
    handler = partial(cls, directory=directory)
    # ThreadingHTTPServer so 35 defer-loaded scripts can fetch in parallel
    # without bottlenecking on the single-threaded HTTPServer (the
    # bottleneck became visible after PR #22 added `defer` to all script
    # tags, which causes a request storm at parse time).
    server = ThreadingHTTPServer(("0.0.0.0", port), handler)

    print(f"Serving {directory} on http://localhost:{port}")
    print(f"Range requests enabled (PMTiles compatible)")
    print("Press Ctrl+C to stop")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
        server.server_close()


if __name__ == "__main__":
    main()
