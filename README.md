# Gemini Logo Remove — Web UI local

Giao diện web chạy trên máy để dùng engine [GargantuaX/gemini-watermark-remover](https://github.com/GargantuaX/gemini-watermark-remover)
(gói npm `@pilio/gemini-watermark-remover`). Xóa logo watermark nhìn thấy được trên ảnh và video Gemini/Veo.

## Chạy
- **macOS:** double-click `start.command` (lần đầu sẽ tự cài thư viện + Chromium).
- **Hoặc terminal:**
  ```bash
  npm install
  npx playwright install chromium   # chỉ cần cho video
  npm start
  ```
  rồi mở http://localhost:5178

## Dùng
Kéo thả ảnh (PNG/JPG/WEBP) hoặc video (MP4/WEBM/MOV) vào trang. Ảnh có thanh trượt so sánh trước/sau.
Kết quả tải về bằng nút **Tải về** (từng file) hoặc **Tải tất cả** (gộp thành một file .zip), và được lưu luôn trong `output/`.

## Cấu trúc
- `server.mjs` — server Node (không framework). Ảnh xử lý trực tiếp bằng SDK + `sharp`;
  video chạy qua Chromium headless (Playwright) trong process con `video-worker.mjs`, xếp hàng từng file một.
  Hủy được từng video hoặc tất cả khi đang export (server kill process con, file dở bị xóa).
- `public/index.html` — giao diện.
- Đổi cổng: `PORT=8080 npm start`.
