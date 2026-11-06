-- Kuota khusus per nasabah per mode (diatur super_admin dari detail pengguna).
-- NULL = ikut kuota global; terisi = dipakai di setiap reset periode sampai
-- dihapus admin. Idempotent: aman dijalankan ulang.
BEGIN;

ALTER TABLE tp_credit_balance
  ADD COLUMN IF NOT EXISTS custom_allowance integer;

COMMIT;
