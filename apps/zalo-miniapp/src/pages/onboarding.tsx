import { Button, useNavigate } from 'zmp-ui';
import { Shell } from '../components/shell.tsx';

export function OnboardingPage() {
  const navigate = useNavigate();
  return (
    <Shell title="Chào mừng bạn" back={false}>
      <p className="lead">Bồi thường bảo hiểm sức khỏe ngay trên Zalo — bản thử nghiệm giao diện.</p>
      <ol className="steps-intro">
        <li><strong>Đồng ý xử lý dữ liệu</strong> theo phiên bản điều khoản hiện hành.</li>
        <li><strong>Xuất trình thẻ bảo hiểm điện tử</strong> tại cơ sở y tế.</li>
        <li><strong>Chụp và gửi chứng từ</strong>, theo dõi hồ sơ và xem bảng giải trình chi trả.</li>
      </ol>
      <p className="hint">
        Đây là bản mẫu: không đăng nhập, không kết nối Zalo thật, không tải tệp lên máy chủ. Mọi số liệu đều là giả lập.
      </p>
      <Button fullWidth onClick={() => navigate('/consent')}>Bắt đầu</Button>
      {/* #106: the user-centric hub (personal Loyalty360 + workspaces) is reachable from the first screen. */}
      <Button fullWidth variant="secondary" onClick={() => navigate('/hub')}>Mở trang tiện ích cá nhân</Button>
    </Shell>
  );
}
