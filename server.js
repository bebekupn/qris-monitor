require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Inisialisasi database
const db = new sqlite3.Database('./database.db');

// FORCE RESET: Menghapus tabel lama yang strukturnya salah dan membuat ulang secara bersih
db.serialize(() => {
  db.run(`DROP TABLE IF EXISTS gmail`);
  db.run(`DROP TABLE IF EXISTS transaksi`);

  db.run(`CREATE TABLE IF NOT EXISTS gmail (id INTEGER PRIMARY KEY AUTOINCREMENT, id_email TEXT UNIQUE, tanggal TEXT, isi TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS transaksi (id INTEGER PRIMARY KEY AUTOINCREMENT, id_email TEXT UNIQUE, tanggal TEXT, nominal INTEGER, deskripsi TEXT)`);
  
  console.log("🔄 DATABASE RESET: Tabel lama dihapus dan diperbarui dengan kolom 'id_email'!");
});

// Setup Gmail API pakai token lokal
function buatGmailClient() {
  const credentials = JSON.parse(fs.readFileSync('credentials.json'));
  const { client_id, client_secret } = credentials.installed;
  const oauth2Client = new google.auth.OAuth2(
    client_id, client_secret, 'http://localhost:9999/callback'
  );
  const token = JSON.parse(fs.readFileSync('token.json'));
  oauth2Client.setCredentials(token);
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

// Fungsi polling Gmail
async function cekEmailMandiri() {
  try {
    const gmail = buatGmailClient();

    // FILTER AMAN: Hanya mengambil email dari Mandiri yang statusnya belum dibaca (is:unread)
    const result = await gmail.users.messages.list({
      userId: 'me',
      q: 'from:noreply.livin@bankmandiri.co.id is:unread',
      maxResults: 20,
    });

    const messages = result.data.messages;
    if (!messages || messages.length === 0) {
      console.log(`[${new Date().toLocaleString('id-ID')}] Tidak ada email baru (unread) dari Mandiri.`);
      await parsnominal();
      return;
    }

    console.log(`[${new Date().toLocaleString('id-ID')}] Ditemukan ${messages.length} email baru yang belum dibaca`);

    for (const msg of messages) {
      const detail = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'full',
      });

      // Ambil isi teks dari email
      const payload = detail.data.payload;
      const timestamp = parseInt(detail.data.internalDate, 10);
      const date = !isNaN(timestamp) ? new Date(timestamp) : new Date();
      let teks = '';
    
      if (payload.parts) {
        for (const part of payload.parts) {
          if ((part.mimeType === 'text/plain' || part.mimeType === 'text/html') && part.body.data) {
            teks += Buffer.from(part.body.data, 'base64').toString('utf-8');
          }
        }
      } else if (payload.body && payload.body.data) {
        teks = Buffer.from(payload.body.data, 'base64').toString('utf-8');
      }

      // Simpan ke database antrean sementara (tabel gmail) menggunakan INSERT OR IGNORE
      await new Promise((resolve) => {
        db.run(
          "INSERT OR IGNORE INTO gmail(id_email, tanggal, isi) VALUES (?,?,?)",
          [msg.id, date.toISOString(), teks],
          function (err) {
            if (err) {
              console.error("❌ Gagal menyimpan email ke DB Antrean:", err.message);
            } else if (this.changes > 0) {
              console.log(`✅ Email ID ${msg.id} berhasil masuk antrean lokal.`);
            }
            resolve();
          }
        );
      });

      // Tandai sebagai 'SUDAH DIBACA' di server Gmail agar tidak ditarik lagi pada polling menit ke-5 berikutnya
      try {
        await gmail.users.messages.modify({
          userId: 'me',
          id: msg.id,
          requestBody: { removeLabelIds: ['UNREAD'] },
        });
        console.log(`✉️ Email ID ${msg.id} ditandai sebagai 'Sudah Dibaca' di Gmail.`);
      } catch (e) {
        // Abaikan jika modifikasi label gagal
      }
    }

    // Jalankan pemrosesan teks menjadi nominal transaksi
    await parsnominal();

  } catch (err) {
    console.error('Error cek email:', err.message);
  }
}

async function parsnominal() {
  try {
    // 1. Ambil seluruh data antrean dari tabel gmail
    const emails = await new Promise((resolve, reject) => {
      db.all(`SELECT * FROM gmail`, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    if (!emails || emails.length === 0) {
      console.log("Tidak ada data antrean email di DB untuk diparsing.");
      return;
    }

    console.log(`Memulai parsing cerdas untuk ${emails.length} data email...`);

    // 2. Perulangan memproses teks email menggunakan teknik normalisasi desimal
    for (let i = 0; i < emails.length; i++) {
      const email = emails[i];
      const teks = email.isi;
      const tanggalEmailRaw = email.tanggal;

      // Ambil susunan angka setelah tulisan Rp atau IDR
      const matchNominal = teks.match(/Rp\.?\s*([\d.,]+)/i) || teks.match(/IDR\s*([\d.,]+)/i);

      if (matchNominal) {
        let rawNumber = matchNominal[1].trim(); // Contoh tangkapan: "65.000,00" atau "49,452.00"

        // === PROSES NORMALISASI FORMAT INTERNASIONAL KE INDONESIA ===
        // Jika polanya mengandung koma di ribuan dan titik di desimal sen (ex: 49,452.00)
        if (rawNumber.includes(',') && rawNumber.includes('.')) {
          const indexKoma = rawNumber.indexOf(',');
          const indexTitik = rawNumber.indexOf('.');
          if (indexKoma < indexTitik) {
            // Tukar posisi agar menjadi format standar Indonesia: 49.452,00
            rawNumber = rawNumber.replace(/\,/g, '_').replace(/\./g, ',').replace(/_/g, '.');
          }
        } 
        // Jika hanya ada satu tanda titik di ujung akhir penanda desimal sen (ex: 49452.00)
        else if (rawNumber.includes('.') && !rawNumber.includes(',')) {
          const parts = rawNumber.split('.');
          if (parts[1] && parts[1].length === 2) {
            rawNumber = parts[0] + ',' + parts[1]; // Ubah titik sen menjadi koma sen
          }
        }

        // SEKARANG FORMAT SUDAH PASTI STANDAR INDONESIA (Titik ribuan, Koma sen)
        let cleanNumber = rawNumber;

        // Potong dan buang bagian pecahan desimal sen (,00) jika ada di belakang koma utama
        if (cleanNumber.includes(',')) {
          const parts = cleanNumber.split(',');
          if (parts[1] && (parts[1] === '00' || parts[1].length === 2)) {
            cleanNumber = parts[0]; // Ambil angka utama sebelum koma saja
          }
        }

        // Hapus tanda titik ribuan untuk mendapatkan angka murni Node.js
        const nominal = parseInt(cleanNumber.replace(/\./g, ''), 10);
        
        // Validasi angka agar tidak memasukkan nominal sampah Rp 0 atau NaN
        if (isNaN(nominal) || nominal <= 0) {
          console.log(`⚠️ Hasil parse tidak valid (Rp ${nominal}) pada email ID: ${email.id}. Dilewati.`);
          await new Promise((resolve) => db.run(`DELETE FROM gmail WHERE id = ?`, [email.id], () => resolve()));
          continue;
        }

        // Rapikan format tanggal untuk SQLite (YYYY-MM-DD)
        let tanggal;
        try {
          tanggal = new Date(tanggalEmailRaw).toISOString().split('T')[0];
        } catch (e) {
          tanggal = new Date().toISOString().split('T')[0];
        }
        
        const deskripsi = "QRIS Mandiri Sukses";

        // 3. Masukkan ke dalam tabel transaksi murni (Proteksi UNIQUE id_email agar tidak duplikat)
        await new Promise((resolve) => {
          db.run(
            `INSERT OR IGNORE INTO transaksi (id_email, tanggal, nominal, deskripsi) VALUES (?, ?, ?, ?)`,
            [email.id_email, tanggal, nominal, deskripsi],
            function (err) {
              if (err) {
                console.error("❌ Gagal simpan ke tabel transaksi:", err.message);
              } else if (this.changes > 0) {
                console.log(`💰 [DASHBOARD] Transaksi Baru Masuk: Rp ${nominal.toLocaleString('id-ID')} — ${tanggal}`);
              }
              resolve();
            }
          );
        });

        // 4. Hapus dari antrean email 'gmail' setelah sukses diparsing
        await new Promise((resolve) => {
          db.run(`DELETE FROM gmail WHERE id = ?`, [email.id], () => resolve());
        });

      } else {
        console.log(`⚠️ Tidak bisa parse nominal dari email baris ID: ${email.id}. Menghapus sampah antrean...`);
        await new Promise((resolve) => {
          db.run(`DELETE FROM gmail WHERE id = ?`, [email.id], () => resolve());
        });
      }
    }
  } catch (err) {
    console.error("Error pada fungsi parsnominal:", err.message);
  }
}

// Jalankan sistem interval polling otomatis setiap 5 menit
setInterval(cekEmailMandiri, 5 * 60 * 1000);
cekEmailMandiri(); // Langsung eksekusi sekali saat server pertama kali dinyalakan

// ROUTE API UNTUK KEBUTUHAN DASHBOARD FRONTEND
app.get('/api/transaksi', (req, res) => {
  const { bulan, tahun } = req.query;
  let query = `SELECT * FROM transaksi`;
  const params = [];
  if (bulan && tahun) {
    query += ` WHERE strftime('%Y-%m', tanggal) = ?`;
    params.push(`${tahun}-${bulan.padStart(2, '0')}`);
  }
  query += ` ORDER BY tanggal DESC`;
  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/ringkasan', (req, res) => {
  db.all(`
    SELECT strftime('%Y-%m', tanggal) as bulan,
           COUNT(*) as jumlah_transaksi,
           SUM(nominal) as total
    FROM transaksi GROUP BY bulan ORDER BY bulan DESC LIMIT 12
  `, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.listen(process.env.PORT || 3000, () => {
  console.log('Server lokal berjalan di http://localhost:3000');
  console.log('Polling Gmail aktif dengan Filter Unread...');
});