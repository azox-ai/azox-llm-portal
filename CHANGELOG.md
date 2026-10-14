# Changelog

## v1.3.11 — 2026-10-14

Release source gồm quota-fix đã chạy trên dev (snapshot `62aba01093edc14a33fc5dc914d894bf251652fc`) tích hợp với tám commit mới trên `main` từ `v1.3.10` (`d0cfb3cc`). Tag release đặt trên merge commit PR, **không** trùng artifact Portal dev cũ; Portal dev chưa rebuild/redeploy trong đợt này.

### Tính năng

- Thêm trang catalog model tham chiếu, nhóm family/tier, quản lý trạng thái model và thao tác xóa; tier hiển thị ba badge mỗi hàng. Thao tác quản lý hiển thị toast xác nhận/kết quả (PR #16–#19).
- Quota automation lưu và áp dụng trạng thái tài khoản cùng lịch refresh rõ ràng hơn; UI hiển thị trạng thái quota/refresh đồng bộ với backend.

### Sửa lỗi

- Tránh refresh quota quá sớm hoặc lặp khi đồng bộ tài khoản; bảo toàn thông tin mốc reset/quota qua vòng refresh và sync.
- Cập nhật migration/schema cho dữ liệu quota và các nhánh xử lý không đầy đủ; các route account/admin dùng cùng trạng thái sau refresh.
- Giữ nguyên các phần model catalog/family/tier từ `main` khi tích hợp quota-fix; cherry-pick không có conflict văn bản nhưng đã chạy đầy đủ regression để kiểm behavior.

### Kiểm chứng và triển khai

- `npm run check`: ESLint PASS, Node test suite 90/90 PASS trên nhánh integration.
- Không đổi package.json version `1.0.0` (giá trị cố định từ khởi tạo repo, không phải release semver), không đổi env/credentials hay dữ liệu đang chạy.
- Chưa kiểm thử E2E với provider thật/DB dev, chưa deploy Portal mới; cần backup SQLite, kiểm migration trên bản copy trước khi nâng runtime Portal sau này.
