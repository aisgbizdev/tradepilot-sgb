-- Masa berlaku kuota per mode (demo: 14 hari sejak pertama pakai demo).
-- Saldo yang sudah ada diberi jangkar = saat migrasi dijalankan, sehingga
-- nasabah demo lama mendapat 14 hari penuh sejak kebijakan baru berlaku.
-- Idempotent: aman dijalankan ulang.
BEGIN;

ALTER TABLE tp_credit_balance
  ADD COLUMN IF NOT EXISTS trial_started_at timestamptz NOT NULL DEFAULT now();

COMMIT;
