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

// Pastikan tabel-tabel sudah terbuat dengan benar saat server dinyalakan
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS gmail (id INTEGER PRIMARY KEY AUTOINCREMENT, tanggal TEXT, isi TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS transaksi (id INTEGER PRIMARY KEY AUTOINCREMENT, tanggal TEXT, nominal INTEGER, deskripsi TEXT)`);
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

    // Cari email dari Mandiri
    const result = await gmail.users.messages.list({
      userId: 'me',
      q: 'from:noreply.livin@bankmandiri.co.id',
      maxResults: 20,
    });

    const messages = result.data.messages;
    if (!messages || messages.length === 0) {
      console.log(`[${new Date().toLocaleString('id-ID')}] Tidak ada email baru dari Mandiri.`);
      await parsnominal();
      return;
    }

    console.log(`[${new Date().toLocaleString('id-ID')}] Ditemukan ${messages.length} email di inbox`);

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

      // Simpan ke database antrean sementara (tabel gmail)
      await new Promise((resolve) => {
        db.run(
          "INSERT INTO gmail(tanggal, isi) VALUES (?,?)",
          [date.toISOString(), teks],
          function (err) {
            if (err) {
              console.error("❌ Gagal menyimpan email ke DB:", err.message);
            } else {
              console.log(`✅ Sukses menyimpan email ke DB Antrean! ID Row: ${this.lastID}`);
            }
            resolve();
          }
        );
      });

      // Hapus status UNREAD di Gmail agar tidak ditarik berulang kali di polling berikutnya
      try {
        await gmail.users.messages.modify({
          userId: 'me',
          id: msg.id,
          requestBody: { removeLabelIds: ['UNREAD'] },
        });
      } catch (e) {
        // Abaikan jika status gagal diubah (misal karena sudah terbaca secara manual)
      }
    }

    // Panggil fungsi parsing setelah semua email berhasil dimasukkan ke antrean
    await parsnominal();

  } catch (err) {
    console.error('Error cek email:', err.message);
  }
}

async function parsnominal() {
  try {
    // 1. Ambil seluruh data dari tabel gmail antrean sementara
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

    // 2. Perulangan memproses teks email menggunakan normalisasi format
    for (let i = 0; i < emails.length; i++) {
      const email = emails[i];
      const teks = email.isi;
      const tanggalEmailRaw = email.tanggal;

      // Regex tajam untuk menangkap susunan angka nominal transaksi setelah simbol uang
      const matchNominal = teks.match(/Rp\.?\s*([\d.,]+)/i) || teks.match(/IDR\s*([\d.,]+)/i);

      if (matchNominal) {
        let rawNumber = matchNominal[1].trim(); // Contoh hasil tangkapan: "65.000,00" atau "49,452.00"

        // === PROSES NORMALISASI FORMAT INTERNASIONAL KE INDONESIA ===
        // Jika polanya mengandung koma di ribuan dan titik di desimal sen (ex: 49,452.00)
        if (rawNumber.includes(',') && rawNumber.includes('.')) {
          const indexKoma = rawNumber.indexOf(',');
          const indexTitik = rawNumber.indexOf('.');
          if (indexKoma < indexTitik) {
            // Ubah paksa susunan format: 49,452.00 -> 49.452,00
            rawNumber = rawNumber.replace(/\,/g, '_').replace(/\./g, ',').replace(/_/g, '.');
          }
        } 
        // Jika hanya ada satu tanda titik di ujung akhir penanda desimal sen (ex: 49452.00)
        else if (rawNumber.includes('.') && !rawNumber.includes(',')) {
          const parts = rawNumber.split('.');
          if (parts[1] && parts[1].length === 2) {
            rawNumber = parts[0] + ',' + parts[1]; // Ubah titik sen menjadi koma sen (,00)
          }
        }

        // SEKARANG FORMAT SUDAH PASTI STANDAR INDONESIA (Titik ribuan, Koma sen)
        let cleanNumber = rawNumber;

        // Potong dan buang bagian sen (,00) jika ada di belakang koma utama
        if (cleanNumber.includes('料')) {
          // Abaikan, penanganan string koma di bawah
        }
        
        if (cleanNumber.includes(',')) {
          const parts = cleanNumber.split(',');
          // Pastikan string di belakang koma adalah digit sen (berjumlah 2 digit seperti ,00)
          if (parts[1] && (parts[1] === '00' || parts[1].length === 2)) {
            cleanNumber = parts[0]; // Ambil angka sebelum koma saja
          }
        }

        // Hapus tanda titik ribuan agar tersisa angka murni murni untuk dikonversi
        const nominal = parseInt(cleanNumber.replace(/\./g, ''), 10);
        
        // Validasi angka hasil parsing agar tidak memasukkan sampah data Rp 0 atau NaN
        if (isNaN(nominal) || nominal <= 0) {
          console.log(`⚠️ Hasil parse tidak valid (Rp ${nominal}) pada email ID: ${email.id}. Dilewati.`);
          await new Promise((resolve) => db.run(`DELETE FROM gmail WHERE id = ?`, [email.id], () => resolve()));
          continue;
        }

        // Bersihkan dan rapikan format tanggal untuk SQLite (YYYY-MM-DD)
        let tanggal;
        try {
          tanggal = new Date(tanggalEmailRaw).toISOString().split('T')[0];
        } catch (e) {
          tanggal = new Date().toISOString().split('T')[0];
        }
        
        const deskripsi = "QRIS Mandiri Sukses";

        // 3. Masukkan ke dalam tabel transaksi murni
        await new Promise((resolve) => {
          db.run(
            `INSERT INTO transaksi (tanggal, nominal, deskripsi) VALUES (?, ?, ?)`,
            [tanggal, nominal, deskripsi],
            function (err) {
              if (err) {
                console.error("❌ Gagal simpan ke tabel transaksi:", err.message);
              } else {
                console.log(`💰 [DATABASE TRANSAKSI] Tersimpan: Rp ${nominal.toLocaleString('id-ID')} — ${tanggal}`);
              }
              resolve();
            }
          );
        });

        // 4. Hapus dari antrean email 'gmail' setelah sukses diparsing agar tidak dibaca ganda
        await new Promise((resolve) => {
          db.run(`DELETE FROM gmail WHERE id = ?`, [email.id], () => resolve());
        });

      } else {
        console.log(`⚠️ Tidak bisa parse nominal dari email baris ID: ${email.id}. Menghapus sampah antrean...`);
        // Hapus baris dari antrean jika format email bukan mutasi valid
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
  console.log('Polling Gmail setiap 5 menit...');
});