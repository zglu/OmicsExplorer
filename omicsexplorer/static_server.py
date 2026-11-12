"""A small static server **with HTTP range support**.

``python3 -m http.server`` ignores the ``Range`` header, and the expression
blob is read gene by gene with a range request - without range support the
gene panel stays empty.  This module is the same trick the ``nematode-atlas``
project uses, and it is what ``omicsexplorer serve-static`` runs.

It is meant for testing an exported bundle locally; for production use any
real web server (nginx, Caddy, GitHub Pages, ...).
"""

from __future__ import annotations

import argparse
import os
import re
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

__all__ = ["RangeRequestHandler", "make_server", "serve"]

_RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")


class RangeRequestHandler(SimpleHTTPRequestHandler):
    """A ``SimpleHTTPRequestHandler`` that understands ``Range: bytes=...``."""

    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".json": "application/json",
        ".parquet": "application/vnd.apache.parquet",
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".gz": "application/gzip",
    }

    def end_headers(self):
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def send_head(self):
        range_header = self.headers.get("Range")
        if not range_header:
            return super().send_head()

        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()
        try:
            with open(path, "rb") as fh:
                fh.seek(0, os.SEEK_END)
                size = fh.tell()
                fh.seek(0)
                data = fh.read()
        except OSError:
            self.send_error(404, "File not found")
            return None

        m = _RANGE_RE.match(range_header.strip())
        if not m:
            self.send_error(416, "Invalid Range")
            return None
        start_s, end_s = m.groups()
        if start_s:
            start = int(start_s)
            end = int(end_s) if end_s else size - 1
        else:  # suffix range: the last N bytes
            length = int(end_s or 0)
            start = max(0, size - length)
            end = size - 1
        if start >= size or start > end:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            return None
        end = min(end, size - 1)
        chunk = data[start : end + 1]

        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(len(chunk)))
        self.end_headers()
        return _BytesReader(chunk)

    def log_message(self, fmt, *args):  # pragma: no cover - quieter output
        if os.environ.get("OMICSEXPLORER_QUIET"):
            return
        super().log_message(fmt, *args)


class _BytesReader:
    """A minimal file-like object over a bytes buffer."""

    def __init__(self, data: bytes):
        self._data = data
        self._pos = 0

    def read(self, size=-1):
        if size is None or size < 0:
            chunk = self._data[self._pos :]
            self._pos = len(self._data)
            return chunk
        chunk = self._data[self._pos : self._pos + size]
        self._pos += len(chunk)
        return chunk

    def close(self):
        self._pos = len(self._data)


def make_server(directory: Path, host: str = "127.0.0.1", port: int = 8080) -> ThreadingHTTPServer:
    handler = partial(RangeRequestHandler, directory=str(directory))
    return ThreadingHTTPServer((host, port), handler)


def serve(directory: Path, host: str = "127.0.0.1", port: int = 8080) -> None:
    directory = Path(directory).resolve()
    if not directory.exists():
        raise FileNotFoundError(f"{directory} does not exist")
    httpd = make_server(directory, host, port)
    print(f"serving {directory} on http://{host}:{port} (range requests enabled)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print()
    finally:
        httpd.server_close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-d", "--dir", default=".", help="directory to serve")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args(argv)
    serve(Path(args.dir), args.host, args.port)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
