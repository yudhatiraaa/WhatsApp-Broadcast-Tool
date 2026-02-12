# WhatsApp Broadcast Tool 🚀

Aplikasi broadcast WhatsApp dibangun menggunakan **Node.js** dan library **whatsapp-web.js**. Aplikasi ini memungkinkan Anda mengirim pesan massal, mengelola chat, dan membuat auto-reply dengan  AI.

## Fitur Utama ✨

### 📡 Broadcast Powerful
- **Multi-Format**: Kirim Teks, Gambar, Dokumen, Audio (Voice Note/PTT), dan Lokasi.
- **Personalisasi**: Gunakan `{name}` untuk menyebut nama penerima secara otomatis.
- **Spintax Support**: Acak kata dengan format `{Halo|Hai|Pagi}` agar pesan terlihat unik dan natural.
- **Import Target**: Support import dari file Excel (`.xlsx`), Kontak HP, atau Anggota Grup WhatsApp.
- **Penjadwalan**: Atur waktu pengiriman pesan.

### 🛡️ Fitur Anti-Banned
- **Random Delay**: Jeda waktu acak antar pengiriman pesan.
- **Batching**: Istirahat otomatis setelah mengirim sejumlah pesan tertentu.
- **Human Simulation**: Simulasi status "Sedang mengetik..." sebelum pesan dikirim.

### 💬 Live Chat Real-time
- Kelola pesan masuk dan keluar langsung dari dashboard.
- Fitur lengkap: **Reply**, **Forward**, **Edit Pesan**, **Delete for Everyone**.
- Indikator status Online/Typing lawan bicara.
- Kirim file/media langsung dari chat.

### 🤖 Otomatisasi & AI
- **Auto Reply Keyword**: Balas otomatis berdasarkan kata kunci (Exact/Contains).
- **AI Chatbot**: Terintegrasi dengan AI (Pollinations.ai) untuk membalas pesan yang tidak dikenali keyword.
- **AI Caption Generator**: Buat caption promosi menarik secara instan dengan bantuan AI.
- **Webhook**: Teruskan pesan masuk ke URL eksternal untuk integrasi lebih lanjut.

### ⚙️ Manajemen & Utilitas
- **Multi-Session**: Dukungan untuk banyak akun WhatsApp.
- **Auto Reject Call**: Opsi untuk menolak panggilan masuk otomatis.
- **Manajemen Kontak**: Simpan nomor dalam Label/Grup kontak.

## Persyaratan Sistem 📋

- Node.js (Versi 14 atau terbaru).
- Google Chrome (diperlukan oleh Puppeteer untuk menjalankan WhatsApp Web).

## Cara Install 🛠️

1. **Clone atau Download** repository ini.
2. Buka terminal (Command Prompt/PowerShell) di folder project.
3. Install dependencies yang dibutuhkan:
   npm install whatsapp-web.js qrcode-terminal express multer xlsx axios electron

## Cara Menjalankan ▶️


1. Jalankan perintah:
   node main.js
2. Buka browser dan akses: `http://localhost:3000`
3. Scan QR Code yang muncul menggunakan WhatsApp di HP Anda (Menu: Perangkat Tertaut).

&copy; Yudha Tira Pamungkas
