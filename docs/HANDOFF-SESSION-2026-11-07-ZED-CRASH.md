# HANDOVER — Sesi Zed Agent, 2026-11-07 (untuk Claude Code)

> Lampiran sesi untuk `docs/handoff.md` (yang masih otoritas utama).
> Thread Zed sebelumnya mati karena context overflow (satu output grep 10.6 MB).
> Dokumen ini menangkap state kerjaan yang TIDAK sempat dicatat di handoff.md.

## 1. Konteks sesi

- Repo: `abixell-one` (GitHub: https://github.com/Cat-tj/abixell-one)
- Base commit: `9e9e352` — "feat(rbac): included-role support"
- Semua kerjaan sesi ini **belum di-commit** — ada 16 perubahan di working tree (lihat §4).
- Sesi berakhir paksa sebelum bug-hunting / testing / perbaikan UI/UX selesai (user minta 1-shot "finish them all" lalu agent crash).

## 2. Kebutuhan bisnis baru (dari rapat Altora — requirement nyata klien catering, Balikpapan)

Ini yang memicu kerjaan sesi ini. Prioritas user:

1. **Site-scoping task antar petugas** — PT memegang banyak catering/site. Member dengan role petugas di site A TIDAK BOLEH melihat task milik site B (dan sebaliknya). → **BELUM DIKERJAKAN.**
2. **WO regular vs back-charge** — WO back-charge = kerjaan billable tanpa delivery contract; contract-price resolution tidak berlaku. → migrasi jadi, service layer **belum lengkap**.
3. **Food-grade warehouse separation** — item/gudang food vs non_food; movement service harus enforce kecocokan grade. → migrasi jadi, enforcement di movement service **belum dikonfirmasi jadi**.
4. **Harga tersembunyi per role** — petugas tertentu tidak boleh melihat harga. → helper `price-visibility.ts` jadi, wiring ke route **belum lengkap**.
5. **UI/UX frontend terlihat "AI slop"** — user minta diperbaiki. → **BELUM DISENTUH SAMA SEKALI.**

## 3. Yang sudah ditulis (uncommitted)

### Wave A8 — Partner API (dari rencana handoff.md, status: selesai ditulis, belum ditest end-to-end)
- `apps/api/migrations/1797700006000_partner-credentials.cjs` — tabel kredensial partner (SHA-256 hashed, rotatable, revocable)
- `apps/api/migrations/1797700007000_dictionary-seed-partner-api.cjs` — seed dictionary route partner
- `apps/api/src/application/integration/partner-credential.service.ts` (153 baris)
- `apps/api/src/interfaces/http/routes/partner/` — `index.ts`, `partner-api.routes.ts`, `partner-registry.ts`
- `apps/api/scripts/debug-partner-routes.mts` — script debug
- ADR 0028/0029/0030 diupdate (modified)

### Fitur baru dari rapat (migrasi saja; service layer belum tuntas)
- `apps/api/migrations/1797700008000_wms-grade.cjs` — kolom `grade` (`food`/`non_food`, nullable) di `items` + `scm_warehouses`. Enforcement di movement service, BUKAN di DB.
- `apps/api/migrations/1797700008100_wms-price-view-permission.cjs` — permission lihat harga
- `apps/api/migrations/1797700009000_wo-type.cjs` — kolom `wo_type` (`regular` default / `back_charge`) di `work_orders`
- `apps/api/src/application/supply-chain/price-visibility.ts` (28 baris) — helper visibility harga

### File lama yang dimodifikasi
- `apps/api/src/app.ts`
- `apps/api/src/domain/configuration/module-attribution.ts`
- `apps/api/src/domain/configuration/window-enforcement.ts`
- `apps/api/src/interfaces/http/routes/admin-console.ts`

## 4. Status validasi

- **BELUM ada test yang dijalankan** untuk perubahan ini di sesi crash.
- Subagent penulis migrasi kehabisan token sebelum menuntaskan service layer (tercatat di log sesi).
- Migrasi sempat dijalankan di dev DB dan "berjalan lancar", tapi hasil akhirnya tidak diverifikasi ulang.

## 5. TODO untuk Claude Code (urutan saran)

1. `git status` + review diff 16 file di atas. Baca `docs/handoff.md` §11 (Unchangeable Items) SEBELUM menyentuh apa pun.
2. Jalankan test suite API + verifikasi migrasi (`docs/handoff.md` §9 Testing and Validation Commands).
3. Tuntaskan service layer:
   - back-charge WO: contract-price resolution harus skip `wo_type = 'back_charge'`
   - WMS grade: enforcement kecocokan grade di movement service
   - price visibility: wiring `price-visibility.ts` ke route yang expose harga
4. **Fitur belum ada sama sekali: site-scoping task antar petugas** (poin bisnis #1 di atas — prioritas user).
5. Perbaikan UI/UX frontend (user: "terlihat seperti AI slop").
6. Bug hunting + testing penuh sebelum commit.

## 6. Catatan lingkungan

- User bekerja tanpa approval prompt & tanpa sandbox (auto-approve ON di Zed). Untuk Claude Code, user mengharapkan pola kerja sama: jangan bertanya-tanya, kerjakan sampai tuntas.
- Lihat juga: `docs/HANDOFF-9ROUTER-CC.md`, `docs/ROADMAP-TO-100.md`, `docs/decision-log.md`.
