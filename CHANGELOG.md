# Changelog — Telegram ↔ Codex bridge

Lịch sử thay đổi theo ngày phát hành. Các bản cũ có commit Git để đối chiếu;
không tự đặt số phiên bản. Phần kiểm thử phân biệt kết quả thực tế và mô phỏng.

## 27/10/2026 — Thay topic với toàn bộ lịch sử bằng /full

- Gửi `/full` trong topic đã liên kết: tạo topic mới cùng chat Codex, chép toàn
  bộ prompt/phản hồi/progress đã chốt theo thứ tự rồi mới xóa topic cũ. Không
  tạo chat Codex mới, không chạy lại prompt, không giới hạn 20 cặp/20.000 ký tự.
- Đọc bản lưu local một lượt, gồm cả các file lịch sử nối tiếp; không gửi log
  công cụ/reasoning. Ảnh native inline vẫn hiện nhãn `[Ảnh]` theo cách nhập lịch sử.
- Bot cần quyền Delete messages. General/private/topic chưa liên kết bị từ chối.
  Chép lỗi giữ topic cũ; lỗi xóa chưa xác định giữ bản mới đầy đủ, không tự xóa lại.
- Tác vụ chạy nền theo từng chat, chat khác vẫn nhận lệnh. Sau restart, tác vụ
  chưa chép xong quay về topic cũ; tác vụ chép xong không tự lặp bước xóa.
- Chờ và thử lại khi Telegram trả rõ lỗi 429 kèm retry_after; lỗi mạng không rõ
  kết quả không tự gửi lại. Kiểm thử thất bại giữa chừng, thứ tự và topic tạm thật.
- Lưu trạng thái trên Windows chờ ngắn và thử lại tối đa 10 lần khi rename gặp
  đúng EPERM do file bị khóa; không che các lỗi ghi khác hoặc ghi đè không nguyên tử.

## 27/10/2026 — Tự đồng bộ hoạt động desktop

- Tự phát hiện chat local mới, tạo topic tương ứng và chuyển prompt/phản hồi
  mới từ desktop sang Telegram. Không cần chọn chat trước hoặc dùng `/update`.
- Dùng vòng kiểm tra khoảng 3 giây; chỉ đọc lại chat đang chạy hoặc thay đổi.
  Đây là đồng bộ gần thời gian thực, độ trễ còn phụ thuộc Codex và Telegram.
- Lần đầu bật ghi mốc hiện tại của chat cũ để không đổ lại lịch sử. Mốc lưu qua
  lần khởi động tiếp theo; dữ liệu mới sau mốc được đồng bộ, không gửi trùng.
- Giữ tuyến theo topic, phân quyền chủ/admin, chống chạy lại prompt chép lịch sử,
  xử lý cấp quyền và file đính kèm. `/update` còn để tương thích cách đồng bộ cũ.

## 27/10/2026 — Khôi phục prompt và tin nhắn ở lượt lịch sử quá lớn

- Nhánh đọc local nhận đúng cả delegation dạng chuỗi và dạng object của Codex,
  giữ nguồn Telegram để phản hồi tự gửi về đúng topic.
- Tin đã hoàn tất cuối một lượt đang chạy không bị nhầm là tin còn streaming;
  phần ghi JSON chưa hoàn tất ở cuối file đang chạy không chặn đọc lịch sử.
- Kiểm tra với lượt lỗi thật: phục hồi prompt và câu trả lời cuối từ rollout
  hơn 225 MB thành khoảng 12 KB tin nhắn; giữ ID/nội dung trùng App ở lượt đọc được.
- Test bao phủ scan, /update, nhập lịch sử và chống gửi trùng khi fallback.
- Nút menu được xác nhận trước khi đọc Codex. Lỗi Telegram 400 riêng về query
  hết hạn không hủy lựa chọn hoặc đổ thông báo lỗi liên tiếp; các lỗi API khác
  vẫn được báo. Kiểm tra quyền/topic/nội dung và chống quyết định lặp giữ nguyên.

## 26/10/2026 — Sửa lượt lịch sử quá lớn và đăng nhập bằng mã

- Khi App Tools không đọc được một lượt vì vượt giới hạn kích thước, bridge
  đọc tin nhắn từ đúng file lịch sử local. Giữ ID và mốc trang để chống lặp;
  không chuyển reasoning, log công cụ, ảnh nhúng hoặc chỉ dẫn môi trường.
  Mốc hoặc ID không khớp sẽ báo lỗi; file lịch sử gốc không bị sửa.
- Đã tái hiện lỗi trên một rollout gần 196 MB; trang lỗi được đọc thành
  14 item tin nhắn, khoảng 6,8 KB. So khớp một lượt thật với App Tools cho kết
  quả trùng ID/nội dung; bot đã đồng bộ lại chat bị lỗi mà không chạy lại prompt.
- Thêm `node scripts/telegram_user.mjs --login --phone` để đăng nhập bằng số
  điện thoại và mã Telegram thay cho QR. Giữ QR mặc định và kiểm tra đúng chủ
  bot trước khi lưu phiên; mã và mật khẩu hai lớp không được in ra log.
  Telegram quyết định phương thức gửi mã, không ép SMS.
- Kiểm thử tự động bao phủ nguồn/cursor lịch sử, lọc dữ liệu riêng, chống lặp,
  đường đăng nhập bằng mã/QR và từ chối lưu phiên sai chủ. Đăng nhập bằng mã
  cũng đã được người dùng hoàn tất và xác minh đúng tài khoản trên máy triển khai.

## 26/10/2026 — Gộp danh sách chọn project/chat

- `/projects` và `/chats` gửi một menu đầy đủ thay vì tự chia mỗi 10 nút thành
  nhiều tin. Giữ nguyên thứ tự, tuyến topic và dữ liệu callback.
- Test với 12 project và 23 chat xác nhận không tách hai mục cuối thành tin riêng.
- New chat chép prompt đầu tiên từ nơi tạo sang topic mới trước khi gửi phản
  hồi Codex. Tái sử dụng cơ chế gửi lịch sử và bỏ qua tin replay, không chạy
  lại prompt hay tạo thêm lượt. Tin tiếp theo trong đúng topic không bị chép lặp.

## 25/10/2026 — Nâng giới hạn menu và lịch sử lên 20

- Menu project hiển thị New chat và tối đa 20 chat gần nhất, thay cho 5.
- Lần đầu chọn chat có sẵn lấy tối đa 20 cặp prompt–response đã hoàn tất,
  giữ thứ tự cũ đến mới và không nhập lặp lịch sử đã lấy.
- Kiểm thử bao phủ dữ liệu vượt giới hạn, thứ tự, lọc project và bỏ lượt chưa hoàn tất.
- Khi bot khởi động, dùng cùng quy trình với `/start` để mở Codex và chờ App
  sẵn sàng rồi mới quét các chat đã chọn. Nếu mở/chờ thất bại, báo lỗi và thử
  lại; bot vẫn nhận lệnh Telegram trong lúc chờ.
- Cho phép tài khoản Telegram thứ hai điều khiển khi là chủ nhóm/admin của
  đúng group đã liên kết. Kiểm tra quyền bằng getChatMember mỗi tin/bấm nút;
  mất quyền admin thì bị chặn ngay. Private chat vẫn chỉ dành cho chủ bot.
- Từ chối thành viên thường, bot, tin gửi ẩn danh/thay mặt channel và group
  khác. Nếu Telegram không xác nhận được quyền thì không thực hiện lệnh.

## 24/10/2026 — Đặt tên chat, nhận tài liệu và điều khiển Codex

### Thay đổi

- **New chat:** chọn project → nhập tên chat → gửi prompt đầu tiên. Tên là một
  dòng tối đa 80 ký tự, độc lập với nội dung prompt. Nhập tên chưa tạo chat,
  chưa chạy model; chỉ tạo khi nhận prompt đầu tiên thành công.
- Có thể dùng ảnh hoặc tài liệu kèm caption làm prompt đầu tiên sau khi đặt tên.
  `/cancel` hủy được ở cả bước đặt tên lẫn chờ prompt. Lệnh xem trạng thái/hạn
  mức không bị dùng làm tên hoặc prompt tạo chat.

### Bổ sung

- `/start` mở Codex trên máy; nếu đã chạy thì kiểm tra khả năng trả lời, không
  mở thêm phiên. `/restart` dừng cây tiến trình đúng gói Codex đang cài rồi mở
  lại. Các lượt đang chạy có thể bị ngắt. Bot Telegram khởi động độc lập với
  Codex để vẫn nhận được các lệnh này khi App chưa mở.
- `/model` hiện danh mục model từ cache của Codex, đánh dấu model hiện tại và
  đổi cho các lượt tiếp theo trong đúng topic. Giữ effort hiện tại nếu model
  mới hỗ trợ, nếu không dùng effort mặc định của model đó. Danh mục không phải
  bảo đảm mọi model đều có quyền truy cập khi chạy thực tế.
- `/effort` hiện đúng các mức suy nghĩ model hiện tại hỗ trợ và đánh dấu mức
  đang dùng. Chỉ thay effort cho lượt tiếp theo, giữ nguyên model. Nếu model đã
  đổi sau khi mở menu, nút cũ bị từ chối để tránh đổi model ngược lại.
- Nút cấp quyền cho command/file/permissions và các form đồng ý dùng công cụ
  MCP đơn giản. Hiện nội dung yêu cầu và phạm vi trước khi chọn. Nút ràng buộc
  với chủ bot, topic, request ID, nội dung yêu cầu và owner đang xử lý; yêu cầu
  đã đổi/hết hiệu lực không được dùng lại. Chỉ gửi quyết định khi người dùng bấm.
  Không đổi chính sách quyền, không tự duyệt hay lặp quyết định mất xác nhận.
- Phản hồi `final_answer` có `[end]` ở cuối; không thêm vào tiến độ, câu hỏi hoặc
  thông báo điều khiển. Nếu đã có marker thì không thêm lần hai.
- Nhận tài liệu gửi qua Telegram dưới dạng file (Document), ngoài ảnh đã hỗ trợ.
  Giữ phần mở rộng tên file, lưu dưới tên riêng trong inbox, chuyển đường dẫn và
  caption cho Codex đọc bằng công cụ phù hợp. Không tự thực thi file tải về.
- Nếu không có caption, bot yêu cầu Codex đọc và phân tích file. Nếu tải thất
  bại, không gửi riêng caption và không tạo chat; tên đã nhập vẫn được giữ.

### Giới hạn và nâng cấp

- Login, OTP, xác minh danh tính, form yêu cầu dữ liệu khác và loại phê duyệt
  chưa hỗ trợ vẫn xử lý trong Codex App. Giao thức follower là nội bộ và có thể
  thay đổi theo bản App. Không phải mọi hộp thoại Windows đều có nút Telegram.
- Tải vào tối đa 20 MiB mỗi file theo giới hạn của đường tải Bot API đang dùng.
  Không ghép album/nhiều file thành một prompt. Audio/video cần gửi dưới dạng
  Document; chưa xử lý tin voice/video bằng loại tin nhắn riêng.
- Nhận file không có nghĩa mọi định dạng đều đọc được: còn tùy công cụ của Codex
  và dữ liệu trong file. File được lưu riêng, không đưa vào Git.
- Bản nháp New chat từ bản cũ sẽ bắt đầu ở bước đặt tên khi nhận tin tiếp theo.
  Các chat, topic và thông tin đăng nhập hiện có được giữ nguyên.

### Kiểm thử

- `node tests/test_telegram_controls.mjs`: kiểm tra auth, đổi model/phạm vi topic,
  quyết định gắn request, yêu cầu thay đổi, bấm lặp, timeout và marker kết thúc.
  `tests/test_codex_app_control.ps1` kiểm tra start/restart bằng tiến trình giả,
  bao gồm không tác động app khác và dừng đúng cây tiến trình Codex.
- Telegram thật: `/start` trả trạng thái sẵn sàng; `/model` đổi model chat kiểm
  thử rồi khôi phục model cũ; phản hồi prompt kiểm thử có `[end]`. Snapshot yêu
  cầu đọc được từ App thật. Chưa tắt/restart App thật trong lúc triển khai và
  chưa có yêu cầu cấp quyền thật được duyệt qua Telegram trong lần kiểm thử này.
- `/effort` thử thật qua Telegram: đổi low → medium, kiểm tra model không đổi,
  rồi khôi phục effort ban đầu. Kiểm thử tự động thêm trường hợp menu effort cũ
  sau khi model được đổi nơi khác.
- `node --check scripts/telegram_codex.mjs` và
  `node tests/test_telegram_codex.mjs`: kiểm tra tên tách khỏi prompt, phạm vi
  topic, hủy, giữ bản nháp khi lỗi tải, không lặp thao tác tạo chat chưa rõ kết
  quả, ảnh cũ, tài liệu, caption, tên file an toàn và giới hạn tải.
- Kiểm thử menu Telegram thật đến bước đặt tên rồi hủy: tên được lưu, không
  tạo chat sớm. Lệnh tạo chat với tên riêng và file đầu tiên được kiểm tra bằng
  fixture; không tạo thêm chat thực chỉ để kiểm thử.
- Gửi Document thật kèm caption vào chat kiểm thử có sẵn: Codex đọc file và trả
  lại đúng nội dung ở cùng topic. Ảnh/Document đầu tiên trong New chat được kiểm
  tra bằng fixture có xác nhận tên riêng, nội dung prompt và project.

## 24/10/2026 — b46325d

### Bổ sung

- Thay đường dẫn file local trong phản hồi bằng file đính kèm, giữ thứ tự chữ →
  file → chữ và gửi đúng topic. Hỗ trợ link Markdown và đường dẫn Windows.
- Khi file thiếu, quá giới hạn gửi hoặc upload lỗi, giữ đường dẫn và báo lý do.
  Không tự gửi cấu hình/đăng nhập riêng tư.

### Kiểm thử

- Gửi file thật qua Telegram rồi tải lại: nội dung byte khớp, đúng thứ tự và
  topic; đường dẫn local được thay bằng file. Giới hạn gửi hiện tại: 50 MiB.

## 24/10/2026 — acabf83

### Sửa lỗi

- Khôi phục nhập một lần 5 lượt hỏi–đáp hoàn tất gần nhất khi chọn chat cũ từ
  menu. Bỏ lượt đang chạy và log công cụ; không gửi lại phần đã có.
- Tách bước nhập lịch sử ban đầu khỏi mốc đồng bộ của `/update`.

## 23/10/2026 — b028303

### Sửa lỗi

- Câu hỏi mới chỉ chờ một câu trả lời: tin nhắn tiếp theo trong topic đóng đúng
  thẻ một lần, sau đó trở lại prompt thường. Không lôi câu hỏi lịch sử vào prompt
  mới. `/quota`, `/update` không tiêu thụ câu trả lời; `/cancel` xóa trạng thái chờ.
- Nạp lại chat trước khi trả lời thẻ nếu Codex đã tự ngắt theo dõi chat nhàn rỗi.
  Nếu chưa chuẩn bị được thì gửi nguyên tin nhắn qua đường thường; không gửi
  lại sau một thao tác native có kết quả chưa rõ.
- Giải mã một lớp XML trong delegation để prompt chứa HTML/XML vẫn được nhận
  diện là nguồn Telegram và tự nhận phản hồi, không bị giữ nhầm chờ `/update`.

### Kiểm thử

- Trả lời câu hỏi thật khi lượt đang chạy và khi đã kết thúc: có receipt native,
  thẻ được xử lý; prompt sau đó đi theo đường thường. Kiểm thử khôi phục owner
  dùng lỗi giả lập ở discovery và thao tác nạp chat thật.
- Hai phản hồi từng bị giữ vì XML đã được gửi bù và kiểm tra trên Telegram:
  đúng topic, mỗi tin một lần, không chạy lại prompt.

## 21/10/2026 — e4dac84, 43baffa

- Chuyển ngay câu hỏi async mới về Telegram, kể cả nguồn desktop hoặc lượt còn
  chạy; chống lặp, không nhập lại câu hỏi lịch sử chỉ vì chọn chat.
- Launcher nền thử lại khi Codex chưa sẵn sàng thay vì kết thúc sau lỗi startup.

## 20/10/2026 — 14c22f3, e63e9c3

- Phục hồi project menu từ liên kết local đã lưu khi API thiếu metadata project.
- Thêm Task Scheduler chạy ẩn khi đăng nhập Windows, giữ một tiến trình bot.

## Hành vi được giữ

- `/projects` → project → New chat và 5 chat gần nhất; topic quyết định tuyến gửi.
- Prompt Telegram nhận phản hồi tự động; `/update` chỉ lấy phần desktop sau
  prompt Telegram gần nhất. Chat desktop mới không tự tạo topic.
- `/cancel` dừng lượt hiện tại; `/quota` không gửi prompt cho model.
- Không tự gửi lại prompt/tạo chat khi kết quả chưa xác định. Token, session,
  inbox và runtime được giữ ngoài Git.
