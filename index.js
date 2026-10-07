require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3500;
const API_SECRET = process.env.WA_API_SECRET || 'flicknest-wa-secret-2026';

let sock;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }), // Hide noisy logs
        browser: ['FlickNest WA Bot', 'Chrome', '1.0.0']
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('\n======================================================');
            console.log('🔗 SCAN THIS QR CODE WITH YOUR WHATSAPP TO LINK THE BOT');
            console.log('======================================================\n');
            
            const qrImageUrl = `https://chart.googleapis.com/chart?chs=400x400&cht=qr&chl=${encodeURIComponent(qr)}&choe=UTF-8`;
            console.log('👉 CLICK THIS LINK TO VIEW YOUR QR CODE:');
            console.log(qrImageUrl);
            console.log('\n(Open the link in your browser and scan it with WhatsApp)\n');
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            } else {
                console.log('You are logged out. Please delete the auth_info_baileys folder and restart to scan again.');
            }
        } else if (connection === 'open') {
            console.log('\n✅ WhatsApp Bot Connected Successfully!\n');
        }
    });

// Listen for incoming WhatsApp messages
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const jid = msg.key.remoteJid;

        // Check if message is GET-MOVIE code
        if (text.startsWith('GET-MOVIE-')) {
            const code = text.split('-')[2];
            console.log(`\n📥 Received movie request code [${code}] from ${jid}`);

            try {
                // Verify code with FlickNest Website
                const websiteUrl = process.env.WEBSITE_URL || 'http://localhost:3000';
                
                // Tell user we are processing
                await sock.sendMessage(jid, { text: '⏳ Verifying your request...' });

                const response = await axios.post(`${websiteUrl}/api/whatsapp/verify-token`, {
                    code
                }, {
                    headers: { 'x-api-secret': API_SECRET }
                });

                const data = response.data;
                
                if (data.success) {
                    const { downloadUrl, movieTitle, quality } = data;
                    
                    await sock.sendMessage(jid, { text: `✅ Verified! Downloading ${movieTitle}...\nPlease wait, this may take a few minutes depending on the file size.` });

                    const fileName = `${movieTitle.replace(/[^a-zA-Z0-9]/g, '_')}_${quality || '720p'}.mp4`;

                    console.log(`⬇️ Streaming ${movieTitle} directly to WhatsApp...`);
                    
                    await sock.sendMessage(jid, { 
                        document: { url: downloadUrl }, 
                        mimetype: 'video/mp4',
                        fileName: fileName,
                        caption: `🎬 *${movieTitle}*\n\nHere is your movie! Enjoy watching via FlickNest.\n\n_Quality: ${quality || 'HD'}_\n\n🌐 flicknest.site`
                    });

                    console.log(`✅ Successfully sent to ${jid}`);
                }

            } catch (error) {
                console.error('❌ Error verifying token:', error.response?.data || error.message);
                const errorMsg = error.response?.data?.error || 'Failed to verify token or download movie.';
                await sock.sendMessage(jid, { text: `❌ ${errorMsg}` });
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// Download file function
async function downloadFile(url, tempFilePath) {
    const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream'
    });

    return new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(tempFilePath);
        response.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

app.get('/status', (req, res) => {
    res.json({ 
        online: true, 
        waConnected: !!(sock && sock.user),
        user: sock?.user?.id 
    });
});

app.listen(PORT, () => {
    console.log(`\n🚀 FlickNest WhatsApp Bot Server running on port ${PORT}`);
    connectToWhatsApp();
});
