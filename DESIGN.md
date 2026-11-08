# DESIGN.md — Abixell One

Arah visual untuk seluruh produk. Ditulis dari keputusan pemilik produk
(wawancara arah 2026-09-27); pratinjau berkas
`docs/design/design-preview-wave1.html` disetujui sebagai bentuk konkritnya.
Setiap keputusan di bawah mengikat semua
pekerjaan UI — UI yang melanggar arah ini adalah cacat, bukan selera.

> **Pembaruan 2026-11-08 — mengikuti tampilan Altora Store.** Atas permintaan
> pemilik produk, token di `apps/web/src/index.css` kini memakai gaya Altora
> Store (`/Users/icat/Projects/altora-bearing-store/public/app.css`). Bagian
> warna, tipografi, kepadatan, dan bentuk di bawah ini digantikan oleh nilai
> berikut, sedangkan prinsip lainnya tetap berlaku:
>
> - Font Plus Jakarta Sans (di-host sendiri lewat `@fontsource-variable`), teks
>   isi 15px, judul halaman 800.
> - Satu aksen navy `#12355B` (hover `#0C2743`), latar `#F6F7F9`, garis
>   `#E2E6EB`.
> - Sudut 12px untuk kontrol, 18px untuk kartu; tombol dan status berbentuk pil.
> - Baris tabel dan kontrol 40px. Label tidak lagi huruf kapital semua.

## 1. Karakter

**Instrumen panel yang ramah dan hangat.**

Tenang, presisi, tanpa hiasan. Otoritas datang dari kerapian dan keterbacaan,
namun tetap menerapkan estetika. Lebih mengarah ke alat kolaborasi daripada
alat kontrol.

Konsekuensi praktis:

- Kepadatan data bukan pilihan gaya, melainkan inti produk: layar ini dipakai
  untuk membaca dan membandingkan, jadi jangan sisakan ruang kosong yang tidak
  melayani perbandingan.
- Hiasan yang tidak membawa informasi tidak ada: tanpa gradien, tanpa glow,
  tanpa bayangan dekoratif, tanpa ikon yang hanya mengisi.
- Warm datang dari warna dan keterbacaan, bukan dari sudut membulat lebar atau
  ilustrasi.
- Tampilannya milik operator sehari-hari, bukan etalase: gerak minimal, semua
  keadaan (kosong, memuat, gagal) dirancang, tidak ada kejutan.

## 2. Warna

**Netral dingin + satu aksen. Gelap sebagai bawaan, terang sebagai pilihan.**

- Netral dingin untuk latar, permukaan, garis, dan teks. Tidak ada netral hangat.
- Satu aksen saja, dipakai HANYA untuk: aksi utama, cincin fokus, dan penanda
  baris terpilih. Aksen tidak pernah dipakai untuk status.
- Status punya warnanya sendiri, konsisten di seluruh aplikasi: sukses, gagal,
  peringatan, dan nonaktif masing-masing satu warna + satu latar lembut.
- Gelap adalah tema bawaan; terang adalah tema kedua dengan token yang sama,
  bukan stylesheet terpisah. Keduanya dirawat — bukan dark mode tempelan.

Token (gelap / terang):

| Token | Gelap | Terang |
|---|---|---|
| `bg` latar halaman | `#14161A` | `#F2F4F7` |
| `surface` panel | `#1A1D22` | `#FFFFFF` |
| `surface-2` isi panel | `#20242B` | `#F7F8FA` |
| `surface-3` hover | `#262B33` | `#EEF1F5` |
| `border` garis | `#2A2F37` | `#DDE2E8` |
| `border-strong` garis tebal | `#3A414C` | `#C3CAD3` |
| `text` teks utama | `#E7EAF0` | `#171A1F` |
| `text-dim` teks sekunder | `#A9B2BF` | `#4B5361` |
| `text-faint` label/placeholder | `#8A93A1` | `#606A78` |
| `accent` aksen | `#6B7CFF` | `#4A5BE8` |
| `accent-on` teks di atas aksen | `#0E1017` | `#FFFFFF` |
| `ok` sukses | `#35C08A` | `#0F7A4A` |
| `warn` peringatan | `#E0A028` | `#8A5A00` |
| `danger` gagal | `#F2685F` | `#B32B22` |
| `idle` nonaktif | `#8B93A1` | `#55606E` |

Setiap warna status punya versi latar lembut (alpha ±10–14%) untuk pil dan nota.

Aksen `#6B7CFF` dipilih agar tidak terbaca konservatif: biru yang condong ke
ungu, bukan biru korporat. Menggeser aksen (mis. ke teal dingin) boleh, dengan
mengubah baris ini saja — tidak ada warna lain yang bergantung padanya.

## 3. Kepadatan

**Padat: baris tabel 32px.**

- Baris tabel: tinggi 32px, padding mendatar 10px.
- Kontrol inline (tombol, input, select): tinggi 28px.
- Target sentuh tetap dipenuhi pada tata letak sempit: `min-h-[44px]` pada
  breakpoint mobile, seperti pola yang sudah dipakai Admin Console.
- Ruang antarseksi 14–16px, tidak lebih. Jarak kosong besar dianggap cacat
  kepadatan.

## 4. Tipografi

**Sans netral untuk teks, monospace untuk angka dan kode. Kolom angka rata.**

- Teks: sans netral sistem (`system-ui`, Segoe UI, Roboto — keluarga huruf
  final terbuka, lihat §7).
- Angka: `font-variant-numeric: tabular-nums` di seluruh sel tabel dan metrik,
  sehingga baris ke baris bisa dibandingkan tanpa goyang.
- Code, ID, dan hash: monospace, 11.5px (`font-mono text-xs` pada pola existing).
- Ukuran: isi 13px / tinggi baris 1.45; judul halaman 19px; label bagian
  10.5px kapital dengan tracking 0.055em. Kapital dipakai hanya untuk label
  tingkat informasi, bukan untuk judul biasa.

## 5. Bentuk dan gerak

Diputuskan lewat pratinjau yang disetujui:

- Sudut: radius 3px seragam di semua elemen. Tidak ada bentuk pil kecuali
  penanda bulat 5–11px dan pil status 19px.
- Kedalaman: dari garis 1px dan tingkat permukaan, bukan bayangan. Bayangan
  hanya untuk overlay (dialog) yang benar-benar melayang.
- Gradien dan glow: tidak dipakai sama sekali.
- Gerak: transisi 120ms pada kontrol saja. Tidak ada animasi masuk, tidak ada
  fade-up, tidak ada bounce.
- Fokus: cincin 2px warna aksen, selalu terlihat untuk navigasi papan ketik.

## 6. Copy

Dwibahasa EN/ID (toggle di shell, default ID). Setiap halaman WAJIB pakai
`useT()` dari `src/i18n/LocaleProvider.tsx` — tidak ada string hardcode baru
di JSX. Label navigasi lewat `navLabels.ts` (dictionary terpisah, kode
nav-* dari server), string halaman lewat `en.ts`/`id.ts`. Istilah teknis
tetap apa adanya di kedua bahasa (Window, Role, Permission). Label tombol
menyatakan aksinya: "Simpan perubahan"/"Save changes", bukan "OK". Pesan
galat menyebut apa yang terjadi dan apa yang harus dilakukan, tanpa
menyalahkan siapa pun — diterjemahkan di kedua dictionary.

Pilihan bahasa persisten ke `users.preferred_locale` (DB), bukan cuma
localStorage — ikut user lintas device/browser.

## 7. Terbuka

- **Keluarga huruf:** belum diputuskan. Sementara memakai tumpukan sistem.
  Keputusan milik pemilik produk; sampai diputuskan, tidak ada berkas huruf
  yang diunduh.
