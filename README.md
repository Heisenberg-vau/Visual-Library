# Visual Library

App đọc và ghi chú tài liệu cho Xiaomi Pad 8 Pro + Focus Pen Pro. Đây là một PWA: mở link trên Chrome rồi cài như app thường, dùng được offline, mọi dữ liệu nằm trên máy.

**Link app:** https://heisenberg-vau.github.io/Visual-Library/

## Lộ trình phiên bản 1

| Mốc | Nội dung | Trạng thái |
|---|---|---|
| 1 | Nhập PDF, kệ sách, nhảy trang, mục lục, ảnh thu nhỏ, zoom | ✅ v0.1.0 |
| 2 | Viết tay: bút nét cố định, highlight, tẩy, undo | |
| 3 | Xuất "bản có ghi chú" ra file PDF mới (bản gốc giữ nguyên) | |
| 4 | Trang ghi chú trắng: kẻ dòng / ô vuông / chấm | |
| 5 | Tìm kiếm chữ, sửa bảng mã font, OCR chạy ngầm | |
| 6 | Mở file Word .docx | |

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
