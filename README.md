# Visual Library

App đọc và ghi chú tài liệu cho Xiaomi Pad 8 Pro + Focus Pen Pro. Đây là một PWA: mở link trên Chrome rồi cài như app thường, dùng được offline, mọi dữ liệu nằm trên máy.

**Link app:** https://heisenberg-vau.github.io/Visual-Library/

## Lộ trình phiên bản 1

| Mốc | Nội dung | Trạng thái |
|---|---|---|
| 1 | Nhập PDF, kệ sách, nhảy trang, mục lục, ảnh thu nhỏ, zoom | ✅ v0.1.0 |
| 2 | Danh mục nhiều tầng, thẻ, chọn nhiều để chuyển/gắn thẻ/xóa | ✅ v0.2.0 |
| 3 | Viết tay: bút nét cố định, highlight + gạch chân bám theo chữ, tẩy, undo, nới rộng lề (kẻ dòng/ô/chấm) | ✅ v0.3.1 |
| 4 | Xuất "bản có ghi chú" ra file PDF mới (bản gốc giữ nguyên) | ✅ v0.4.0 |
| 5 | Sổ ghi chép chia đôi màn hình (nền kẻ dòng / ô / chấm, liên kết về trang sách) | ✅ v0.5.0 |
| 6 | Trải nghiệm học: focus mode, đồng hồ học + gợi ý nghỉ, ánh sáng / màu trang, âm thanh thư giãn, kế hoạch học | ✅ v0.6.0 |
| 7 | Tìm kiếm chữ, sửa bảng mã font, OCR chạy ngầm (v0.7.1: OCR ngay khi nhập, mọi trang không bình thường) | ✅ v0.7.1 |
| 8 | Mở file Word .docx (giữ file gốc, dàn trang, tìm được chữ, viết/xuất như PDF) | ✅ v0.8.0 |
| 9 | Cắt chữ/hình từ sách kéo sang vở (di chuyển, hoàn tác, chạm để về trang gốc, xuất PDF) | ✅ v0.9.0 |
| 9.1 | Thêm trang vở bằng dấu ＋ giữa các trang, phóng to/thu nhỏ và sửa chữ khối đã dán, tạm dừng OCR | ✅ v0.9.1 |
| 9.2 | Trang vở chỉ để viết: xóa trang qua menu ⋯ ở danh sách trang / số trang của vở, có Hoàn tác | ✅ v0.9.2 |
| Bản 2 | Giao diện thư viện / kệ / bàn học | |

## Cài lên Pad

1. Mở link trên bằng **Chrome** (chế độ thường, không ẩn danh).
2. Menu ⋮ → **Thêm vào màn hình chính / Cài đặt ứng dụng**.
3. Mở app một lần khi có mạng, sau đó dùng offline được.

## Dành cho người phát triển

```bash
npm install
npm run dev          # chạy thử ở máy
npm test             # kiểm thử đơn vị
npm run build && npm run fixtures && npm run test:e2e   # kiểm thử end-to-end trong Chrome
```

Kiến trúc và quy ước: xem [ARCHITECTURE.md](ARCHITECTURE.md). Mỗi lần đẩy lên `main`, GitHub Actions chạy toàn bộ kiểm thử; chỉ khi pass hết mới đăng bản mới. Mỗi mốc được gắn tag (`v0.1.0`, ...) để quay lại khi cần.

## Giai đoạn 2 – Giao diện (phong cách "Thư viện cổ")

| Mốc | Nội dung | Trạng thái |
|---|---|---|
| v1.0 | Bộ phong cách: màu gỗ óc chó/giấy da/xanh thư viện/vàng đồng, chữ EB Garamond + Cormorant Garamond (có sẵn offline), biểu tượng nét khắc, hai chế độ Giấy da / Ánh nến | ✅ v1.0.0 |
| v1.1 | Không gian thư viện 3D: mỗi danh mục là một dãy tủ, danh mục con là tầng kệ; gáy sách theo màu bìa và số trang; vuốt để lướt kệ; rút sách ra xem bìa thật, mở đọc; nhớ chỗ đang đứng | ✅ v1.1.0 |
| v1.2 | Bàn học: lấy sách xuống bàn (tối đa 6), khoảng trống trên kệ, bụi và lời nhắc cất | |
| v1.3 | Bảng ghim 3D: việc hôm nay, kế hoạch tuần, dự định, sự kiện sắp tới | |
| v1.4 | Sảnh, chuyển cảnh giữa các khu, hướng dẫn lần đầu | |
| v1.5 | Màn hình đọc theo phong cách mới và hoàn thiện | |

## Cần quan tâm (chưa test / để sau)

- **File Word (.docx)** – chưa được test với file thật (người dùng chưa có file). Khi có file: kiểm tra dàn trang, font thay thế trên máy tính bảng, bảng/hình, đầu trang – chân trang – số trang (chưa hiển thị).

## Giai đoạn tiếp theo (theo thứ tự)

1. Chức năng và trải nghiệm người dùng cho chắc (đang làm).
2. Giao diện UI/UX, front-end (thư viện/kệ/bàn học).
3. Quản lý tài nguyên (bộ nhớ vượt 2 GB cho người đọc nhiều sách).
4. Bảo mật (tài liệu của hãng hàng không phải được bảo vệ).
