# Telegram ↔ Codex trên Windows

Điều khiển các chat Codex trên máy bằng Telegram: gửi prompt, gửi ảnh, steer khi
Codex đang làm và nhận phản hồi/lỗi về điện thoại. Chế độ Bot API chạy bằng
Node.js có sẵn, không cần npm install. Chế độ tài khoản cá nhân có bước cài thêm
bên dưới. Không cần OpenAI API key, server công khai hay tunnel.

Đây là cầu nối tự viết, dùng các công cụ của Codex App đang mở. Máy và Codex App
phải chạy thì bot mới hoạt động. Tắt bot không xóa các chat Codex.

## Chức năng

- `/projects` → chọn project → **＋ New chat** và 5 chat gần nhất trong project.
- Bấm New chat rồi gửi prompt đầu tiên để tạo chat trong đúng project.
- Mỗi chat có topic Telegram riêng khi dùng nhóm bật Topics.
- Chỉ chat được chọn hoặc được bạn nhắn trong topic mới được theo dõi; mở topic
  không tự nhập lịch sử và chat mới trên desktop không tự xuất hiện.
- Nhắn trong topic để gửi prompt hoặc steer; phản hồi/lỗi từ prompt Telegram tự về.
- `/update` lấy phần desktop chưa gửi, chỉ sau prompt Telegram gần nhất của chat.
  Chưa có prompt Telegram thì chưa nhập lịch sử. Prompt Telegram tự cập nhật.
- Báo ngay khi chat được chọn chờ cấp quyền hoặc chờ bạn trả lời trong App.
- Câu hỏi lựa chọn của Codex được chuyển ngay với đầy đủ nội dung/lựa chọn,
  kể cả prompt đến từ desktop và lượt chat vẫn đang chạy; không cần `/update`.
  Phản hồi desktop thông thường vẫn chờ `/update` như trước.
- `/cancel` dừng đúng lượt đang chạy trong topic hiện tại.
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

## Hiển thị lịch sử đúng người gửi

Chọn chat chỉ tạo/mở topic. Dùng `/update` để lấy phần mới từ prompt trên desktop,
từ sau prompt Telegram gần nhất, theo thứ tự cũ đến mới, gồm prompt, lời trả lời/
progress đã chốt và lỗi. Phần đang stream,
reasoning và log công cụ không được chuyển. Tin đã gửi không được nhập lại.

Mặc định Bot API trích dẫn prompt bằng nhãn `Bạn:` và gửi lời trả lời từ bot.
Để **prompt thực sự là tin từ tài khoản của bạn**, còn response là tin từ bot,
cần đăng nhập thêm Telegram cá nhân bằng MTProto. Chỉ bật nếu bạn đồng ý cho
ứng dụng gửi các prompt lịch sử vào nhóm riêng đã cấu hình.

1. Đăng nhập [my.telegram.org/apps](https://my.telegram.org/apps), tạo API app của
   chính bạn và đọc/chấp nhận [Telegram API Terms](https://core.telegram.org/api/terms).
   Lấy `api_id` và `api_hash`; không dùng token BotFather thay cho hai giá trị này.
2. Cài phần phụ thuộc riêng cho chức năng tài khoản cá nhân và chạy setup:

   ```powershell
   npm install --prefix .telegram-codex/user-client --save-exact teleproto@1.230.1 qrcode@1.5.4
   node scripts/telegram_user.mjs --login
   ```

3. Nhập api_id/api_hash khi được hỏi. Mở `.telegram-codex/user-login-qr.png`,
   dùng Telegram điện thoại → Settings → Devices → Link Desktop Device để quét.
   Nếu có mật khẩu 2 bước, nhập trong terminal (ẩn ký tự). QR được làm mới khi
   Telegram yêu cầu; file QR bị xóa khi setup kết thúc.
4. Setup chỉ lưu phiên nếu ID tài khoản khớp đúng người đã ghép bot. Khởi động
   lại bridge; nó chỉ gửi lịch sử bằng tài khoản cá nhân vào đúng nhóm cấu hình.
   Có thể thu hồi phiên trong Telegram → Settings → Devices.

API hash và phiên đăng nhập nằm trong `.telegram-codex/user-session.json`, cùng
folder riêng đã được bảo vệ và gitignore. Không gửi chúng vào issue hoặc commit.
Các tin prompt do bridge nhập lại được ghi nhận ID để **không chạy lại trong
Codex**; tin người dùng mới vẫn được gửi bình thường. Nếu phiên hết hạn, phần
nhập lịch sử báo lỗi; các chức năng bot khác vẫn chạy.

Kiểm thử tự động bao phủ việc giữ đúng vai và không chạy lại prompt lịch sử,
kể cả update đến trước khi thao tác gửi trả về. Cần hoàn tất đăng nhập cá nhân
trên từng máy và kiểm tra topic thật trước khi coi cấu hình máy đó đã sẵn sàng.
Bản triển khai đã kiểm chứng trên nhóm riêng: 5 prompt mang đúng tài khoản chủ
bot, xen kẽ 5 response từ bot; lịch sử Codex không xuất hiện lượt chạy mới.

## Các lệnh và ảnh

| Lệnh | Tác dụng |
| --- | --- |
| `/projects` | Menu project → New chat và 5 chat gần nhất |
| `/chats` | Chọn chat local có sẵn, tạo/mở topic nếu đang dùng Topics |
| `/status` | Xem trạng thái chat của topic hoặc chat đang chọn |
| `/quota` | Xem hạn mức tài khoản, giờ reset và credit khi App cung cấp |
| `/update` | Lấy phần desktop chưa gửi sau prompt Telegram gần nhất của chat |
| `/cancel` | Dừng lượt đang chạy trong topic; nếu đang New chat thì hủy bước tạo |
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

Để bot tự chạy ẩn khi đăng nhập Windows, sau khi đã ghép tài khoản Telegram:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install_telegram_startup.ps1
```

Script tạo task **Codex Telegram Bridge** cho tài khoản Windows hiện tại và bật
ngay. Task không lưu mật khẩu, không yêu cầu quyền admin, không bị giới hạn thời
gian chạy và chỉ chạy một phiên task. Nếu Codex hoặc mạng chưa sẵn sàng khiến
bot thoát lỗi, launcher chờ 15 giây rồi thử lại, không giới hạn số lần.
Task Scheduler vẫn thử lại mỗi phút, tối đa 255 lần nếu chính launcher gặp lỗi.
Log ở `.telegram-codex/stdout.log`
và `stderr.log`. Codex App cũng cần tự bật cùng Windows hoặc được bạn mở sau đó.

Kiểm tra cấu hình startup và tiến trình đang chạy:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\test_telegram_startup.ps1
```

Khi dùng startup, dừng bot bằng `Stop-ScheduledTask` để task không coi việc dừng
là lỗi cần chạy lại. Tắt tự bật và dừng ngay bằng:

```powershell
Disable-ScheduledTask -TaskName 'Codex Telegram Bridge'
Stop-ScheduledTask -TaskName 'Codex Telegram Bridge'
```

Không chạy bản foreground đồng thời với task startup. Nếu chuyển thư mục repo,
chạy lại script cài startup tại vị trí mới sau khi xóa task cũ trong Task Scheduler.

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

- Secret được lưu bằng JSON local, không ghi vào mã nguồn và không cần dotenv:

  | File riêng trên máy | Nội dung |
  | --- | --- |
  | `.telegram-codex/config.json` | Token BotFather, ID chủ bot/nhóm và chat cầu nối |
  | `.telegram-codex/user-session.json` | Telegram api_id/api_hash và phiên đăng nhập cá nhân |
  | `.telegram-codex/state.json` | Tuyến topic, mốc đọc và các prompt lịch sử cần bỏ qua |

  Cả folder `.telegram-codex/` được ignore, bao gồm ảnh, log, QR và thư viện
  cài riêng. `.env` và `.env.*` cũng bị ignore. Bridge đọc hai file JSON nêu trên,
  không tự đọc `.env`.
  Không dùng `git add -f` cho dữ liệu riêng. Khi chuyển máy, cấu hình/đăng nhập
  lại bằng hướng dẫn setup; Git không mang token hoặc phiên đăng nhập sang máy khác.

- Toàn bộ token, ID tài khoản/nhóm/chat, routes, lịch sử mốc đọc, ảnh nhận, PID
  nằm trong `.telegram-codex/`, được gitignore. Folder giới hạn quyền cho tài khoản
  Windows hiện tại và SYSTEM. Bản nguồn không chứa cấu hình cá nhân đã ghép.
- Menu liệt kê 50 chat local gần nhất và chat ghim. Chỉ chat được chọn hoặc được
  nhắn trong topic mới được theo dõi. Topic tự tạo từ bản cũ giữ nguyên nhưng
  không tự theo dõi lại; chat được chọn gần nhất được giữ khi nâng cấp.
- Nguồn Telegram được nhận diện bằng prompt đã ghi trước khi gửi và item trả về
  từ App. Khi steer một lượt desktop từ Telegram, phần sau prompt steer tự cập nhật;
  phần desktop trước prompt đó nằm ngoài phạm vi `/update` và không nhập lại.
  Mỗi item đọc tối đa 20.000 ký tự. Máy phải bật/mạng.
- Chờ quyền được phát hiện bằng trạng thái `waitingOnApproval`, kiểm tra mỗi 3 giây.
  Bot báo một lần mỗi đợt chờ. Duyệt và xem chi tiết yêu cầu trong Codex App.
- Câu hỏi `request_user_input_async` được App Tools trả như agent message đã chốt
  với call ID; không áp dụng bộ lọc streaming/desktop cho câu hỏi mới hoặc đang
  diễn ra. Mốc đã gửi chống lặp; không nhập lại câu hỏi lịch sử đã hoàn tất khi
  vừa chọn chat. Bot không tự chọn câu trả lời hoặc tự duyệt quyền.
- `/cancel` dùng pipe phối hợp `codex-ipc` của Desktop với ID lượt cụ thể, không
  gửi prompt yêu cầu dừng. Giao thức nội bộ có thể đổi khi App cập nhật; lỗi hoặc
  mất xác nhận được báo rõ và không giả vờ đã dừng. Lệnh không xóa cuộc trò chuyện.
- Nếu gửi prompt hoặc tạo chat mất kết nối, kiểm tra Codex trước khi gửi lại:
  bot không tự lặp thao tác chưa rõ kết quả. Thông báo Telegram vẫn có thể lặp
  nếu mạng đứt ngay sau khi Telegram nhận tin.
- Chỉ chat/project Codex local; chưa hỗ trợ chat cloud, video/audio đầu vào,
  gom album hoặc tự bật nguồn máy. Không có lệnh tắt máy.

Tài liệu nền: [Telegram Bot API](https://core.telegram.org/bots/api),
[OpenAI Docs: image inputs](https://learn.chatgpt.com/docs/image-inputs).

## Ghi chú bảo trì

Lệnh nhóm phải được chuẩn hóa một lần tại điểm nhận; kiểm tra hậu tố thuộc đúng
bot. Đọc lịch sử một lượt/lần và cô lập lỗi từng chat vì response có giới hạn
kích thước. Khi tạo chat, đăng ký mốc rỗng trước lượt scan tiếp theo để không mất
phản hồi đầu quá nhanh. Các tình huống này có kiểm tra hồi quy trong test hiện có.
Tin gửi bằng phiên cá nhân sẽ quay về Bot API như tin của chủ bot: phải ghi nhận
ID và chờ thao tác nhập lịch sử đang chạy trước khi xử lý update, tránh lặp prompt.

Khi `list_threads` trả `projectId: null` cho chat mới/đang mở, bridge đối chiếu
liên kết project đã lưu trong `<CODEX_HOME>/.codex-global-state.json` (mặc định
`~/.codex`). Chỉ dùng liên kết local rõ ràng tới project còn tồn tại, không suy
đoán theo thư mục làm việc. Chat được đánh dấu không thuộc project, liên kết host
khác và `projectId` đã có từ App được giữ nguyên. File thiếu hoặc chưa đọc được
thì dùng danh sách App như trước; bridge không sửa dữ liệu project của Codex.
