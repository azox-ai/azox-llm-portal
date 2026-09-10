# Sponsor Portal

Một identity plane duy nhất cho các tài khoản Claude/Codex được sponsor vào
LLM gateway. Sponsor đăng nhập **một lần** ở đây; portal chạy OAuth, giữ
credential, rồi inject sang cả 9router lẫn OmniRoute bằng đặc quyền admin. Hai
router sau đó tự vận hành như hiện tại — sponsor không cần biết chúng tồn tại.

## Vì sao có service này

Trước đây, để một tài khoản phục vụ cả hai provider, sponsor phải đăng nhập vào
UI của 9router rồi lại đăng nhập vào UI của OmniRoute. Portal thay thế hai lần
đăng nhập đó bằng một. Nó là **control plane**, không nằm trên đường request:
traffic inference vẫn đi LiteLLM → 9router/OmniRoute như cũ. Portal chết thì
gateway vẫn chạy; chỉ mất khả năng thêm/sửa tài khoản sponsor.

## Ranh giới trách nhiệm

| Thuộc portal | Không thuộc portal |
|---|---|
| Danh tính sponsor (đăng ký, đăng nhập, đổi mật khẩu) | Định tuyến, failover, retry |
| Chạy OAuth và giữ credential đã mã hoá | Virtual key, spend, quota (LiteLLM giữ) |
| Inject/bật/tắt/xoá connection ở hai router | Refresh token định kỳ (router tự làm) |
| Ghi audit log các thao tác trên | Hiển thị limit/usage của tài khoản |

Portal **cố ý không hiển thị quota, limit hay usage** của tài khoản sponsor —
đúng theo yêu cầu: chỉ thấy tài khoản, không thấy limit.

## Mô hình đồng bộ

Portal không giả định hai router luôn khoẻ. Mỗi tài khoản có:

- `desired_enabled` — ý định của sponsor (bật hay tắt).
- một hàng `router_connections` cho mỗi router, mang `sync_status` riêng.

Reconcile chạy `Promise.allSettled`: **một router hỏng không chặn router kia**.
Trạng thái tổng hợp hiển thị cho sponsor là `active`, `disabled`, `pending`,
`failed`, `needs_reauth`, hoặc `partially_synced`. Nút *Retry* chạy lại
reconcile cho riêng phần lỗi.

Xoá là **fail-closed**: portal chỉ xoá bản ghi của mình sau khi cả hai router
xác nhận đã xoá. Nếu một router từ chối, API trả 502 và bản ghi được giữ lại —
thà để lại một record thừa còn hơn để lại một credential mồ côi đang sống trong
router mà portal không còn biết đến.

## Bảo mật

- Mật khẩu băm bằng **argon2id**. Đăng nhập với username không tồn tại vẫn chạy
  một lần verify giả để thời gian phản hồi không lộ tài khoản nào có thật.
- Credential OAuth mã hoá **AES-256-GCM** trước khi vào SQLite, dạng
  `v1.iv.tag.ciphertext`. Khoá lấy từ `CREDENTIAL_ENCRYPTION_KEY`.
  **Đổi khoá này là mất toàn bộ credential** — mọi sponsor phải OAuth lại.
- Session cookie signed + HttpOnly + SameSite=Lax; CSRF token gắn theo session,
  bắt buộc trên mọi POST/PUT/PATCH/DELETE. Riêng `/api/oauth/*` miễn CSRF vì
  đã được bảo vệ bằng PKCE state dùng một lần.
- `POST /api/register` và `POST /api/login` có rate limit riêng.
- Sponsor chỉ thao tác được trên tài khoản mình sở hữu; quyền admin chỉ mở thêm
  quản lý user và đọc audit log, **không** cho phép xem credential của người khác.
- Admin cuối cùng còn active không thể tự hạ quyền hay tự khoá (409).
- Token không bao giờ được ghi ra log, response hay audit entry.

## Chạy local

```bash
npm ci
cp .env.example .env    # điền COOKIE_SECRET, CREDENTIAL_ENCRYPTION_KEY, INIT_ADMIN_PASSWORD
chmod 600 .env
npm test                # 16 test, không cần network
npm run dev
```

Ở chế độ dev, thiếu secret thì portal tự sinh giá trị ngẫu nhiên và cảnh báo.
Ở `NODE_ENV=production`, thiếu secret là lỗi khởi động — cố ý.

## Bootstrap admin

`INIT_ADMIN_USERNAME` + `INIT_ADMIN_PASSWORD` chỉ được seed **một lần duy nhất,
khi bảng users còn rỗng**. Admin được seed bị đánh dấu `must_change_password`
và phải đổi mật khẩu ở lần đăng nhập đầu. Sau đó biến env này vô hiệu — xoá nó
khỏi `.env` là an toàn và nên làm.

## Deploy

```bash
docker compose up -d --build
```

Compose gắn vào network `llm-gateway` sẵn có để gọi hai router theo tên
container. Host ports `20140` (UI) và `1455` (Codex callback) cùng map vào Fastify
port `8080`; Codex ghim callback OAuth vào host port `1455`.

## Endpoint

| Method | Path | Mô tả |
|---|---|---|
| POST | `/api/register` | Sponsor tự đăng ký (luôn role `user`) |
| POST | `/api/login` / `/api/logout` | Phiên làm việc |
| GET | `/api/me` | Thông tin phiên + CSRF token |
| POST | `/api/password` | Đổi mật khẩu (huỷ mọi session cũ) |
| GET | `/api/accounts` | Tài khoản sponsor + trạng thái từng router |
| POST | `/api/oauth/:provider/start` | Bắt đầu OAuth (`claude` \| `codex`) |
| GET | `/api/oauth/:provider/callback` | Nhận code, đổi token, inject |
| PATCH | `/api/accounts/:id/state` | Bật/tắt |
| POST | `/api/accounts/:id/retry` | Reconcile lại phần lỗi |
| DELETE | `/api/accounts/:id` | Xoá (fail-closed) |
| GET | `/api/router-status` | Sức khoẻ hai router |
| GET | `/api/admin/users` | (admin) danh sách user |
| POST | `/api/admin/users/:id/reset-password` | (admin) cấp mật khẩu tạm |
| PATCH | `/api/admin/users/:id` | (admin) đổi role / khoá |
| GET | `/api/admin/audit` | (admin) audit log |
| GET | `/health/live`, `/health/ready` | Probe |
