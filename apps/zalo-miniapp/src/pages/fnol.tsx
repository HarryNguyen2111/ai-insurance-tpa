import { useId, useState, type ChangeEvent } from 'react';
import { Button, useNavigate } from 'zmp-ui';
import { Shell } from '../components/shell.tsx';
import { ServiceState } from '../components/service-state.tsx';
import { ACCEPT_ATTRIBUTE, CAMERA_FALLBACK_STEPS, checkFile } from '../lib/upload.ts';
import { openPermissionSettings, requestCamera } from '../lib/platform.ts';
import type { DraftFile, FnolDraft } from '../lib/scope.ts';
import { usePrototype, useTpaView, useWorkspace } from '../state.tsx';

const DOC_TYPES = [
  ['INVOICE_PHOTO', 'Hóa đơn'],
  ['ITEMIZED_LIST', 'Bảng kê chi phí'],
  ['PRESCRIPTION', 'Đơn thuốc'],
  ['LAB_RESULT', 'Kết quả xét nghiệm'],
] as const;

type Camera = 'idle' | 'granted' | 'denied';

function kb(size: number): string {
  // Display only (file size, not money): integer KB, no float arithmetic retained.
  return `${Math.max(1, Math.round(size / 1024))} KB`;
}

export function FnolPage() {
  const navigate = useNavigate();
  const { runtime, canSubmit } = usePrototype();
  const view = useTpaView();
  // The draft lives in the scoped store: principal + tenant + TPA + form version (lib/scope.ts). It is
  // never moved to another tenant; switching away keeps or discards it via the pending-work dialog.
  const { draft, setDraft } = useWorkspace();
  const docType = draft?.docType ?? 'INVOICE_PHOTO';
  const files = draft?.files ?? [];
  const draftSaved = draft?.saved ?? false;
  const update = (patch: Partial<FnolDraft>) => setDraft({ docType, files, saved: draftSaved, ...patch });
  const [simulateAllow, setSimulateAllow] = useState(false);
  const [camera, setCamera] = useState<Camera>('idle');
  const [settingsNote, setSettingsNote] = useState('');
  const [submitted, setSubmitted] = useState<number | null>(null);
  const galleryId = useId();
  const cameraInputId = useId();

  if (view.status !== 'ready') {
    return (
      <Shell title="Gửi yêu cầu bồi thường">
        <ServiceState view={view} serviceVi="Bảo hiểm sức khỏe" />
      </Shell>
    );
  }

  if (!canSubmit) {
    return (
      <Shell title="Gửi yêu cầu bồi thường">
        <p className="card notice" role="alert">Bạn cần đồng ý xử lý dữ liệu (phiên bản hiện hành) trước khi gửi hồ sơ.</p>
        <Button fullWidth onClick={() => navigate('/consent')}>Xem điều khoản</Button>
      </Shell>
    );
  }

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    // Only browser-supplied metadata is read; the file bytes are never opened, hashed or sent.
    const list: DraftFile[] = Array.from(e.target.files ?? []).map((f, i) => {
      const check = checkFile({ name: f.name, type: f.type, size: f.size });
      return {
        key: `${Date.now()}-${i}`,
        name: f.name,
        sizeKb: kb(f.size),
        ok: check.ok,
        isHeic: check.ok && check.isHeic,
        reasonVi: check.ok ? '' : check.reasonVi,
      };
    });
    update({ files: [...files, ...list] });
    e.target.value = '';
  };

  const askCamera = async () => {
    const res = await requestCamera(runtime, simulateAllow);
    setCamera(res.granted ? 'granted' : 'denied');
  };

  const accepted = files.filter((f) => f.ok);

  if (submitted !== null) {
    return (
      <Shell title="Đã mô phỏng gửi hồ sơ">
        <section className="card" role="status" data-testid="fnol-done">
          <h2>Mô phỏng hoàn tất</h2>
          <p>{submitted} tệp hợp lệ đã được kiểm tra trên máy. Không có tệp hay dữ liệu nào được gửi đi.</p>
          <p className="hint">
            Bản thật sẽ xin URL tải lên có chữ ký (pre-signed) từ máy chủ, gửi kèm Idempotency-Key và chỉ tạo hồ sơ sau
            khi máy chủ xác nhận.
          </p>
        </section>
        <Button fullWidth onClick={() => navigate('/claims')}>Xem hồ sơ mẫu</Button>
      </Shell>
    );
  }

  return (
    <Shell title="Gửi yêu cầu bồi thường">
      <section className="card" aria-labelledby="doc-type-legend">
        <fieldset>
          <legend id="doc-type-legend">Loại chứng từ</legend>
          {DOC_TYPES.map(([value, label]) => (
            <label key={value} className="radio">
              <input type="radio" name="docType" value={value} checked={docType === value} onChange={() => update({ docType: value })} />
              {label}
            </label>
          ))}
        </fieldset>
      </section>

      <section className="card" aria-labelledby="camera-title">
        <h2 id="camera-title">Chụp chứng từ</h2>
        {runtime === 'browser' && (
          <fieldset className="simulate">
            <legend>Giả lập quyền camera (chỉ có ngoài Zalo)</legend>
            <label className="radio">
              <input type="radio" name="sim" checked={simulateAllow} onChange={() => setSimulateAllow(true)} />
              Cho phép
            </label>
            <label className="radio">
              <input type="radio" name="sim" checked={!simulateAllow} onChange={() => setSimulateAllow(false)} />
              Từ chối
            </label>
          </fieldset>
        )}
        <Button fullWidth onClick={askCamera}>Mở camera</Button>

        {camera === 'granted' && (
          <div className="ok" role="status" data-testid="camera-granted">
            <p>Đã có quyền camera{runtime === 'browser' ? ' (giả lập)' : ''}.</p>
            <label htmlFor={cameraInputId} className="file-label">Chụp ảnh chứng từ</label>
            <input id={cameraInputId} type="file" accept="image/*" capture="environment" onChange={onPick} />
          </div>
        )}

        {camera === 'denied' && (
          <div role="alert" data-testid="camera-fallback">
            <p><strong>Không có quyền camera.</strong> Bạn vẫn có thể tiếp tục theo một trong 3 cách:</p>
            <ol className="fallback">
              {CAMERA_FALLBACK_STEPS.map((s) => (
                <li key={s.id} data-testid={`fallback-${s.id}`}>
                  <strong>{s.titleVi}</strong>
                  <span>{s.bodyVi}</span>
                  {s.id === 'retry' && (
                    <span className="row">
                      <Button
                        size="small"
                        variant="secondary"
                        onClick={async () => {
                          const opened = await openPermissionSettings(runtime);
                          setSettingsNote(opened ? '' : 'Ngoài Zalo không mở được cài đặt quyền; hãy chọn “Cho phép” ở phần giả lập rồi thử lại.');
                        }}
                      >
                        Mở cài đặt quyền
                      </Button>
                      <Button size="small" variant="tertiary" onClick={askCamera}>Thử lại</Button>
                    </span>
                  )}
                  {s.id === 'retry' && settingsNote && <span className="hint">{settingsNote}</span>}
                  {s.id === 'gallery' && (
                    <>
                      <label htmlFor={galleryId} className="file-label">Chọn ảnh hoặc PDF</label>
                      <input id={galleryId} type="file" multiple accept={ACCEPT_ATTRIBUTE} onChange={onPick} data-testid="gallery-input" />
                    </>
                  )}
                  {s.id === 'later' && (
                    <span className="row">
                      <Button size="small" variant="secondary" onClick={() => update({ saved: true })}>Lưu nháp</Button>
                      {draftSaved && <span role="status">Đã lưu nháp tạm trong phiên này (giả lập, không lưu chứng từ).</span>}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </div>
        )}
      </section>

      {files.length > 0 && (
        <section className="card" aria-labelledby="files-title">
          <h2 id="files-title">Tệp đã chọn (chỉ kiểm tra trên máy)</h2>
          <ul className="files" data-testid="file-list">
            {files.map((f) => (
              <li key={f.key} className={f.ok ? 'file ok' : 'file bad'}>
                <span className="name">{f.name}</span>
                <span className="meta">{f.sizeKb}</span>
                {f.ok ? (
                  <span className="tag">{f.isHeic ? 'HEIC — sẽ chuyển đổi trên máy chủ' : 'Hợp lệ'}</span>
                ) : (
                  <span className="tag bad">{f.reasonVi}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <Button fullWidth disabled={accepted.length === 0} onClick={() => {
          // Simulated submit consumes the draft of THIS scope only.
          setSubmitted(accepted.length);
          setDraft(undefined);
        }}>
        Gửi hồ sơ (mô phỏng)
      </Button>
    </Shell>
  );
}
