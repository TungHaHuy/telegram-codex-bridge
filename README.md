# Telegram ↔ Codex trên Windows

Điều khiển các chat Codex trên máy bằng Telegram: gửi prompt, gửi ảnh, steer khi
Codex đang làm và nhận phản hồi/lỗi về điện thoại. Chạy bằng Node.js có sẵn,
không cần npm install, OpenAI API key, server công khai hay tunnel.

Đây là cầu nối tự viết, dùng các công cụ của Codex App đang mở. Máy và Codex App
phải chạy thì bot mới hoạt động. Tắt bot không xóa các chat Codex.

## Chức năng

- `/projects` → chọn project → **＋ New chat** và 5 chat gần nhất trong project.
- Bấm New chat rồi gửi prompt đầu tiên để tạo chat trong đúng project.
- Mỗi chat có topic Telegram riêng khi dùng nhóm bật Topics.
- Nhắn trong topic để gửi prompt hoặc steer; phản hồi và lỗi về cùng topic.
- Gửi ảnh Photo hoặc file PNG/JPEG/WebP, có thể kèm caption làm yêu cầu.
- `/quota` xem hạn mức tài khoản và thời điểm reset theo giờ Việt Nam.

## Yêu cầu

- Windows, PowerShell, Node.js 20 trở lên và Git.
- Codex desktop đã đăng nhập, có bộ công cụ `codex-app-tools` hoạt động.
  Cầu nối sử dụng named pipe local `codex-app-tools-*` của App.
- Một bot Telegram riêng tạo qua [@BotFather](https://t.me/BotFather).
- Chạy bot cùng tài khoản Windows với Codex. Chỉ mở một Codex App nếu không có
  biến môi trường chỉ rõ pipe cần dùng.

Giao diện pipe này là nội bộ của App, có thể đổi khi App cập nhật. Repo không
kèm hoặc cài thay Codex App và plugin của App.

## Cài và ghép tài khoản

1. Clone repo, mở terminal tại thư mục vừa clone:

   ```powershell
   git clone https://github.com/TungHaHuy/telegram-codex-bridge.git
   cd telegram-codex-bridge
   node --version
   ```

2. Trong Telegram, mở @BotFather → `/newbot`, tạo bot và lấy token. Giữ token
   riêng trên máy; không đưa vào issue, ảnh chụp, commit hoặc tin nhắn công khai.

3. Mở một chat Codex dùng làm cầu nối, chạy script từ terminal của chat đó:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start_telegram_codex.ps1
   ```

   Lần đầu script hỏi token bằng ô nhập ẩn. ID chat được lấy từ
   `CODEX_THREAD_ID` hoặc `CODEX_SESSION_ID`; nếu terminal không có hai biến này,
   script hỏi ID chat. Có thể nhờ Codex lấy ID của chat hiện tại bằng công cụ App.
   ID này chỉ lưu trong cấu hình local, không cần sửa mã nguồn.

4. Terminal in link `t.me/...?...` chứa mã ghép ngẫu nhiên. Mở link bằng tài khoản
   Telegram của bạn rồi bấm Start. Chỉ tài khoản gửi đúng mã đó mới được ghép.

5. Khi thấy thông báo đã kết nối, gửi `/projects` hoặc `/chats` cho bot.

Nếu đã có cấu hình, script dùng lại và không hỏi token/ghép lại. Không chạy một
bot token đồng thời với dịch vụ polling khác hoặc webhook khác.

## Tách mỗi chat thành một topic

Sau khi ghép tài khoản ở private chat:

1. Tạo **nhóm Telegram riêng**, chỉ thêm bạn và bot; bật **Topics**.
2. Cho bot làm admin với quyền **Manage Topics**. Bot cần quyền này để tạo topic;
   không cần quyền xóa tin hay thêm admin.
3. Dừng bridge bằng Ctrl+C. Gửi một tin mới trong nhóm để Telegram tạo update.
4. Trong thư mục repo, lấy ID nhóm bằng PowerShell dưới đây. Chỉ chạy bước này
   khi bridge đã dừng để không có hai tiến trình cùng đọc update:

   ```powershell
   $bridgeConfig = Get-Content -Raw .\.telegram-codex\config.json | ConvertFrom-Json
   $bridgeUpdates = Invoke-RestMethod -Method Post `
     -Uri ("https://api.telegram.org/bot" + $bridgeConfig.token + "/getUpdates") `
     -ContentType 'application/json' `
     -Body '{"timeout":0,"allowed_updates":["message"]}'
   $bridgeUpdates.result | ForEach-Object { $_.message.chat } |
     Select-Object id, title, type -Unique
   ```

5. Chọn đúng nhóm vừa tạo (`supergroup`, ID âm), rồi lưu vào cấu hình:

   ```powershell
   $bridgeGroupId = [long](Read-Host 'ID am cua nhom Telegram rieng')
   $bridgeConfig | Add-Member -NotePropertyName chatId -NotePropertyValue $bridgeGroupId -Force
   $bridgeConfig | ConvertTo-Json | Set-Content .\.telegram-codex\config.json -Encoding UTF8
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start_telegram_codex.ps1
   ```

6. Trong nhóm gửi `/projects`, chọn project rồi bấm chat. Bot tạo topic tương
   ứng; tiếp tục nhắn bên trong topic đó. **General** dùng cho menu, không nhận
   prompt cho một chat ngẫu nhiên.

Chỉ tài khoản đã ghép trong private chat và đúng nhóm cấu hình được điều khiển
Codex. Thành viên khác hoặc nhóm khác bị từ chối. Không thêm người lạ vào nhóm:
nhóm nhận nội dung phản hồi của các chat Codex local đang được theo dõi.

Nếu không dùng Topics, `/chats` chọn chat cho tin tiếp theo; Reply một tin của
bot cũng gửi vào đúng chat của tin đó. Trong topic, chính topic quyết định tuyến,
không bị lựa chọn chat cũ hoặc Reply sang chat khác ghi đè.

## Các lệnh và ảnh

| Lệnh | Tác dụng |
| --- | --- |
| `/projects` | Menu project → New chat và 5 chat gần nhất |
| `/chats` | Chọn chat local có sẵn, tạo/mở topic nếu đang dùng Topics |
| `/status` | Xem trạng thái chat của topic hoặc chat đang chọn |
| `/quota` | Xem hạn mức tài khoản, giờ reset và credit khi App cung cấp |
| `/cancel` | Hủy bước nhập prompt để tạo chat mới |
| `/help` | Hướng dẫn ngắn |

Trong nhóm dùng được cả `/projects` và `/projects@ten_bot_cua_ban`;
các lệnh khác cũng nhận hậu tố đúng tên bot.

Gửi ảnh ngay trong topic. Caption trở thành yêu cầu; ảnh không caption dùng yêu
cầu mặc định xem/phân tích ảnh. Ảnh cũng có thể là prompt đầu tiên sau New chat.
File tải xuống được kiểm tra định dạng và lưu dưới tên ngẫu nhiên trong
`.telegram-codex/inbox/`. Codex nhận đường dẫn và mở ảnh bằng `view_image`,
vì công cụ gửi prompt của App hiện chỉ nhận văn bản. Không thay ảnh bằng OCR.
Giới hạn tải là 20 MB/ảnh theo Bot API; chưa gom album thành một prompt.

## Dừng, chạy lại và kiểm tra

Ctrl+C để dừng khi chạy trong terminal. Chạy lại bằng cùng script để tiếp tục
với tài khoản, topic và mốc phản hồi đã lưu. Nếu chạy ẩn, có thể dừng đúng PID:

```powershell
Stop-Process -Id ([int](Get-Content .\.telegram-codex\bridge.pid))
```

Kiểm tra tự động không cần token hoặc mạng; probe đọc thử Codex thật:

```powershell
node tests/test_telegram_codex.mjs
node --check scripts/telegram_codex.mjs
# Chạy từ terminal của chat Codex:
node scripts/telegram_codex.mjs --probe
```

Test bao phủ xác thực người gửi, định tuyến topic/Reply, menu project/tạo chat,
lệnh có hậu tố bot, ảnh/caption/lỗi tải, quota, pipe bị chia frame, streaming,
không lặp phản hồi và không tự gửi lại thao tác chưa rõ kết quả. Bản triển khai
đã được thử thực tế: Telegram → prompt/steer → Codex → đúng topic; ảnh thật được
Codex mở và đọc nội dung. Dữ liệu, ảnh và log của lần thử không nằm trong repo.

## Dữ liệu riêng và giới hạn

- Toàn bộ token, ID tài khoản/nhóm/chat, routes, lịch sử mốc đọc, ảnh nhận, PID
  nằm trong `.telegram-codex/`, được gitignore. Folder giới hạn quyền cho tài khoản
  Windows hiện tại và SYSTEM. Bản nguồn không chứa cấu hình cá nhân đã ghép.
- Bot theo dõi 50 chat Codex local gần nhất, chat ghim và các chat đã chọn/Reply;
  chỉ ghi mốc lúc gặp chat lần đầu, không đổ lịch sử cũ sang Telegram.
- Phản hồi và lỗi được chuyển về Telegram; reasoning và log công cụ không được
  chuyển. Mỗi item lịch sử được đọc tối đa 20.000 ký tự. Máy phải còn bật/mạng.
- Bot không tự duyệt yêu cầu cấp quyền của Codex. Khi cần duyệt, xử lý trên App.
- Nếu gửi prompt hoặc tạo chat mất kết nối, kiểm tra Codex trước khi gửi lại:
  bot không tự lặp thao tác chưa rõ kết quả. Thông báo Telegram vẫn có thể lặp
  nếu mạng đứt ngay sau khi Telegram nhận tin.
- Chỉ chat/project Codex local; chưa hỗ trợ chat cloud, video/audio đầu vào,
  gom album, autorun Windows hoặc tự bật máy. Không có lệnh tắt máy.

Tài liệu nền: [Telegram Bot API](https://core.telegram.org/bots/api),
[OpenAI Docs: image inputs](https://learn.chatgpt.com/docs/image-inputs).

## Ghi chú bảo trì

Lệnh nhóm phải được chuẩn hóa một lần tại điểm nhận; kiểm tra hậu tố thuộc đúng
bot. Đọc lịch sử một lượt/lần và cô lập lỗi từng chat vì response có giới hạn
kích thước. Khi tạo chat, đăng ký mốc rỗng trước lượt scan tiếp theo để không mất
phản hồi đầu quá nhanh. Các tình huống này có kiểm tra hồi quy trong test hiện có.
