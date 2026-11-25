# Đặc tả Thuật toán Nghiệp vụ & Edge Cases (Pure Engineering Spec)

## 1. Máy Trạng thái Hồ sơ (`ClaimStateMachine`)
Các trạng thái hợp lệ của bảng `claims.status`:
1. `PREFLIGHT`: Khách vừa upload ảnh, đang kiểm tra nhanh (mục tiêu p95 <=3s ở tải pilot); tác vụ sâu có trạng thái pending.
2. `SUBMITTED`: Khách bấm nộp chính thức (có `Idempotency-Key` + `consentAccepted=true`).
3. `AI_PROCESSING`: Queue đang chạy tải XML/VLM/Forensics/`pgvector`.
4. `GREEN_STP`: Đạt đủ 5 điều kiện tự động duyệt (chuyển sang `EOB_READY` tự động).
5. `DOCTOR_REVIEW`: Đẩy vào hàng đợi Split-Screen cho Bác sĩ (SLA đếm ngược).
6. `FRAUD_HOLD`: Phát hiện sửa Photoshop, hóa đơn `CANCELLED`, hoặc trùng `invoice_unique_hash` (nếu không phải đồng bảo hiểm).
7. `SUPPLEMENT_REQUIRED`: Thiếu chứng từ (thiếu dấu đỏ, thiếu chỉ định cận lâm sàng, mua thuốc ngày 6–30 thiếu phiếu thu tạm). *Khách vẫn được upload bổ sung tại đây.*
8. `WAITING_ORIGINAL_DOCS`: Ca nội trú/phẫu thuật `total_requested >= 20,000,000` đang chờ nhận bản gốc giấy qua bưu điện.
9. `EOB_READY`: Đã chốt bảng giải trình, gửi ZBS/ZNS chờ khách xác nhận OTP.
10. `OTP_SIGNED`: Khách đã ký OTP đồng ý bảng EOB -> Đẩy sang `PAYOUT_PROCESSING` (hoặc chờ lô `T+1..T+3`).
11. `PAYOUT_PROCESSING`: Đã đủ điều kiện chi trả; payment intent theo dõi SUBMITTED/UNKNOWN/SUCCEEDED/FAILED riêng.
12. `PAID` / `REJECTED` / `CLOSED_EXPIRED` (đóng nếu quá 15 ngày không bổ sung).

## 2. Công thức Waterfall Tính tiền (Bắt buộc dùng `Decimal.js`, làm tròn `ROUND_HALF_UP` tới hàng đơn vị VNĐ)
- **Bước 1 (Eligibility Gate):**
  - `member.is_premium_paid === true` và `visit_date` nằm trong `[effective_from, effective_to]`.
  - Tính `days_active = visit_date - effective_from`. Kiểm tra `waiting_days_normal` (30d), `waiting_days_special` (365d nếu `icd10.is_chronic_special === true`).
  - Kiểm tra `tenant_provider_policies`: Nếu `BLACKLISTED` -> `REJECTED` toàn bộ (trích `exclusion_clause_ref`).
- **Bước 2 (Line-by-Line Filter):**
  - Nếu `category IN ('SUPPLEMENT_TPCN', 'COSMETIC')` -> `approved = "0.00"`, `rejected = requested`, `ai_flag = "TPCN_EXCLUDED"`, bắt buộc gắn `contract_clause_cited`.
  - Nếu `unit_price > 1.30 * catalog.reference_unit_price` -> `ai_flag = "PRICE_ANOMALY"`.
- **Bước 3 (Co-pay & Trần quyền lợi):**
  - `after_deductible = max(0, requested - remaining_deductible)`
  - `after_copay = round_half_up(after_deductible * (copay_insurer_pct / 100), 0)`
  - `actual_approved = min(after_copay, remaining_visit_limit, remaining_annual_limit)`
  - Cập nhật trừ dần `remaining_visit_limit` và `remaining_annual_limit`.
- **Bước 4 (5 Điều kiện bắt buộc để vào `GREEN_STP`):**
  1. `benefit_type IN ('OUTPATIENT', 'DENTAL')`
  2. `total_requested <= rule.stp_auto_approve_limit` (mặc định `2000000.00`)
  3. `e_invoice.tax_lookup_status === 'VERIFIED_VALID'` VÀ `e_invoice.is_merged_summary === false`
  4. `fraud_risk_score < 20` VÀ không có bất kỳ dòng nào bị `TPCN_EXCLUDED`, `PRICE_ANOMALY`, `ICD_MISMATCH`, hay `REJECTED`, và không bị giảm tiền do chạm hạn mức (TC03)
  5. `icd10.is_chronic_special === false` và `days_active >= waiting_days_normal`
  *(Nếu thiếu 1 trong 5 điều kiện -> Bắt buộc qua `DOCTOR_REVIEW`)*

## 3. Đặc tả 8 Edge Cases
1. **Đồng bảo hiểm (Co-insurance):** Cho phép 1 `e_invoice` liên kết tối đa nhiều `claims` qua `invoice_claim_allocations` với ràng buộc cứng: `SUM(allocated_amount) <= e_invoice.total_amount`. Hãng thứ 2 yêu cầu có `co_insurance_proof_url`.
2. **Trợ cấp nằm viện Nhân thọ (`HOSPITAL_INCOME`):** Tính số ngày theo `(discharge_datetime - admit_datetime)` làm tròn theo quy tắc từng gói (mặc định số đêm nằm viện hoặc `floor(hours / 24)`). Cấm trùng khoảng thời gian `[admit, discharge]` với claim đã duyệt trước đó.
3. **Lưu viện trong ngày (Daycare):** Nếu `(discharge_datetime - admit_datetime) < 24h` VÀ `has_surgery_cert === false` -> Ép chuyển `benefit_type = 'OUTPATIENT'`.
4. **30 ngày Pre/Post nhập viện:** Hóa đơn ngoại trú trong `[admit_date - 30d, discharge_date + 30d]` có cùng nhóm `icd10_code` -> Gợi ý gộp vào hạn mức Nội trú.
5. **XML gộp bệnh viện công (`is_merged_summary = true`):** Khi XML chỉ có 1 dòng tổng, Worker bắt buộc OCR `ITEMIZED_LIST` và kiểm tra sai số: `abs(SUM(ocr_lines) - e_invoice.total_amount) <= 1000` (1.000đ làm tròn). Nếu lệch -> đẩy `DOCTOR_REVIEW`.
6. **Quy tắc Con dấu & 5 ngày mua thuốc:** Nếu `provider.is_electronic_medical_record === true` -> Miễn dấu đỏ. Nếu `(invoice_date - prescription_date) > 5` (tối đa 30 ngày) và chưa có phiếu thu tạm -> Trả cảnh báo `SUPPLEMENT_REQUIRED`.
7. **Hồ sơ >= 20–30 triệu:** Tự động set `requires_original_docs = true`; chặn chuyển sang `PAID` nếu `original_doc_tracking_code` chưa xác nhận đã nhận bản gốc.
8. **Người được BH < 18 tuổi:** `visit_date - dob < 18 năm` -> Kiểm tra `bank_account_holder_name` phải trùng với `primary_member.full_name`.

## 4. Pipeline Xử lý Ảnh Hóa đơn (`svc-invoice-xml-tax`)
1. **CPU Pre-filter (0đ):** OpenCV `LaplacianVariance < 65` -> Reject ảnh mờ; chạy Red-channel suppression giảm màu dấu đỏ đè lên chữ trước khi OCR.
2. **QR & XML Fetch:** `pyzbar` giải mã QR -> Nếu là URL tra cứu MISA/VNPT/Viettel thì tải XML gốc.
3. **VLM Fallback & NĐ 70 Check:** Nếu không tải được XML trực tiếp, che PII (Regex + header crop) rồi gọi Viettel AI `Qwen3-VL` đọc 6 trường hóa đơn + các dòng thuốc trên Bảng kê. Kiểm tra `buyer_name`/`buyer_mst` không chứa từ khóa công ty (`TNHH`, `Cổ phần`, `MST` công ty).
4. **Anti-Fraud (tín hiệu hỗ trợ):** Tính `invoice_unique_hash = SHA256(MST|Serial|Number)`; tính `VECTOR(512)` kiểm tra Cosine Similarity `>= 0.92` trên `claim_documents` (mục tiêu HNSW latency phải benchmark; 0.92 là ngưỡng khởi điểm cần hiệu chỉnh, không tự kết luận gian lận).


## 5. Quy tắc nền tảng có hiệu lực bổ sung
- Áp dụng 06–08: Temporal điều phối từ đầu, Kafka qua outbox/inbox, Elasticsearch chỉ là search projection. Transaction PostgreSQL xác nhận business state/audit/outbox; timer hoặc message trùng không được lặp side effect.
- Claim state, triage lane, STP eligibility và execution mode là các khái niệm riêng. GREEN_STP chỉ tự chuyển EOB_READY khi tenant/plan đã bật STP; mặc định SHADOW vẫn qua người duyệt.
- Eligibility gate thiếu dữ liệu/điều khoản chuyển review. TC06 chưa xác lập số tiền bị loại trừ; không suy diễn từ routing thành quyết định từ chối. Quy tắc cấu hình theo contract version được duyệt.
- Mỗi EOB đã publish là phiên bản bất biến có input/rule/model/prompt version và hash. OTP/duyệt kép gắn phiên bản; chỉnh EOB buộc ký/duyệt lại. Payout đã submit khóa sửa và chuyển quy trình điều chỉnh.
- Giữ chỗ/sử dụng/hoàn trả hạn mức, allocation đồng bảo hiểm và số dư phải atomic, chống concurrent overspend. Cần lock toàn cục có kiểm soát cho hóa đơn dùng chung giữa tenant.
- Có original_doc_tracking_code chưa đủ để PAID: cần receipt được nhân sự xác nhận. Ngưỡng bản gốc/duyệt kép theo phiên bản hợp đồng và cấu hình đã duyệt; không lấy khoảng 20–30 triệu làm điều kiện không xác định.
- Payment timeout -> UNKNOWN, tra cứu/callback/đối soát trước khi cân nhắc gửi lại. PAID cần bằng chứng thành công và journal cân bằng; journal đã post chỉ được reversal.
- QR/XML parse thành công không tự tạo VERIFIED_VALID. Xác minh nguồn, chống SSRF/XXE, giới hạn tải/giải nén và scan file. Luôn giữ bản gốc, red suppression chỉ tạo ảnh dẫn xuất.
- Kết quả AI có provenance/confidence; tên gần giống và cosine similarity chỉ là tín hiệu. Active learning tạo đề xuất chờ duyệt, không tự sửa danh mục chung.
