"""SSRF-hardened fetch of an e-invoice XML document from a QR lookup URL.

This is the only module in the worker allowed to open network connections.

Per hop (initial URL and every redirect):

1. ``validate_url`` (https:443, allowlisted host, no userinfo/IP literal).
2. Resolve the host **once** and require every address to be public.
3. Connect to that exact, already-checked IP (pinning). The host name is used
   only for TLS SNI, certificate verification and the ``Host`` header, so a
   DNS answer that changes between check and use (rebinding) cannot redirect
   the connection to an internal address.

Limits: total wall-clock deadline across all hops, per-operation socket
timeout, raw byte cap (checked against Content-Length and while streaming),
bounded gzip/deflate/zip decompression with size and ratio caps, and a
maximum number of redirects. Nothing is logged; error codes never contain the
URL, which may carry lookup secrets.
"""

from __future__ import annotations

import http.client
import io
import ipaddress
import socket
import ssl
import time
import zipfile
import zlib
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from dataclasses import dataclass
from urllib.parse import urljoin

from tpa_ai_worker.invoice.limits import FetchLimits, FetchPolicy
from tpa_ai_worker.invoice.urlpolicy import (
    IPAddress,
    UrlPolicyError,
    ValidatedUrl,
    check_resolved,
    validate_url,
)

# (host, timeout_s) -> resolved addresses, in resolver order.
Resolver = Callable[[str, float], list[IPAddress]]
# (host, pinned_ip, port, timeout_s) -> connected, TLS-wrapped socket.
Connector = Callable[[str, IPAddress, int, float], socket.socket]

_REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})
_READ_CHUNK = 64 * 1024
_ZIP_MAGIC = b"PK\x03\x04"


class FetchError(Exception):
    """Fetch refused or failed. ``code`` is stable and safe to log."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True, slots=True)
class FetchedDocument:
    content: bytes
    source: str  # final host only, e.g. "https://lookup.example.vn"
    redirects: int


def system_resolver(host: str, timeout_s: float) -> list[IPAddress]:
    """Resolve with the OS resolver, bounded by ``timeout_s``."""

    def _lookup() -> list[IPAddress]:
        infos = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP)
        found: list[IPAddress] = []
        for _family, _type, _proto, _canon, sockaddr in infos:
            ip = ipaddress.ip_address(str(sockaddr[0]))
            if ip not in found:
                found.append(ip)
        return found

    pool = ThreadPoolExecutor(max_workers=1)
    try:
        return pool.submit(_lookup).result(timeout=timeout_s)
    except FutureTimeout as exc:
        raise FetchError("DNS_TIMEOUT") from exc
    except OSError as exc:
        raise FetchError("DNS_FAILED") from exc
    finally:
        pool.shutdown(wait=False, cancel_futures=True)


def tls_context() -> ssl.SSLContext:
    ctx = ssl.create_default_context()  # CERT_REQUIRED + check_hostname
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    return ctx


def tls_connector(host: str, ip: IPAddress, port: int, timeout_s: float) -> socket.socket:
    """Connect to the pinned IP; verify the certificate against ``host``."""
    raw = socket.create_connection((str(ip), port), timeout=timeout_s)
    try:
        return tls_context().wrap_socket(raw, server_hostname=host)
    except BaseException:
        raw.close()
        raise


class _PinnedConnection(http.client.HTTPConnection):
    """HTTP/1.1 over a socket produced by the pinned connector."""

    def __init__(self, host: str, factory: Callable[[], socket.socket], timeout_s: float) -> None:
        super().__init__(host, 443, timeout=timeout_s)
        self._factory = factory

    def connect(self) -> None:
        self.sock = self._factory()


class _Deadline:
    def __init__(self, total_s: float, per_op_s: float) -> None:
        self._end = time.monotonic() + total_s
        self._per_op = per_op_s

    def op_timeout(self) -> float:
        remaining = self._end - time.monotonic()
        if remaining <= 0:
            raise FetchError("TIMEOUT")
        return min(remaining, self._per_op)


def fetch_invoice_xml(
    url: str,
    policy: FetchPolicy,
    *,
    resolver: Resolver = system_resolver,
    connector: Connector = tls_connector,
) -> FetchedDocument:
    limits = policy.limits
    if not policy.allowed_hosts:
        raise FetchError("ALLOWLIST_EMPTY")
    deadline = _Deadline(limits.total_timeout_s, limits.socket_timeout_s)
    current = url
    for hop in range(limits.max_redirects + 1):
        try:
            target = validate_url(current, policy.allowed_hosts, max_length=limits.max_url_length)
            addresses = resolver(target.host, deadline.op_timeout())
            pinned = check_resolved(addresses)
        except UrlPolicyError as exc:
            raise FetchError(exc.code) from exc
        status, location, body = _request_once(target, pinned, connector, deadline, limits)
        if status in _REDIRECT_STATUSES:
            if location is None:
                raise FetchError("REDIRECT_WITHOUT_LOCATION")
            current = urljoin(f"https://{target.host}{target.request_target}", location)
            continue
        if status != 200:
            raise FetchError("HTTP_STATUS")
        if body is None:
            raise FetchError("HTTP_PROTOCOL")
        return FetchedDocument(content=_unwrap_archive(body, limits), source=target.describe(), redirects=hop)
    raise FetchError("TOO_MANY_REDIRECTS")


def _request_once(
    target: ValidatedUrl,
    pinned: IPAddress,
    connector: Connector,
    deadline: _Deadline,
    limits: FetchLimits,
) -> tuple[int, str | None, bytes | None]:
    def _factory() -> socket.socket:
        return connector(target.host, pinned, target.port, deadline.op_timeout())

    conn = _PinnedConnection(target.host, _factory, deadline.op_timeout())
    try:
        conn.putrequest("GET", target.request_target, skip_host=True, skip_accept_encoding=True)
        conn.putheader("Host", target.host)
        conn.putheader("Accept", "application/xml, text/xml;q=0.9, application/zip;q=0.5")
        conn.putheader("Accept-Encoding", "identity")
        conn.putheader("User-Agent", "tpa-ai-worker")
        conn.putheader("Connection", "close")
        conn.endheaders()
        _set_timeout(conn, deadline)
        resp = conn.getresponse()
        if resp.status in _REDIRECT_STATUSES:
            return resp.status, resp.getheader("Location"), None
        if resp.status != 200:
            return resp.status, None, None
        encoding = (resp.getheader("Content-Encoding") or "identity").strip().lower()
        if resp.length is not None and resp.length > limits.max_fetch_bytes:
            raise FetchError("RESPONSE_TOO_LARGE")
        raw = _read_bounded(conn, resp, deadline, limits.max_fetch_bytes)
        return 200, None, _decode_content(raw, encoding, limits)
    except (TimeoutError, socket.timeout) as exc:
        raise FetchError("TIMEOUT") from exc
    except ssl.SSLError as exc:
        raise FetchError("TLS_FAILED") from exc
    except http.client.HTTPException as exc:
        raise FetchError("HTTP_PROTOCOL") from exc
    except OSError as exc:
        raise FetchError("CONNECT_FAILED") from exc
    finally:
        conn.close()


def _set_timeout(conn: http.client.HTTPConnection, deadline: _Deadline) -> None:
    if conn.sock is not None:
        conn.sock.settimeout(deadline.op_timeout())


def _read_bounded(
    conn: http.client.HTTPConnection,
    resp: http.client.HTTPResponse,
    deadline: _Deadline,
    max_bytes: int,
) -> bytes:
    buf = bytearray()
    while True:
        _set_timeout(conn, deadline)  # also enforces the total deadline (slow drip)
        # read1 returns after one underlying read, so a trickling server cannot
        # keep us blocked past the deadline inside a single large read().
        chunk = resp.read1(_READ_CHUNK)
        if not chunk:
            return bytes(buf)
        buf += chunk
        if len(buf) > max_bytes:
            raise FetchError("RESPONSE_TOO_LARGE")


def _bounded_inflate(data: bytes, wbits: int, limits: FetchLimits) -> bytes:
    inflater = zlib.decompressobj(wbits)
    try:
        out = inflater.decompress(data, limits.max_decompressed_bytes + 1)
    except zlib.error as exc:
        raise FetchError("DECOMPRESS_INVALID") from exc
    if len(out) > limits.max_decompressed_bytes or inflater.unconsumed_tail:
        raise FetchError("DECOMPRESSED_TOO_LARGE")
    if not inflater.eof or inflater.unused_data:
        raise FetchError("DECOMPRESS_INVALID")
    _check_ratio(len(out), len(data), limits)
    return out


def _check_ratio(expanded: int, compressed: int, limits: FetchLimits) -> None:
    if expanded > limits.max_decompression_ratio * max(compressed, 1):
        raise FetchError("DECOMPRESSION_RATIO")


def _decode_content(raw: bytes, encoding: str, limits: FetchLimits) -> bytes:
    if encoding == "identity":
        return raw
    if encoding in ("gzip", "x-gzip"):
        return _bounded_inflate(raw, 16 + zlib.MAX_WBITS, limits)
    if encoding == "deflate":
        return _bounded_inflate(raw, zlib.MAX_WBITS, limits)
    raise FetchError("ENCODING_UNSUPPORTED")


def _unwrap_archive(body: bytes, limits: FetchLimits) -> bytes:
    """If the body is a zip, return its single ``.xml`` member, bounded."""
    if not body.startswith(_ZIP_MAGIC):
        return body
    try:
        with zipfile.ZipFile(io.BytesIO(body)) as archive:
            infos = archive.infolist()
            if len(infos) > limits.max_zip_entries:
                raise FetchError("ARCHIVE_TOO_MANY_ENTRIES")
            members = [i for i in infos if not i.is_dir() and i.filename.lower().endswith(".xml")]
            if len(members) != 1:
                raise FetchError("ARCHIVE_XML_MEMBER_COUNT")
            info = members[0]
            if info.flag_bits & 0x1:
                raise FetchError("ARCHIVE_ENCRYPTED")
            if info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                raise FetchError("ARCHIVE_METHOD_UNSUPPORTED")
            if info.file_size > limits.max_decompressed_bytes:
                raise FetchError("DECOMPRESSED_TOO_LARGE")
            # Headers can lie: bound the actual decompressed read as well.
            with archive.open(info) as member:
                data = member.read(limits.max_decompressed_bytes + 1)
            if len(data) > limits.max_decompressed_bytes:
                raise FetchError("DECOMPRESSED_TOO_LARGE")
            _check_ratio(len(data), info.compress_size, limits)
            return data
    except (zipfile.BadZipFile, zlib.error, EOFError, NotImplementedError) as exc:
        raise FetchError("ARCHIVE_INVALID") from exc
