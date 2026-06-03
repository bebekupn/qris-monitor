const { google } = require('googleapis');
const fs = require('fs');
const http = require('http');
const url = require('url');

const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];
const credentials = JSON.parse(fs.readFileSync('credentials.json'));
const { client_id, client_secret, redirect_uris } = credentials.installed;

const oauth2Client = new google.auth.OAuth2(
client_id,
client_secret,
'http://localhost:9999/callback'
);

const authUrl = oauth2Client.generateAuthUrl({
access_type: 'offline',
scope: SCOPES,
});

console.log('\n=== BUKA URL INI DI BROWSER ===');
console.log(authUrl);
console.log('================================\n');

// Server sementara untuk tangkap callback OAuth
const server = http.createServer(async (req, res) => {
const qs = new url.URL(req.url, 'http://localhost:9999').searchParams;
const code = qs.get('code');
if (!code) return;

const { tokens } = await oauth2Client.getToken(code);
fs.writeFileSync('token.json', JSON.stringify(tokens));
res.end('Login berhasil! Tutup tab ini dan kembali ke terminal.');
server.close();
console.log('Token tersimpan di token.json. Sekarang jalankan: node server.js');
});

server.listen(9999);