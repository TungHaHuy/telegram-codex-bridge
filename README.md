# Telegram ↔ Codex trên Windows

Điều khiển các chat Codex trên máy bằng Telegram: gửi prompt, gửi ảnh, steer khi
Codex đang làm và nhận phản hồi/lỗi về điện thoại. Chế độ Bot API chạy bằng
Node.js có sẵn, không cần npm install. Chế độ tài khoản cá nhân có bước cài thêm
bên dưới. Không cần OpenAI API key, server công khai hay tunnel.

Đây là cầu nối tự viết, dùng các công cụ của Codex App đang mở. Máy và Codex App
phải chạy thì bot mới hoạt động. Tắt bot không xóa các chat Codex.

Lịch sử thay đổi và kiểm thử: [CHANGELOG.md](CHANGELOG.md).

## Chức năng

- `/projects` → chọn project → **＋ New chat** và tối đa 20 chat gần nhất trong project.
- `/projects` và `/chats` hiển thị danh sách trong một menu, không chia mỗi 10 mục thành tin riêng.
- Bấm New chat → nhập tên chat → gửi prompt đầu tiên để tạo chat trong đúng project.
  Tin nhập tên chưa chạy model; prompt đầu tiên có thể kèm ảnh hoặc file.
- Mỗi chat có topic Telegram riêng khi dùng nhóm bật Topics.
- Chỉ chat được chọn hoặc được bạn nhắn trong topic mới được theo dõi; chọn chat
  từ menu nhập tối đa 20 lượt hỏi–đáp đã hoàn tất gần nhất một lần, chat mới trên desktop không tự xuất hiện.
- Nhắn trong topic để gửi prompt hoặc steer; phản hồi/lỗi từ prompt Telegram tự về.
- Đường dẫn file local trong phản hồi được thay bằng file đính kèm, xen giữa
  các đoạn chữ theo đúng thứ tự. Hỗ trợ link Markdown, đường dẫn trong backtick
  và đường dẫn Windows thông thường; link web giữ nguyên. File không tồn tại,
  vượt 50 MB hoặc gửi lỗi sẽ hiện đường dẫn kèm lý do. Bot không tự gửi file
  `.env`, dữ liệu đăng nhập/runtime riêng hay thư mục; artifact trong
  `.codex/visualizations` vẫn được phép gửi.
- `/update` lấy phần desktop chưa gửi, chỉ sau prompt Telegram gần nhất của chat.
  Chưa có prompt Telegram thì `/update` chưa nhập tin desktop. Prompt Telegram tự cập nhật.
- Báo ngay khi chat được chọn chờ cấp quyền hoặc chờ bạn trả lời trong App.
- Câu hỏi lựa chọn của Codex được chuyển ngay với đầy đủ nội dung/lựa chọn,
  kể cả prompt đến từ desktop và lượt chat vẫn đang chạy; không cần `/update`.
  Phản hồi desktop thông thường vẫn chờ `/update` như trước.
- `/cancel` dừng đúng lượt đang chạy trong topic hiện tại.
- Gửi ảnh Photo hoặc tài liệu dưới dạng Document, có thể kèm caption làm yêu cầu.
- `/quota` xem hạn mức tài khoản và thời điểm reset theo giờ Việt Nam.
- `/start` bật Codex; `/restart` tắt rồi mở lại đúng gói Codex trên máy (có thể
  ngắt các lượt đang chạy). Bot vẫn nhận lệnh khi Codex chưa mở.
- `/model` đổi model cho các lượt tiếp theo của chat trong topic hiện tại.
  Menu đọc danh mục model hiện có của Codex và xác nhận lại cài đặt sau khi đổi.
- `/effort` chọn mức suy nghĩ model hiện tại hỗ trợ, giữ nguyên model và áp dụng
  từ lượt tiếp theo. Menu cũ không dùng được nếu model đã đổi.
- Yêu cầu cấp quyền được hỗ trợ có nút cho phép/từ chối ngay trong topic. Chỉ
  chủ bot hoặc chủ nhóm/admin trong group đã liên kết được chọn; quyết định
  gắn với đúng nội dung yêu cầu đang chờ. Login,
  OTP, xác minh danh tính và form khác vẫn làm trong App.
- Phản hồi chốt có `[end]` ở cuối; tin tiến độ và câu hỏi không có marker này.

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

Tài khoản đã ghép vẫn điều khiển được trong private chat và đúng nhóm cấu hình.
Các tài khoản khác điều khiển được trong nhóm đó khi là chủ nhóm hoặc admin;
bot kiểm tra quyền hiện tại qua [getChatMember](https://core.telegram.org/bots/api#getchatmember)
mỗi tin/lần bấm nút, không cần ghép lại hay sửa ownerId. Bot phải là admin nhóm.
Thành viên thường, bot và nhóm khác bị từ chối; private chat không mở cho các
admin khác. Khi dùng tài khoản thứ hai, tắt **Remain Anonymous** và gửi với danh
tính tài khoản cá nhân. Chỉ cấp admin cho tài khoản được quyền điều khiển máy.
Nhóm nhận phản hồi của các chat Codex local đang được theo dõi.

Nếu dùng hai máy, cập nhật code và khởi động lại bot trên từng máy cần hỗ trợ
quyền này. Mỗi máy giữ nguyên token, phiên Telegram và cấu hình group riêng.

Nếu không dùng Topics, `/chats` chọn chat cho tin tiếp theo; Reply một tin của
bot cũng gửi vào đúng chat của tin đó. Trong topic, chính topic quyết định tuyến,
không bị lựa chọn chat cũ hoặc Reply sang chat khác ghi đè.

## Hiển thị lịch sử đúng người gửi

Chọn chat từ menu tạo/mở topic và nhập một lần 5 lượt hỏi–đáp hoàn tất gần nhất.
Dùng `/update` để lấy phần mới từ prompt trên desktop,
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
| `/projects` | Menu project → New chat và tối đa 20 chat gần nhất |
| `/start` | Bật Codex nếu chưa chạy, kiểm tra App sẵn sàng |
| `/restart` | Dừng cây tiến trình Codex và mở lại; có thể ngắt công việc đang chạy |
| `/model` | Menu model cho chat trong topic hiện tại, áp dụng lượt tiếp theo |
| `/effort` | Chọn mức suy nghĩ được model hiện tại hỗ trợ, giữ nguyên model |
| `/chats` | Chọn chat local có sẵn, tạo/mở topic nếu đang dùng Topics |
| `/status` | Xem trạng thái chat của topic hoặc chat đang chọn |
| `/quota` | Xem hạn mức tài khoản, giờ reset và credit khi App cung cấp |
| `/update` | Lấy phần desktop chưa gửi sau prompt Telegram gần nhất của chat |
| `/cancel` | Dừng lượt đang chạy trong topic; nếu đang New chat thì hủy bước tạo |
| `/help` | Hướng dẫn ngắn |

Trong nhóm dùng được cả `/projects` và `/projects@ten_bot_cua_ban`;
các lệnh khác cũng nhận hậu tố đúng tên bot.

Gửi ảnh hoặc file ngay trong topic. Caption trở thành yêu cầu; ảnh không caption
dùng yêu cầu mặc định xem/phân tích ảnh, Document dùng yêu cầu đọc/phân tích file.
Sau New chat, nhập tên một dòng tối đa 80 ký tự trước, rồi mới gửi ảnh/file hoặc
prompt đầu tiên. `/cancel` hủy được ở cả hai bước; lỗi tải giữ nguyên tên đã nhập.
File tải xuống được kiểm tra định dạng và lưu dưới tên ngẫu nhiên trong
`.telegram-codex/inbox/`. Codex nhận đường dẫn và mở ảnh bằng `view_image`,
vì công cụ gửi prompt của App hiện chỉ nhận văn bản. Không thay ảnh bằng OCR.
Giới hạn tải là 20 MiB/file theo Bot API; chưa gom album thành một prompt.
Document giữ phần mở rộng trong tên lưu riêng tại inbox. Codex nhận đường dẫn
và dùng công cụ phù hợp để đọc; bridge không tự chạy file. Việc đọc từng định
dạng còn phụ thuộc công cụ có trên máy. Voice/video chưa được nhận bằng loại
tin riêng; có thể gửi chúng dưới dạng Document.

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
và `stderr.log`. Khi bot khởi động, bot dùng cùng quy trình với `/start` để mở
Codex, chờ App sẵn sàng rồi mới đọc các chat đã chọn. Nếu chưa mở/kết nối được,
bot báo lỗi và thử lại; vẫn nhận lệnh Telegram trong lúc chờ.

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
- Khi chọn chat cũ từ menu, bot nhập một lần 5 lượt hỏi–đáp hoàn tất gần nhất,
  theo thứ tự cũ đến mới. Bỏ lượt đang chạy và log công cụ; phần đã gửi không
  bị lặp khi chọn lại. Bước nhập lịch sử này độc lập với mốc của `/update`.
- Nguồn Telegram được nhận diện bằng prompt đã ghi trước khi gửi và item trả về
  từ App. Khi steer một lượt desktop từ Telegram, phần sau prompt steer tự cập nhật;
  phần desktop trước prompt đó nằm ngoài phạm vi `/update` và không nhập lại.
  Mỗi item đọc tối đa 20.000 ký tự. Máy phải bật/mạng.
- Chờ quyền được phát hiện bằng trạng thái `waitingOnApproval`, kiểm tra mỗi 3 giây.
  Bot gửi nội dung và nút quyết định cho loại yêu cầu đã hỗ trợ; các loại khác
  vẫn báo để xem và xử lý trong Codex App.
- Câu hỏi `request_user_input_async` được App Tools trả như agent message đã chốt
  với call ID; không áp dụng bộ lọc streaming/desktop cho câu hỏi mới hoặc đang
  diễn ra. Mốc đã gửi chống lặp; không nhập lại câu hỏi lịch sử đã hoàn tất khi
  vừa chọn chat. Bot không tự chọn câu trả lời hoặc tự duyệt quyền.
- Sau khi bot gửi câu hỏi mới, tin nhắn tiếp theo trong topic được dùng làm câu
  trả lời và đóng đúng thẻ một lần. `/quota`, `/update` và các lệnh điều khiển
  không tính là câu trả lời; `/cancel` hủy trạng thái chờ. Tin tiếp sau câu trả
  lời trở lại đường gửi prompt thường. Câu hỏi lịch sử không chặn prompt mới.
  Bot đọc metadata đúng call ID trong `<CODEX_HOME>/sessions` để xác định thẻ.
  Nếu Codex đã ngắt theo dõi chat khi để lâu, bridge mở lại chat trước khi gửi
  câu trả lời. Nếu chưa chuẩn bị được thao tác đóng thẻ, bot báo và gửi nguyên
  tin nhắn theo đường thường; sau khi đã gửi mà mất xác nhận thì không gửi lại.
- `/cancel` dùng pipe phối hợp `codex-ipc` của Desktop với ID lượt cụ thể, không
  gửi prompt yêu cầu dừng. Giao thức nội bộ có thể đổi khi App cập nhật; lỗi hoặc
  mất xác nhận được báo rõ và không giả vờ đã dừng. Lệnh không xóa cuộc trò chuyện.
- Nếu gửi prompt hoặc tạo chat mất kết nối, kiểm tra Codex trước khi gửi lại:
  bot không tự lặp thao tác chưa rõ kết quả. Thông báo Telegram vẫn có thể lặp
  nếu mạng đứt ngay sau khi Telegram nhận tin.
- Chỉ chat/project Codex local; chưa hỗ trợ chat cloud, tin voice/video trực tiếp,
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
Input trong `codex_delegation` được giải mã đúng một lớp XML trước khi đối chiếu
nguồn, để prompt chứa mã HTML/XML vẫn nhận phản hồi tự động từ Telegram.

Khi `list_threads` trả `projectId: null` cho chat mới/đang mở, bridge đối chiếu
liên kết project đã lưu trong `<CODEX_HOME>/.codex-global-state.json` (mặc định
`~/.codex`). Chỉ dùng liên kết local rõ ràng tới project còn tồn tại, không suy
đoán theo thư mục làm việc. Chat được đánh dấu không thuộc project, liên kết host
khác và `projectId` đã có từ App được giữ nguyên. File thiếu hoặc chưa đọc được
thì dùng danh sách App như trước; bridge không sửa dữ liệu project của Codex.
