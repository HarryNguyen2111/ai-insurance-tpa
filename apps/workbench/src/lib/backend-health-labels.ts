import type { BackendHealthReport } from './core-api-health.ts';

export type ClientHealth =
  | { kind: 'CHECKING' }
  | { kind: 'REPORT'; report: BackendHealthReport }
  | { kind: 'BROWSER_OFFLINE' }
  | { kind: 'WEB_UNREACHABLE' };

export type Tone = 'neutral' | 'ok' | 'warn' | 'bad';

export interface HealthView {
  state: string;
  tone: Tone;
  title: string;
  explanation: string;
}

// Vietnamese copy for every UI state. ONLINE explicitly limits itself to liveness.
export function describeHealth(health: ClientHealth): HealthView {
  switch (health.kind) {
    case 'CHECKING':
      return { state: 'CHECKING', tone: 'neutral', title: 'Đang kiểm tra Core API…', explanation: 'Đang gọi GET /health qua máy chủ web.' };
    case 'BROWSER_OFFLINE':
      return { state: 'BROWSER_OFFLINE', tone: 'neutral', title: 'Trình duyệt đang ngoại tuyến', explanation: 'Thiết bị mất kết nối mạng. Trạng thái Core API không xác định cho tới khi có mạng lại.' };
    case 'WEB_UNREACHABLE':
      return { state: 'WEB_UNREACHABLE', tone: 'bad', title: 'Không liên lạc được máy chủ web', explanation: 'Trình duyệt không gọi được máy chủ Next.js, nên không biết trạng thái Core API.' };
    case 'REPORT': {
      const { report } = health;
      switch (report.state) {
        case 'ONLINE':
          return { state: 'ONLINE', tone: 'ok', title: 'Core API đang chạy', explanation: 'GET /health trả 200 {"status":"ok"}. Chỉ xác nhận tiến trình NestJS còn sống (liveness), KHÔNG phải sẵn sàng nghiệp vụ hay hạ tầng.' };
        case 'UNREACHABLE':
          return { state: 'UNREACHABLE', tone: 'bad', title: 'Không kết nối được Core API', explanation: report.detail === 'TIMEOUT' ? 'Core API không phản hồi trong 2 giây.' : 'Tiến trình NestJS core-api chưa chạy hoặc đã dừng.' };
        case 'UNEXPECTED_RESPONSE':
          return { state: 'UNEXPECTED_RESPONSE', tone: 'warn', title: 'Core API phản hồi bất thường', explanation: `Có phản hồi nhưng không đúng hợp đồng liveness (${report.detail}).` };
        case 'MISCONFIGURED':
          return { state: 'MISCONFIGURED', tone: 'bad', title: 'Cấu hình địa chỉ Core API không hợp lệ', explanation: 'Máy chủ web chỉ chấp nhận địa chỉ loopback http://127.0.0.1|localhost|[::1]:<port>. Không có yêu cầu nào được gửi.' };
      }
    }
  }
}
