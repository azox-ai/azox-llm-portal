Contract thật của hai router, đã xác minh trực tiếp trên source (9router `23bea27`,
OmniRoute `v3.8.50`). Tài liệu này tồn tại vì bản thiết kế đầu tiên giả định một
endpoint admin chung cho cả hai — giả định đó **sai hoàn toàn**.

## Không có contract chung

| | 9router | OmniRoute |
|---|---|---|
| Inject Claude | **không tồn tại** | `POST /api/providers/claude-auth/import` |
| Inject Codex | `POST /api/oauth/codex/bulk-import` | `POST /api/providers/codex-auth/import` |
| Bật/tắt | `PUT /api/providers/{id}` `{isActive}` | `PUT /api/providers/{id}` `{isActive}` |
| Xoá | `DELETE /api/providers/{id}` | `DELETE /api/providers/{id}` |
| Xác thực | `x-9r-cli-token` (token dẫn xuất) | `Authorization: Bearer` (API key scope `manage`) |
| Body import | token phẳng camelCase | file credential của CLI, bọc trong `source` |

Khác endpoint, khác body, khác cả cơ chế xác thực. Vì vậy `src/adapters/` có hai
class riêng; thứ dùng chung chỉ là *interface* `inject/setEnabled/remove` mà
`services/sync.js` gọi.

## Body import

OmniRoute không nhận token set phẳng. Nó nhận **đúng định dạng file credential
của CLI**, bọc trong `source`:

```jsonc
// Claude — claudeAuthImport.ts:50-96
{ "source": { "kind": "json", "json": {
    "claudeAiOauth": { "accessToken": "...", "refreshToken": "...",
                       "expiresAt": 1767225600000, "scopes": ["..."] } }},
  "email": "...", "overwriteExisting": true }

// Codex — codexAuthImport.ts:113-175
{ "source": { "kind": "json", "json": {
    "auth_mode": "chatgpt",
    "tokens": { "id_token": "...", "access_token": "...", "refresh_token": "..." } }},
  "overwriteExisting": true }
```

`expiresAt` của Claude là **ms epoch**, không phải ISO string. `id_token` của
Codex là **bắt buộc** — OmniRoute derive `account_id`, user id, email và expiry
từ JWT claims; thiếu nó thì import bị từ chối.

9router thì ngược lại, nhận mảng token phẳng camelCase và trả
`{success, failed, results:[{index, ok, id|error}]}`.

## Ba cạm bẫy đã né

**1. `/api/oauth/codex/import` của OmniRoute đốt refresh token.** Route đó gọi
`refreshCodexToken()` để validate *trước khi* persist. Refresh token của Codex
là single-use và xoay theo family, nên validate kiểu này có thể vô hiệu hoá
chính credential portal vừa lấy được. Adapter dùng
`/api/providers/codex-auth/import` — route này cố ý không refresh khi import.

**2. `isActive` của 9router so sánh strict `=== false`.** Chỉ literal JSON
`false` mới tắt được. `0`, `"false"`, `null` đều trả HTTP 200 nhưng **giữ
connection ACTIVE** — một no-op trông y hệt thành công. `setEnabled` luôn ép về
boolean thật; có test khoá hành vi này.

**3. `GET /api/providers` của 9router rò credential lồng nhau.** Nó redact
token ở tầng trên cùng nhưng spread nguyên `data` blob, nên
`providerSpecificData.cookie`, `.clientSecret`, `.firebaseIdToken`, `.idToken`
vẫn ra ngoài. Portal **không gọi route này**; nó không cần đọc lại connection.

## Hai điểm cần theo dõi

**9router không có đường nạp Claude token.** Không có route import Claude, và
`POST /api/providers` chỉ tạo được `cookie`/`apikey`. Một account Claude vì thế
chỉ nạp được vào OmniRoute; portal ghi trạng thái `unsupported` cho 9router và
báo account là `partially_synced` — đúng thực tế: nó vẫn phục vụ traffic nhưng
đã mất tính failover của ADR-0025. Trạng thái này khác `failed` vì retry không
bao giờ khắc phục được.

Muốn lấp, cần thêm một fork seam cho 9router theo ADR-0026 — một route import
Claude đối xứng với `codex/bulk-import`. Đây là thay đổi trên fork, cần quyết
định riêng, chưa làm.

**Xác thực 9router không dùng bearer token.** `x-9r-cli-token` được so với giá
trị tính tại chỗ từ hai file trong data volume của router; không env var nào cấp
nó. Portal phải đọc được file đó.

⚠️ Guard của 9router cho qua khi `requireLogin === false` — lúc đó mọi route
import mở hoàn toàn, kể cả từ remote. **Không được dựa vào đó** làm cơ chế truy
cập; portal luôn gửi token thật.

⚠️ OmniRoute chỉ mã hoá token at-rest khi `STORAGE_ENCRYPTION_KEY` được set;
thiếu biến này nó lưu plaintext. Cần xác nhận biến này có trên môi trường
production trước khi inject credential thật.

## OAuth client config trùng nhau

Claude clientId, Codex clientId, và Codex fixedPort 1455 **giống hệt** giữa hai
router. Nghĩa là một token set portal lấy được dùng cho cả hai — đúng tiền đề
của kiến trúc một-lần-đăng-nhập.

`DELETE` ở cả hai router chỉ xoá row, **không revoke credential ở upstream**.
Sponsor muốn thu hồi thật thì phải làm ngoài băng ở phía nhà cung cấp.
