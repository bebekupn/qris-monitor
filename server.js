 
require('dotenv').config();

const express = require('express');

const sqlite3 = require('sqlite3').verbose();

const cors = require('cors');



const app = express();

app.use(express.json());

app.use(cors());

app.use(express.static('public'));



// Inisialisasi database

const db = new sqlite3.Database('./database.db');

db.run(`CREATE TABLE IF NOT EXISTS transaksi (

id INTEGER PRIMARY KEY AUTOINCREMENT,

tanggal TEXT NOT NULL,

nominal INTEGER NOT NULL,

deskripsi TEXT,

sumber TEXT DEFAULT 'QRIS',

created_at TEXT DEFAULT (datetime('now','localtime'))

)`);



// Endpoint penerima data dari Google Apps Script

app.post('/webhook/mandiri', (req, res) => {

const { secret, tanggal, nominal, deskripsi } = req.body;



// Validasi secret key — tolak jika tidak cocok

if (secret !== process.env.WEBHOOK_SECRET) {

return res.status(401).json({ error: 'Unauthorized' });

}



if (!tanggal || !nominal) {

return res.status(400).json({ error: 'Data tidak lengkap' });

}



db.run(

`INSERT INTO transaksi (tanggal, nominal, deskripsi) VALUES (?, ?, ?)`,

[tanggal, parseInt(nominal), deskripsi || 'QRIS Mandiri'],

function(err) {

if (err) return res.status(500).json({ error: err.message });

console.log(`[${new Date().toLocaleString('id-ID')}] Transaksi masuk: Rp ${parseInt(nominal).toLocaleString('id-ID')}`);

res.json({ success: true, id: this.lastID });

}

);

});



// API untuk frontend

app.get('/api/transaksi', (req, res) => {

const { bulan, tahun } = req.query;

let query = `SELECT * FROM transaksi`;

const params = [];



if (bulan && tahun) {

query += ` WHERE strftime('%Y-%m', tanggal) = ?`;

params.push(`${tahun}-${bulan.padStart(2, '0')}`);

}



query += ` ORDER BY tanggal DESC, created_at DESC`;



db.all(query, params, (err, rows) => {

if (err) return res.status(500).json({ error: err.message });

res.json(rows);

});

});



app.get('/api/ringkasan', (req, res) => {

db.all(`

SELECT

strftime('%Y-%m', tanggal) as bulan,

COUNT(*) as jumlah_transaksi,

SUM(nominal) as total

FROM transaksi

GROUP BY bulan

ORDER BY bulan DESC

LIMIT 12

`, [], (err, rows) => {

if (err) return res.status(500).json({ error: err.message });

res.json(rows);

});

});



app.listen(process.env.PORT, () => {

console.log(`Server berjalan di http://localhost:${process.env.PORT}`);

});