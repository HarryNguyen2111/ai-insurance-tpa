"""Synthetic e-invoice XML and a loopback HTTP server for fetch tests.

Every value here is invented (tax codes, names, amounts); no customer data.
The ``SYNTH-PII-*`` markers let tests prove buyer data never leaks.
"""

from __future__ import annotations

import http.server
import ipaddress
import socket
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from xml.sax.saxutils import escape

from tpa_ai_worker.invoice.urlpolicy import IPAddress

BUYER_NAME_MARKER = "SYNTH-PII-BUYER-NAME Nguyễn Văn Tổng Hợp"
BUYER_ADDRESS_MARKER = "SYNTH-PII-ADDRESS 1 Đường Giả Lập"
BUYER_ID_MARKER = "079099000001"  # synthetic 12-digit identity-shaped value

PUBLIC_V4 = ipaddress.ip_address("1.1.1.1")
PUBLIC_V4_B = ipaddress.ip_address("8.8.8.8")
PUBLIC_V6 = ipaddress.ip_address("2606:4700:4700::1111")


@dataclass(frozen=True)
class Line:
    name: str
    amount: str
    quantity: str = "1"
    unit_price: str | None = None
    nature: str = "1"


def invoice_xml(
    lines: list[Line] | None = None,
    *,
    total: str = "1650000",
    seller_mst: str = "0109999999",
    buyer_name: str = BUYER_NAME_MARKER,
    serial: str = "C26TSY",
    number: str = "1234",
    issued: str = "2026-10-15",
    mccqt: str | None = None,
    extra_general: str = "",
    namespace: str | None = None,
    envelope: bool = False,
) -> bytes:
    if lines is None:
        lines = [
            Line("Khám bệnh tổng hợp (synthetic)", "150000.00"),
            Line("Xét nghiệm máu (synthetic)", "500000"),
            Line("Thuốc kháng viêm (synthetic)", "1000000", quantity="10", unit_price="100000"),
        ]
    items = "".join(
        "<HHDVu>"
        f"<TChat>{line.nature}</TChat><STT>{i}</STT><THHDVu>{escape(line.name)}</THHDVu>"
        f"<DVTinh>Lần</DVTinh><SLuong>{line.quantity}</SLuong>"
        f"<DGia>{line.unit_price if line.unit_price is not None else line.amount}</DGia>"
        f"<ThTien>{line.amount}</ThTien><TSuat>KCT</TSuat>"
        "</HHDVu>"
        for i, line in enumerate(lines, start=1)
    )
    ns = f' xmlns="{namespace}"' if namespace else ""
    hdon = (
        f"<HDon{ns}><DLHDon Id=\"data\">"
        "<TTChung><PBan>2.0.1</PBan><THDon>HÓA ĐƠN GIÁ TRỊ GIA TĂNG</THDon>"
        f"<KHMSHDon>1</KHMSHDon><KHHDon>{serial}</KHHDon><SHDon>{number}</SHDon>"
        f"<NLap>{issued}</NLap><DVTTe>VND</DVTTe>{extra_general}</TTChung>"
        "<NDHDon>"
        f"<NBan><Ten>Phòng khám Tổng hợp Giả lập</Ten><MST>{seller_mst}</MST><DChi>Hà Nội</DChi></NBan>"
        f"<NMua><Ten>{escape(buyer_name)}</Ten><MST>{BUYER_ID_MARKER}</MST>"
        f"<DChi>{escape(BUYER_ADDRESS_MARKER)}</DChi><SDThoai>0900000000</SDThoai></NMua>"
        f"<DSHHDVu>{items}</DSHHDVu>"
        f"<TToan><TgTCThue>{total}</TgTCThue><TgTThue>0</TgTThue><TgTTTBSo>{total}</TgTTTBSo>"
        "<TgTTTBChu>synthetic</TgTTTBChu></TToan>"
        "</NDHDon></DLHDon>"
        + (f"<MCCQT>{mccqt}</MCCQT>" if mccqt else "")
        + "<DSCKS><NBan><Signature>SYNTHETIC-UNVERIFIED-SIGNATURE</Signature></NBan></DSCKS>"
        "</HDon>"
    )
    if envelope:
        hdon = f'<TDiep xmlns:x="urn:synthetic"><MLTDiep>200</MLTDiep><DLieu>{hdon}</DLieu></TDiep>'
    return ('<?xml version="1.0" encoding="UTF-8"?>' + hdon).encode("utf-8")


MERGED_TC05_XML = invoice_xml(
    [Line("Chi phí khám chữa bệnh theo bảng kê (synthetic)", "2000000")], total="2000000"
)

BILLION_LAUGHS = (
    b'<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">'
    + b"".join(
        f'<!ENTITY lol{i} "{("&lol" + (str(i - 1) if i > 1 else "") + ";") * 10}">'.encode()
        for i in range(1, 10)
    )
    + b"]><lolz>&lol9;</lolz>"
)
XXE_FILE = b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><HDon>&e;</HDon>'
XXE_NETWORK_DTD = b'<?xml version="1.0"?><!DOCTYPE x SYSTEM "http://127.0.0.1:9/evil.dtd"><HDon/>'
XXE_PARAMETER = (
    b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY % p SYSTEM "http://169.254.169.254/latest/meta-data/">%p;]><x/>'
)


def utf16(xml: bytes) -> bytes:
    """Re-encode as UTF-16 so a naive byte scan for ``<!DOCTYPE`` misses it."""
    text = xml.decode("utf-8").replace('<?xml version="1.0"?>', '<?xml version="1.0" encoding="UTF-16"?>')
    return text.encode("utf-16")


# ---------------------------------------------------------------- fetch rig

Handler = Callable[[http.server.BaseHTTPRequestHandler], None]


@dataclass
class Rig:
    """Loopback HTTP server plus recording resolver/connector doubles.

    The connector stands in for "connect to the pinned public IP": whatever
    IP it is handed, it records it and dials the loopback server instead.
    """

    port: int
    routes: dict[str, Handler]
    dns: dict[str, list[list[IPAddress]]] = field(default_factory=dict)
    resolved: list[str] = field(default_factory=list)
    connected: list[tuple[str, IPAddress, int]] = field(default_factory=list)
    host_headers: list[str] = field(default_factory=list)

    def resolver(self, host: str, timeout_s: float) -> list[IPAddress]:
        self.resolved.append(host)
        answers = self.dns.get(host, [[PUBLIC_V4]])
        # Successive lookups walk the answer list (last one repeats): lets a
        # test model DNS rebinding.
        index = min(self.resolved.count(host) - 1, len(answers) - 1)
        return answers[index]

    def connector(self, host: str, ip: IPAddress, port: int, timeout_s: float) -> socket.socket:
        self.connected.append((host, ip, port))
        return socket.create_connection(("127.0.0.1", self.port), timeout=timeout_s)


def send(
    h: http.server.BaseHTTPRequestHandler,
    body: bytes,
    *,
    status: int = 200,
    headers: dict[str, str] | None = None,
    content_length: bool = True,
) -> None:
    h.send_response(status)
    for key, value in (headers or {}).items():
        h.send_header(key, value)
    if content_length:
        h.send_header("Content-Length", str(len(body)))
    h.send_header("Connection", "close")
    h.end_headers()
    try:
        h.wfile.write(body)
    except OSError:
        pass


@contextmanager
def serve(routes: dict[str, Handler]) -> Iterator[Rig]:
    rig_holder: list[Rig] = []

    class _Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self) -> None:  # noqa: N802 - http.server API
            rig_holder[0].host_headers.append(self.headers.get("Host", ""))
            handler = routes.get(self.path.split("?", 1)[0])
            if handler is None:
                send(self, b"not found", status=404)
                return
            try:
                handler(self)
            except OSError:
                pass

        def log_message(self, format: str, *args: object) -> None:  # noqa: A002
            return

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    server.daemon_threads = True
    rig = Rig(port=server.server_address[1], routes=routes)
    rig_holder.append(rig)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
    thread.start()
    try:
        yield rig
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
