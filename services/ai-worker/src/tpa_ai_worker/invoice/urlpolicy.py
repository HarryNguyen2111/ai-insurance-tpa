"""SSRF policy: URL shape, trusted host allowlist and destination IP checks.

A QR code is attacker-controlled input. Before any byte leaves the worker:

* the URL must be ``https`` on port 443, without userinfo, IP literals,
  backslashes, whitespace or control characters;
* the host must exactly match the configured allowlist (no wildcards);
* every address the host resolves to must be a public unicast address.
  Private, loopback, link-local (cloud metadata 169.254.169.254), CGNAT,
  multicast, reserved, unspecified and documentation ranges are refused, as
  are IPv6 forms that embed an IPv4 address (IPv4-mapped, 6to4, Teredo,
  NAT64) because they can smuggle an internal IPv4 destination.

The same checks run again for every redirect hop (see ``fetch.py``).
"""

from __future__ import annotations

import ipaddress
import re
from dataclasses import dataclass
from urllib.parse import urlsplit

IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address


class UrlPolicyError(ValueError):
    """The URL or destination violates the fetch policy.

    ``code`` is a stable machine-readable reason. Messages never contain the
    URL itself (it may carry lookup secrets) so they are safe to log.
    """

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


_LABEL = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
_HOSTNAME_RE = re.compile(rf"^(?=.{{1,253}}$){_LABEL}(?:\.{_LABEL})+$")
# A final label that inet_aton()/getaddrinfo could read as a number.
_NUMERIC_TLD_RE = re.compile(r"^(?:[0-9]+|0x[0-9a-f]*)$")
_FORBIDDEN_URL_CHARS = re.compile(r"[\x00-\x20\x7f\\]")

# Ranges refused even though some of them are globally routable: cloud
# metadata / platform endpoints and NAT64 prefixes (RFC 6052 / RFC 8215).
_EXPLICIT_DENY: tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...] = (
    ipaddress.ip_network("169.254.0.0/16"),  # link-local incl. 169.254.169.254
    ipaddress.ip_network("100.64.0.0/10"),  # CGNAT incl. 100.100.100.200 (Alibaba)
    ipaddress.ip_network("168.63.129.16/32"),  # Azure WireServer
    ipaddress.ip_network("192.0.0.0/24"),  # IETF protocol assignments incl. OCI 192.0.0.192
    ipaddress.ip_network("fd00:ec2::/32"),  # AWS IMDS over IPv6 (ULA, also denied below)
    ipaddress.ip_network("64:ff9b::/96"),
    ipaddress.ip_network("64:ff9b:1::/48"),
)


@dataclass(frozen=True, slots=True)
class ValidatedUrl:
    """A URL that passed shape and allowlist checks (DNS not yet checked)."""

    host: str  # lower-case ASCII (IDNA) host, used for SNI, Host and cert check
    port: int
    request_target: str  # path + query sent on the request line

    def describe(self) -> str:
        """Log/provenance-safe identity: host only, never path or query."""
        return f"https://{self.host}"


def _to_ascii_host(host: str) -> str:
    host = host.strip().rstrip(".").lower()
    if not host:
        raise UrlPolicyError("HOST_MISSING")
    try:
        ascii_host = host.encode("idna").decode("ascii")
    except UnicodeError as exc:
        raise UrlPolicyError("HOST_INVALID") from exc
    if not _HOSTNAME_RE.match(ascii_host):
        raise UrlPolicyError("HOST_INVALID")
    if _NUMERIC_TLD_RE.match(ascii_host.rsplit(".", 1)[-1]):
        raise UrlPolicyError("HOST_IP_LITERAL")
    return ascii_host


def normalize_allowlist_entry(entry: str) -> str:
    """Validate one configured allowlist host (no scheme, port or wildcard)."""
    return _to_ascii_host(entry)


def validate_url(url: str, allowed_hosts: frozenset[str], *, max_length: int) -> ValidatedUrl:
    if len(url) > max_length:
        raise UrlPolicyError("URL_TOO_LONG")
    if _FORBIDDEN_URL_CHARS.search(url):
        raise UrlPolicyError("URL_FORBIDDEN_CHARACTER")
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError as exc:
        raise UrlPolicyError("URL_MALFORMED") from exc
    if parts.scheme.lower() != "https":
        raise UrlPolicyError("SCHEME_NOT_HTTPS")
    # '@' anywhere in the authority means userinfo or a parser-confusion trick.
    if "@" in parts.netloc or parts.username is not None or parts.password is not None:
        raise UrlPolicyError("URL_USERINFO")
    if port is not None and port != 443:
        raise UrlPolicyError("PORT_NOT_ALLOWED")
    raw_host = parts.hostname
    if raw_host is None or raw_host == "":
        raise UrlPolicyError("HOST_MISSING")
    if parts.netloc.startswith("[") or _is_ip_literal(raw_host):
        raise UrlPolicyError("HOST_IP_LITERAL")
    host = _to_ascii_host(raw_host)
    if host not in allowed_hosts:
        raise UrlPolicyError("HOST_NOT_ALLOWED")
    target = parts.path or "/"
    if parts.query:
        target = f"{target}?{parts.query}"
    return ValidatedUrl(host=host, port=443, request_target=target)


def _is_ip_literal(host: str) -> bool:
    try:
        ipaddress.ip_address(host.split("%", 1)[0])
    except ValueError:
        return False
    return True


def is_public_address(ip: IPAddress) -> bool:
    """True only for a global unicast address that is safe to connect to."""
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.scope_id is not None:
            return False
        if ip.ipv4_mapped is not None or ip.sixtofour is not None or ip.teredo is not None:
            return False
        if ip.is_site_local:
            return False
    if any(ip in net for net in _EXPLICIT_DENY if net.version == ip.version):
        return False
    if (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    ):
        return False
    return ip.is_global


def check_resolved(addresses: list[IPAddress]) -> IPAddress:
    """Require every resolved address to be public; return the one to pin.

    Refusing the whole set when *any* member is internal stops an attacker
    from mixing a public record with an internal one and hoping the client
    picks the internal address.
    """
    if not addresses:
        raise UrlPolicyError("DNS_NO_ADDRESS")
    for ip in addresses:
        if not is_public_address(ip):
            raise UrlPolicyError("DESTINATION_NOT_PUBLIC")
    return addresses[0]
