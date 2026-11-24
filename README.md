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
| v1.1.1 | Mỗi tủ 4 tầng bằng nhau; vào tủ là thấy đủ 4 tầng, chỉ vuốt ngang | ✅ v1.2.0 |
| v1.2 | Bàn học: mở sách là sách nằm trên bàn (tối đa 6, đầy thì đề nghị cất cuốn lâu nhất chưa mở), khoảng trống có phiếu trên kệ, bụi + lời nhắc sau 7 ngày, cất lên kệ bay về đúng chỗ, chạm sách trên bàn để đọc tiếp | ✅ v1.2.0 |
| v1.2.1 | Thay dãy kệ trang trí bằng tranh sơn dầu (vẽ bằng code, lối cổ điển) khung mạ vàng, chậu cây, tượng bán thân, bình gốm, quả địa cầu | ✅ v1.3.0 |
| v1.3 | Bảng ghim 3D: 4 tờ giấy Hôm nay / Tuần này / Dự định / Sự kiện sắp tới hiện kế hoạch thật (ghim đỏ khi sắp tới hạn); chạm tờ giấy để mở mục; tick xong, thêm, sửa ngay trong phòng; loại việc mới "Dự định" | ✅ v1.3.0 |
| v1.4 | Sảnh: lời chào + tóm tắt hôm nay, lối tắt tới bàn học, bảng ghim và từng tủ; camera đi vòng qua lối đi trước các tủ (không xuyên tủ), thời gian theo quãng đường, nhìn về hướng đang đi; nút ‹ › ở mép trái để sang tủ bên cạnh; hướng dẫn lần đầu bay qua từng khu (xem lại trong ⋮); tôn trọng chế độ giảm chuyển động | ✅ v1.4.0 |
| v1.5 | Màn hình đọc: tên sách thành dòng tiêu đề chạy (chữ hoa nhỏ giữa hai vạch đồng, không còn bị cắt), công cụ bút trong khay lõm viền đồng, nền quanh trang là mặt bàn gỗ óc chó có ánh đèn, trang giấy đổ bóng như nằm trên bàn, tay nắm chia đôi bằng đồng, thanh nổi chế độ tập trung bằng gỗ, mở sách hiện dần (tắt khi giảm chuyển động) | ✅ v1.5.0 |
| v1.5.1 | Vạch đồng mảnh dưới tiêu đề chạy cho biết đang ở đâu trong sách; chạm vào tranh trên tường ở sảnh để treo ảnh của bạn (thu nhỏ ≤ 1600 px, JPEG, chỉ lưu trên máy), có thể treo lại tranh gốc | ✅ v1.5.1 |
| v1.6 | Màn hình đọc "giấy là trung tâm": viền trên mỏng tự ẩn khi đọc/viết (cuộn ngược lên hoặc chạm mép trên để hiện), tên sách + số trang cùng một kiểu chữ; hộp bút gắn mép (mặc định bên phải) với 3 ô nhanh (giữ để cất bút), bảng công cụ/màu/nét; giữ 1 ngón để mở vòng chọn nhanh; chạm 2 ngón hoàn tác, 3 ngón làm lại; mọi thứ khác trong Ngăn kéo ⋯ có ô tìm lệnh; số trang/thu phóng hiện thoáng qua; giấy luôn trắng; trang chừa chỗ cho hộp bút. Sửa: cập nhật thông tin sách trong một giao dịch duy nhất (trước đây hai lần lưu gần nhau có thể ghi đè nhau, ví dụ số trang vở vừa khôi phục) | ✅ v1.6.0 |
| v1.6.1 | Sửa theo góp ý trên Pad: các tủ cách nhau đủ rộng để camera ở tủ 2 trở đi không bị tủ trước chắn; rời tủ về sảnh camera chỉ quay một chiều (không xoay vòng); viền trên chỉ phủ cột sách, vở lên sát mép trên; hộp bút thành thanh dọc kín chiều cao (không còn khoảng hở); thanh chia đôi chỉ to lên một chút và phát sáng khi chạm; chữ trên đầu vở rõ nét hơn | ✅ v1.6.1 |
| v1.6.2 | Sửa: tay tì lên màn hình (lòng bàn tay, ngón đặt sẵn) + 1 ngón vuốt không còn bị hiểu là chụm để phóng to; nút ⋯ chạm lần hai là đóng menu (trước đây đóng rồi mở lại ngay) | ✅ v1.6.2 |
| v1.6.3 | Phòng 3D: thanh trên mỏng, mờ; chữ "Visual Library" là nút về Sảnh, kèm vị trí đang đứng; 5 nút gom vào một nút ⋯ mở Ngăn kéo (Đi tới: Sảnh, Bàn học, Bảng ghim · Thư viện: Nhập sách vào tủ đang đứng, Danh sách & quản lý · Tuỳ chọn: chữ gáy, xem lại hướng dẫn); chạm ⋯ lần nữa là đóng | ✅ v1.6.3 |

## Giai đoạn 3 – Quản lý lưu trữ (xương sống của hệ thống)

Mục tiêu: không mất dữ liệu, biết rõ dung lượng, dọn được, toàn vẹn, sẵn chỗ cho mã hóa ở giai đoạn 4. Quy mô thử nghiệm: ~10 GB / ~1.000 cuốn. Trình duyệt chính: Brave (Android).

| Mốc | Nội dung | Trạng thái |
|---|---|---|
| v2.0 | Kho lưu trữ: dung lượng theo tủ/cuốn/loại dữ liệu; trạng thái lưu bền + nút bật; kiểm tra toàn vẹn (nhanh/kỹ, chỉ báo cáo); chẩn đoán thiết bị (trình duyệt, chạy như app, chọn thư mục, ghi/đọc thử 200 MB so từng byte, dấu kiểm tra qua khởi động lại). Nền móng: mọi lần đọc-sửa-ghi gom vào một giao dịch (sửa 4 lỗi ghi đè: vị trí đọc khi chuyển kệ/gắn thẻ/xóa kệ, giờ học, trang đã đọc); xóa sách lúc đang lập chỉ mục không còn để lại chữ mồ côi; test nâng cấp CSDL từ mọi phiên bản cũ | ✅ v2.0.0 |
| v2.1 | Sao lưu & khôi phục (toàn bộ hoặc chỉ ghi chú, tăng dần, mã kiểm tra SHA-256 từng file, xác minh khi khôi phục), tuỳ chọn khóa bằng mật khẩu (AES-GCM) | |
| v2.2 | Thư mục thư viện trên máy – chỉ nếu trình duyệt hỗ trợ (Brave Android: nhiều khả năng không) | |
| v2.3 | Dọn dẹp: thùng rác 30 ngày, bản trùng, dữ liệu tạo lại được, kho lạnh (gỡ file, giữ ghi chú) | |
| v2.4 | Độ bền ở 10 GB: tắt app giữa chừng, máy đầy, ~1.000 cuốn | |

## Cần quan tâm (chưa test / để sau)

- **File Word (.docx)** – chưa được test với file thật (người dùng chưa có file). Khi có file: kiểm tra dàn trang, font thay thế trên máy tính bảng, bảng/hình, đầu trang – chân trang – số trang (chưa hiển thị).

## Giai đoạn tiếp theo (theo thứ tự)

1. Chức năng và trải nghiệm người dùng cho chắc (xong).
2. Giao diện UI/UX, front-end (xong, v1.0–v1.6).
3. Quản lý lưu trữ (đang làm – xem bảng Giai đoạn 3).
4. Bảo mật (tài liệu của hãng hàng không phải được bảo vệ).
