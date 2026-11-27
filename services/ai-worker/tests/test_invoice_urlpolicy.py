"""SSRF policy: URL shape, exact host allowlist and destination address checks (PT15)."""

from __future__ import annotations

import ipaddress

import pytest

from tpa_ai_worker.invoice.limits import ALLOWED_HOSTS_ENV, load_fetch_policy
from tpa_ai_worker.invoice.urlpolicy import (
    UrlPolicyError,
    check_resolved,
    is_public_address,
    normalize_allowlist_entry,
    validate_url,
)

ALLOW = frozenset({"invoice.example.vn", "xn--h-sfa.example.vn"})


def _code(url: str) -> str:
    with pytest.raises(UrlPolicyError) as exc:
        validate_url(url, ALLOW, max_length=2048)
    return exc.value.code


def test_allowlisted_https_url_is_accepted() -> None:
    v = validate_url("https://Invoice.Example.VN./tra-cuu?ma=SYNTH123", ALLOW, max_length=2048)
    assert (v.host, v.port, v.request_target) == ("invoice.example.vn", 443, "/tra-cuu?ma=SYNTH123")
    assert v.describe() == "https://invoice.example.vn"  # no path/query in provenance


def test_explicit_443_and_idna_host_are_accepted() -> None:
    assert validate_url("https://invoice.example.vn:443/", ALLOW, max_length=2048).host == "invoice.example.vn"
    assert validate_url("https://hà.example.vn/x", ALLOW, max_length=2048).host == "xn--h-sfa.example.vn"


@pytest.mark.parametrize(
    ("url", "code"),
    [
        ("http://invoice.example.vn/x", "SCHEME_NOT_HTTPS"),
        ("file:///etc/passwd", "SCHEME_NOT_HTTPS"),
        ("gopher://invoice.example.vn/x", "SCHEME_NOT_HTTPS"),
        ("ftp://invoice.example.vn/x", "SCHEME_NOT_HTTPS"),
        ("https://evil.example.com/x", "HOST_NOT_ALLOWED"),
        ("https://invoice.example.vn.evil.com/x", "HOST_NOT_ALLOWED"),
        ("https://sub.invoice.example.vn/x", "HOST_NOT_ALLOWED"),
        ("https://user:pw@invoice.example.vn/x", "URL_USERINFO"),
        ("https://invoice.example.vn@127.0.0.1/x", "URL_USERINFO"),
        ("https://invoice.example.vn:8443/x", "PORT_NOT_ALLOWED"),
        ("https://invoice.example.vn:0/x", "PORT_NOT_ALLOWED"),
        ("https://invoice.example.vn:99999/x", "URL_MALFORMED"),
        ("https://127.0.0.1/x", "HOST_IP_LITERAL"),
        ("https://169.254.169.254/latest/meta-data/", "HOST_IP_LITERAL"),
        ("https://[::1]/x", "HOST_IP_LITERAL"),
        ("https://[::ffff:127.0.0.1]/x", "HOST_IP_LITERAL"),
        ("https://2130706433/x", "HOST_INVALID"),
        ("https://0x7f.0x1/x", "HOST_IP_LITERAL"),
        ("https://127.1/x", "HOST_IP_LITERAL"),
        ("https://invoice.example.vn\\@127.0.0.1/x", "URL_FORBIDDEN_CHARACTER"),
        ("https://invoice.example.vn/x y", "URL_FORBIDDEN_CHARACTER"),
        ("https://invoice.example.vn/\r\nHost: evil", "URL_FORBIDDEN_CHARACTER"),
        ("https:///x", "HOST_MISSING"),
        ("https://localhost/x", "HOST_INVALID"),
        ("https://" + "a" * 2100 + ".vn/", "URL_TOO_LONG"),
    ],
)
def test_bad_urls_are_refused(url: str, code: str) -> None:
    assert _code(url) == code


def test_error_never_contains_the_url() -> None:
    with pytest.raises(UrlPolicyError) as exc:
        validate_url("https://evil.example.com/?token=SYNTH-SECRET", ALLOW, max_length=2048)
    assert "SYNTH-SECRET" not in str(exc.value)
    assert "evil" not in str(exc.value)


BLOCKED = [
    "10.0.0.1", "172.16.5.4", "192.168.1.1", "127.0.0.1", "127.255.255.254", "0.0.0.0",
    "169.254.169.254",  # AWS/GCP/Azure IMDS
    "100.100.100.200",  # Alibaba metadata (CGNAT range)
    "168.63.129.16",  # Azure WireServer (globally routable, explicitly denied)
    "192.0.0.192",  # OCI metadata
    "100.64.0.1", "224.0.0.1", "239.255.255.250", "255.255.255.255", "240.0.0.1",
    "192.0.2.10", "198.51.100.7", "203.0.113.9", "198.18.0.1",
    "::1", "::", "fe80::1", "fe80::1%2", "fc00::1", "fd00:ec2::254", "fec0::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:169.254.169.254", "::ffff:10.0.0.1", "::ffff:8.8.8.8",
    "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "64:ff9b:1::1",
    "2002:7f00:1::1", "2002:a9fe:a9fe::1",  # 6to4 embedding internal IPv4
    "2001:0:4136:e378:8000:63bf:3fff:fdd2",  # Teredo
    "2001:db8::1",
]  # fmt: skip


@pytest.mark.parametrize("address", BLOCKED)
def test_internal_and_special_addresses_are_not_public(address: str) -> None:
    assert not is_public_address(ipaddress.ip_address(address))


@pytest.mark.parametrize("address", ["1.1.1.1", "8.8.8.8", "203.162.4.191", "2606:4700:4700::1111"])
def test_global_unicast_addresses_are_public(address: str) -> None:
    assert is_public_address(ipaddress.ip_address(address))


def test_any_internal_address_in_answer_set_refuses_all() -> None:
    public = ipaddress.ip_address("1.1.1.1")
    with pytest.raises(UrlPolicyError) as exc:
        check_resolved([public, ipaddress.ip_address("10.0.0.5")])
    assert exc.value.code == "DESTINATION_NOT_PUBLIC"
    with pytest.raises(UrlPolicyError) as empty:
        check_resolved([])
    assert empty.value.code == "DNS_NO_ADDRESS"
    assert check_resolved([public]) == public


def test_allowlist_is_fail_closed_and_validated(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(ALLOWED_HOSTS_ENV, raising=False)
    assert load_fetch_policy().allowed_hosts == frozenset()
    monkeypatch.setenv(ALLOWED_HOSTS_ENV, " Invoice.Example.VN , lookup.example.vn ")
    assert load_fetch_policy().allowed_hosts == frozenset({"invoice.example.vn", "lookup.example.vn"})
    for bad in ("*.example.vn", "https://invoice.example.vn", "10.0.0.1", "invoice.example.vn:443"):
        monkeypatch.setenv(ALLOWED_HOSTS_ENV, bad)
        with pytest.raises(UrlPolicyError):
            load_fetch_policy()
    with pytest.raises(UrlPolicyError):
        normalize_allowlist_entry("")


def test_fetch_byte_limit_env_can_only_tighten(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_WORKER_INVOICE_MAX_FETCH_BYTES", "999999999999")
    assert load_fetch_policy().limits.max_fetch_bytes == 2 * 1024 * 1024
    monkeypatch.setenv("AI_WORKER_INVOICE_MAX_FETCH_BYTES", "1024")
    assert load_fetch_policy().limits.max_fetch_bytes == 1024
