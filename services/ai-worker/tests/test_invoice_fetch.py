"""Secure fetch (PT15): private IP, redirect, DNS rebinding, oversize and file bombs blocked."""

from __future__ import annotations

import gzip
import http.server
import io
import ipaddress
import socket
import ssl
import struct
import time
import zipfile
import zlib
from collections.abc import Callable

import pytest

from invoice_fixtures import PUBLIC_V4, PUBLIC_V4_B, PUBLIC_V6, Rig, invoice_xml, send, serve
from tpa_ai_worker.invoice.fetch import FetchError, fetch_invoice_xml, system_resolver, tls_context
from tpa_ai_worker.invoice.limits import FetchLimits, FetchPolicy

HOST = "invoice.example.vn"
OTHER = "lookup.example.vn"
URL = f"https://{HOST}/tra-cuu?ma=SYNTH-SECRET-CODE"
XML = invoice_xml()
LIMITS = FetchLimits(
    max_fetch_bytes=256 * 1024,
    max_decompressed_bytes=512 * 1024,
    total_timeout_s=2.0,
    socket_timeout_s=1.0,
)
POLICY = FetchPolicy(allowed_hosts=frozenset({HOST, OTHER}), limits=LIMITS)

H = http.server.BaseHTTPRequestHandler


def ok(body: bytes = XML, **kw: object) -> Callable[[H], None]:
    return lambda h: send(h, body, **kw)  # type: ignore[arg-type]


def redirect(location: str, status: int = 302) -> Callable[[H], None]:
    return lambda h: send(h, b"", status=status, headers={"Location": location})


def fetch(rig: Rig, url: str = URL, policy: FetchPolicy = POLICY) -> bytes:
    return fetch_invoice_xml(url, policy, resolver=rig.resolver, connector=rig.connector).content


def code_of(rig: Rig, url: str = URL, policy: FetchPolicy = POLICY) -> str:
    with pytest.raises(FetchError) as exc:
        fetch(rig, url, policy)
    assert "SYNTH-SECRET" not in str(exc.value)  # errors never echo the URL
    return exc.value.code


def test_allowlisted_public_host_is_fetched_via_pinned_ip() -> None:
    with serve({"/tra-cuu": ok()}) as rig:
        doc = fetch_invoice_xml(URL, POLICY, resolver=rig.resolver, connector=rig.connector)
    assert doc.content == XML
    assert doc.source == f"https://{HOST}" and doc.redirects == 0
    assert rig.connected == [(HOST, PUBLIC_V4, 443)]
    assert rig.host_headers == [HOST]


def test_empty_allowlist_refuses_before_dns() -> None:
    with serve({"/tra-cuu": ok()}) as rig:
        assert code_of(rig, policy=FetchPolicy(limits=LIMITS)) == "ALLOWLIST_EMPTY"
    assert rig.resolved == [] and rig.connected == []


@pytest.mark.parametrize(
    "internal",
    ["127.0.0.1", "10.1.2.3", "192.168.0.10", "169.254.169.254", "100.100.100.200", "::1", "fd00:ec2::254",
     "::ffff:127.0.0.1", "64:ff9b::a9fe:a9fe"],
)  # fmt: skip
def test_host_resolving_to_internal_address_is_never_connected(internal: str) -> None:
    with serve({"/tra-cuu": ok()}) as rig:
        rig.dns[HOST] = [[ipaddress.ip_address(internal)]]
        assert code_of(rig) == "DESTINATION_NOT_PUBLIC"
    assert rig.connected == []


def test_mixed_public_and_private_answers_are_refused() -> None:
    with serve({"/tra-cuu": ok()}) as rig:
        rig.dns[HOST] = [[PUBLIC_V4, PUBLIC_V6, ipaddress.ip_address("10.0.0.7")]]
        assert code_of(rig) == "DESTINATION_NOT_PUBLIC"
    assert rig.connected == []


def test_dns_rebinding_cannot_swap_the_destination_after_the_check() -> None:
    """DNS answers public first, then loopback. The connection uses the checked IP and DNS is asked only once."""
    with serve({"/tra-cuu": ok()}) as rig:
        rig.dns[HOST] = [[PUBLIC_V4_B], [ipaddress.ip_address("127.0.0.1")]]
        assert fetch(rig) == XML
    assert rig.resolved == [HOST]
    assert rig.connected == [(HOST, PUBLIC_V4_B, 443)]


def test_rebinding_on_a_redirect_hop_is_caught_by_revalidation() -> None:
    with serve({"/tra-cuu": redirect(f"https://{HOST}/step2"), "/step2": ok()}) as rig:
        rig.dns[HOST] = [[PUBLIC_V4], [ipaddress.ip_address("169.254.169.254")]]
        assert code_of(rig) == "DESTINATION_NOT_PUBLIC"
    assert rig.resolved == [HOST, HOST]
    assert [c[1] for c in rig.connected] == [PUBLIC_V4]


def test_redirect_to_other_allowlisted_host_is_revalidated_and_followed() -> None:
    with serve({"/tra-cuu": redirect(f"https://{OTHER}/xml"), "/xml": ok()}) as rig:
        rig.dns[OTHER] = [[PUBLIC_V6]]
        doc = fetch_invoice_xml(URL, POLICY, resolver=rig.resolver, connector=rig.connector)
    assert doc.content == XML and doc.source == f"https://{OTHER}" and doc.redirects == 1
    assert rig.connected == [(HOST, PUBLIC_V4, 443), (OTHER, PUBLIC_V6, 443)]
    assert rig.host_headers == [HOST, OTHER]


def test_relative_redirect_is_resolved_against_current_host() -> None:
    with serve({"/tra-cuu": redirect("/xml", 307), "/xml": ok()}) as rig:
        assert fetch(rig) == XML
    assert [c[0] for c in rig.connected] == [HOST, HOST]


@pytest.mark.parametrize(
    ("location", "code"),
    [
        ("https://evil.example.com/x", "HOST_NOT_ALLOWED"),
        ("http://invoice.example.vn/x", "SCHEME_NOT_HTTPS"),
        ("https://127.0.0.1/x", "HOST_IP_LITERAL"),
        ("https://169.254.169.254/latest/meta-data/", "HOST_IP_LITERAL"),
        ("https://[::ffff:a9fe:a9fe]/x", "HOST_IP_LITERAL"),
        ("https://invoice.example.vn:8080/x", "PORT_NOT_ALLOWED"),
        ("file:///etc/passwd", "SCHEME_NOT_HTTPS"),
        ("//evil.example.com/x", "HOST_NOT_ALLOWED"),
    ],
)
def test_redirect_to_disallowed_target_is_blocked(location: str, code: str) -> None:
    with serve({"/tra-cuu": redirect(location)}) as rig:
        assert code_of(rig) == code
    assert len(rig.connected) == 1  # only the first, allowed hop


def test_redirect_loop_is_bounded() -> None:
    with serve({"/tra-cuu": redirect("/tra-cuu")}) as rig:
        assert code_of(rig) == "TOO_MANY_REDIRECTS"
    assert len(rig.connected) == LIMITS.max_redirects + 1


def test_redirect_without_location_and_error_status_fail() -> None:
    with serve({"/tra-cuu": lambda h: send(h, b"", status=302)}) as rig:
        assert code_of(rig) == "REDIRECT_WITHOUT_LOCATION"
    with serve({"/tra-cuu": ok(b"oops", status=500)}) as rig:
        assert code_of(rig) == "HTTP_STATUS"


def test_declared_oversize_body_is_refused_before_reading() -> None:
    def huge(h: H) -> None:
        h.send_response(200)
        h.send_header("Content-Length", str(LIMITS.max_fetch_bytes + 1))
        h.end_headers()

    with serve({"/tra-cuu": huge}) as rig:
        assert code_of(rig) == "RESPONSE_TOO_LARGE"


def test_streamed_oversize_body_without_length_is_cut_off() -> None:
    def stream(h: H) -> None:
        h.send_response(200)
        h.send_header("Transfer-Encoding", "chunked")
        h.end_headers()
        chunk = b"A" * 32768
        for _ in range(64):  # 2 MiB total, far above the 256 KiB cap
            h.wfile.write(b"%x\r\n%s\r\n" % (len(chunk), chunk))
        h.wfile.write(b"0\r\n\r\n")

    with serve({"/tra-cuu": stream}) as rig:
        assert code_of(rig) == "RESPONSE_TOO_LARGE"


def test_gzip_bomb_is_refused() -> None:
    bomb = gzip.compress(b"\0" * (20 * 1024 * 1024))  # ~20 KiB on the wire, 20 MiB inflated
    assert len(bomb) < LIMITS.max_fetch_bytes
    with serve({"/tra-cuu": ok(bomb, headers={"Content-Encoding": "gzip"})}) as rig:
        assert code_of(rig) == "DECOMPRESSED_TOO_LARGE"


def test_high_ratio_gzip_below_size_cap_is_refused() -> None:
    body = gzip.compress(b"<x>" + b"\0" * 200_000 + b"</x>")
    with serve({"/tra-cuu": ok(body, headers={"Content-Encoding": "gzip"})}) as rig:
        assert code_of(rig) == "DECOMPRESSION_RATIO"


def test_legitimate_gzip_and_deflate_are_decoded() -> None:
    with serve({"/tra-cuu": ok(gzip.compress(XML), headers={"Content-Encoding": "gzip"})}) as rig:
        assert fetch(rig) == XML
    with serve({"/tra-cuu": ok(zlib.compress(XML), headers={"Content-Encoding": "deflate"})}) as rig:
        assert fetch(rig) == XML


def test_corrupt_or_unknown_encoding_is_refused() -> None:
    with serve({"/tra-cuu": ok(b"not gzip", headers={"Content-Encoding": "gzip"})}) as rig:
        assert code_of(rig) == "DECOMPRESS_INVALID"
    with serve({"/tra-cuu": ok(XML, headers={"Content-Encoding": "br"})}) as rig:
        assert code_of(rig) == "ENCODING_UNSUPPORTED"


def _zip(members: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name, data in members.items():
            zf.writestr(name, data)
    return buf.getvalue()


def test_zip_with_single_xml_member_is_unwrapped() -> None:
    with serve({"/tra-cuu": ok(_zip({"invoice.xml": XML, "readme.txt": b"synthetic"}))}) as rig:
        assert fetch(rig) == XML


def test_zip_bomb_is_refused() -> None:
    bomb = _zip({"invoice.xml": b"\0" * (20 * 1024 * 1024)})
    assert len(bomb) < LIMITS.max_fetch_bytes
    with serve({"/tra-cuu": ok(bomb)}) as rig:
        assert code_of(rig) == "DECOMPRESSED_TOO_LARGE"


def test_zip_with_lying_size_header_is_refused() -> None:
    """Central directory claims 64 bytes; the member actually inflates to 2 MiB."""
    real = 2 * 1024 * 1024
    data = bytearray(_zip({"invoice.xml": b"\0" * real}))
    packed_real = struct.pack("<I", real)
    for offset in [i for i in range(len(data) - 3) if data[i : i + 4] == packed_real]:
        data[offset : offset + 4] = struct.pack("<I", 64)
    with serve({"/tra-cuu": ok(bytes(data))}) as rig:
        assert code_of(rig) in {"ARCHIVE_INVALID", "DECOMPRESSED_TOO_LARGE", "DECOMPRESSION_RATIO"}


@pytest.mark.parametrize(
    ("members", "code"),
    [
        ({"a.xml": XML, "b.xml": XML}, "ARCHIVE_XML_MEMBER_COUNT"),
        ({"a.txt": XML}, "ARCHIVE_XML_MEMBER_COUNT"),
        ({f"f{i}.txt": b"x" for i in range(40)} | {"a.xml": XML}, "ARCHIVE_TOO_MANY_ENTRIES"),
    ],
)
def test_unexpected_zip_layouts_are_refused(members: dict[str, bytes], code: str) -> None:
    with serve({"/tra-cuu": ok(_zip(members))}) as rig:
        assert code_of(rig) == code


def test_truncated_zip_is_refused() -> None:
    with serve({"/tra-cuu": ok(b"PK\x03\x04" + b"\0" * 40)}) as rig:
        assert code_of(rig) == "ARCHIVE_INVALID"


def test_slow_drip_server_hits_total_deadline() -> None:
    def drip(h: H) -> None:
        h.send_response(200)
        h.send_header("Content-Length", "100000")
        h.end_headers()
        for _ in range(100):
            h.wfile.write(b"<")
            h.wfile.flush()
            time.sleep(0.1)

    policy = FetchPolicy(
        allowed_hosts=POLICY.allowed_hosts,
        limits=FetchLimits(total_timeout_s=0.8, socket_timeout_s=0.5),
    )
    started = time.monotonic()
    with serve({"/tra-cuu": drip}) as rig:
        assert code_of(rig, policy=policy) == "TIMEOUT"
    assert time.monotonic() - started < 3.0


def test_silent_server_hits_socket_timeout() -> None:
    def silent(h: H) -> None:
        time.sleep(1.5)

    policy = FetchPolicy(
        allowed_hosts=POLICY.allowed_hosts,
        limits=FetchLimits(total_timeout_s=5.0, socket_timeout_s=0.3),
    )
    with serve({"/tra-cuu": silent}) as rig:
        assert code_of(rig, policy=policy) == "TIMEOUT"


def test_default_tls_context_verifies_certificate_and_hostname() -> None:
    ctx = tls_context()
    assert ctx.verify_mode == ssl.CERT_REQUIRED
    assert ctx.check_hostname is True
    assert ctx.minimum_version >= ssl.TLSVersion.TLSv1_2


def test_system_resolver_result_is_checked_and_never_connected(monkeypatch: pytest.MonkeyPatch) -> None:
    """Real resolver path: getaddrinfo answers loopback; no socket is ever opened."""

    def fake_getaddrinfo(host: str, port: int, *args: object, **kwargs: object) -> list[tuple[object, ...]]:
        assert host == HOST and port == 443
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))]

    def no_connect(*_: object, **__: object) -> None:
        raise AssertionError("connection attempted")

    monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)
    monkeypatch.setattr(socket, "create_connection", no_connect)
    with pytest.raises(FetchError) as exc:
        fetch_invoice_xml(URL, POLICY)
    assert exc.value.code == "DESTINATION_NOT_PUBLIC"


def test_system_resolver_parses_and_dedupes(monkeypatch: pytest.MonkeyPatch) -> None:
    answers = [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", 443)),
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", 443)),
        (socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("2606:4700:4700::1111", 443, 0, 0)),
    ]
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: answers)
    assert system_resolver(HOST, 1.0) == [PUBLIC_V4, PUBLIC_V6]

    def fail(*_: object, **__: object) -> None:
        raise socket.gaierror("synthetic")

    monkeypatch.setattr(socket, "getaddrinfo", fail)
    with pytest.raises(FetchError) as exc:
        system_resolver(HOST, 1.0)
    assert exc.value.code == "DNS_FAILED"
