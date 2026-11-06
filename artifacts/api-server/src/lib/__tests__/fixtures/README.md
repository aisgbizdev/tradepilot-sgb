# Evaluasi dua sisi dengan snapshot pasar

Fixture `market-snapshots.ts` dibekukan pada 25 September 2026. Intraday berasal dari Yahoo chart (`GC=F`, `BZ=F`, `^HSI`, `NIY=F`); candle 4h dikelompokkan dari OHLC 60m menurut batas UTC. 1D dan 1W berasal dari feed historical proyek (`LGD Daily`, `BCO Daily`, `HSI Daily`, `SNI Daily`); snapshot mingguan memakai rentang 100 candle harian, bukan satu candle 1W. `low`, `high`, dan perubahan dihitung dari 20 bar terakhir untuk intraday/1D dan 100 bar harian untuk 1W. Ini **ringkasan OHLC nyata**, bukan RSI/MACD; jangan menyebutnya indikator lengkap. Harga futures dan harga spot/indeks harian dapat berbeda. Tidak ada quote ini yang diklaim masih live setelah tanggal snapshot.

Regresi tanpa jaringan/API (seluruh 4 instrumen × 8 timeframe, nol kredit):

```sh
pnpm --filter @workspace/api-server exec vitest run src/lib/__tests__/market-evaluation.test.ts
```

Uji opsional AI nyata pada **satu** pasangan snapshot yang dipilih (menggunakan API internal, tanpa route analisis atau ledger kredit pengguna):

```sh
MARKET_EVAL_LIVE=1 MARKET_EVAL_INSTRUMENT=BRENT MARKET_EVAL_TIMEFRAME=30m \
  MARKET_EVAL_TOKEN_BUDGET=20000 \
  pnpm --filter @workspace/api-server exec vitest run src/lib/__tests__/market-evaluation.test.ts -t 'live AI evaluation'
```

Ganti instrument (`XAU/USD`, `BRENT`, `HSI`, `NIKKEI`) dan timeframe (`1m`, `5m`, `15m`, `30m`, `1h`, `4h`, `1D`, `1W`) untuk mengevaluasi kasus lain. Batas per eksekusi: satu analisis, maksimal tiga request AI dengan maksimal 1800 output token per request; anggaran token minimum eksplisit 20.000. Setiap request dicadangkan memakai batas konservatif ukuran prompt dan output maksimal sebelum dikirim; request berikutnya ditolak bila melewati anggaran. Laporan `MARKET_EVAL_REPORT` berupa JSON memuat tanggal/sumber quote, level kedua sisi, jarak maksimum terhadap quote, anomali entry/range, perbedaan momentum timeframe tetangga, alasan arah, status validasi produksi, jumlah request/koreksi, jenis koreksi, token terpakai, dan tingkat penolakan/koreksi. Bila AI melempar sebelum mencatat usage, pemakaian token bisa `null` dan tetap perlu diperiksa pada tagihan internal. Anomali *bukan* prediksi hasil trading atau bukti profit; tinjau secara manual sebelum memutuskan perubahan produk. Snapshot statis tidak menguji kesegaran feed produksi.