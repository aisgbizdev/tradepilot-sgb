-- Token khusus unlimited per nasabah per mode (diatur super_admin dari detail
-- pengguna). true = jumlah analisis & masa berlaku demo tidak dibatasi; syarat
-- equity minimum mode real tetap berlaku. Idempotent: aman dijalankan ulang.
BEGIN;

ALTER TABLE tp_credit_balance
  ADD COLUMN IF NOT EXISTS unlimited boolean NOT NULL DEFAULT false;

COMMIT;
