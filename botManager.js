const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const API_SECRET = process.env.WA_API_SECRET || 'flicknest-wa-secret-2026';
const sessions = new Map(); // Store active sockets
const downloadQueues = new Map(); // Queue per session
const isProcessingQueue = new Map();

// Helper to get or create queue for a JID (user email or 'main')
function getQueue(sessionId) {
    if (!downloadQueues.has(sessionId)) {
        downloadQueues.set(sessionId, []);
        isProcessingQueue.set(sessionId, false);
    }
    return downloadQueues.get(sessionId);
}

async function processQueue(sessionId, sock) {
    if (isProcessingQueue.get(sessionId) || getQueue(sessionId).length === 0) return;
    isProcessingQueue.set(sessionId, true);

    const queue = getQueue(sessionId);
    while (queue.length > 0) {
        const task = queue.shift();
        try {
            await sock.sendMessage(task.jid, { text: `✅ Verified! Downloading ${task.movieTitle}...\n(Please wait, this may take a few minutes)` });
            
            const fileName = `${task.movieTitle.replace(/[^a-zA-Z0-9]/g, '_')}_${task.quality || '720p'}.mp4`;
            console.log(`[${sessionId}] ⬇️ Streaming ${task.movieTitle} to ${task.jid}...`);
            
            await sock.sendMessage(task.jid, { 
                document: { url: task.downloadUrl }, 
                mimetype: 'video/mp4',
                fileName: fileName,
                caption: `🎬 *${task.movieTitle}*\n\nHere is your movie! Enjoy watching via FlickNest.\n\n_Quality: ${task.quality || 'HD'}_\n\n🌐 flicknest.site`
            });
            console.log(`[${sessionId}] ✅ Successfully sent to ${task.jid}`);
        } catch (error) {
            console.error(`[${sessionId}] ❌ Error sending to ${task.jid}:`, error);
            await sock.sendMessage(task.jid, { text: `❌ Failed to send movie due to an internal error.` }).catch(() => {});
        }
    }
    isProcessingQueue.set(sessionId, false);
}

async function startSession(sessionId, options = {}, onResult = null) {
    const sessionDir = path.join(__dirname, `sessions`, `session_${sessionId}`);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: sessionId === 'main', // Only print QR for main bot
        logger: pino({ level: 'silent' }),
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
    });

    sessions.set(sessionId, sock);
    let resultSent = false;

    // If pairing code requested and not logged in
    if (options.type === 'code' && options.phoneNumber && !sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                let formattedNumber = options.phoneNumber.replace(/[^0-9]/g, '');
                const code = await sock.requestPairingCode(formattedNumber);
                if (onResult && !resultSent) {
                    resultSent = true;
                    onResult({ type: 'code', data: code });
                }
            } catch (err) {
                console.error(`Failed to request pairing code for ${sessionId}:`, err);
                if (onResult && !resultSent) {
                    resultSent = true;
                    onResult({ type: 'error', data: err.message });
                }
            }
        }, 3000);
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr && options.type === 'qr' && !sock.authState.creds.registered) {
            if (onResult && !resultSent) {
                resultSent = true;
                onResult({ type: 'qr', data: qr });
            }
        }
        
        if (connection === 'close') {
            const statusCode = (lastDisconnect.error)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`[${sessionId}] Connection closed. Reconnecting: ${shouldReconnect}`);
            
            if (statusCode === 401 || statusCode === 408) {
                console.log(`[${sessionId}] Session corrupted. Deleting...`);
                try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) { }
                sessions.delete(sessionId);
                if (sessionId === 'main') setTimeout(() => startSession('main'), 2000);
            } else if (shouldReconnect) {
                startSession(sessionId);
            } else {
                console.log(`[${sessionId}] Logged out.`);
                try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) { }
                sessions.delete(sessionId);
            }
        } else if (connection === 'open') {
            console.log(`[${sessionId}] ✅ WhatsApp Bot Connected Successfully!`);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Listen for messages
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const jid = msg.key.remoteJid;

        if (text.startsWith('GET-MOVIE-')) {
            const code = text.split('-')[2];
            console.log(`[${sessionId}] 📥 Received code [${code}] from ${jid}`);

            try {
                const websiteUrl = process.env.WEBSITE_URL || 'http://localhost:3000';
                await sock.sendMessage(jid, { text: '⏳ Verifying your request...' });

                const response = await axios.post(`${websiteUrl}/api/whatsapp/verify-token`, {
                    code
                }, {
                    headers: { 'x-api-secret': API_SECRET }
                });

                if (response.data.success) {
                    const queue = getQueue(sessionId);
                    queue.push({
                        jid,
                        downloadUrl: response.data.downloadUrl,
                        movieTitle: response.data.movieTitle,
                        quality: response.data.quality
                    });
                    
                    if (queue.length > 1 || isProcessingQueue.get(sessionId)) {
                        await sock.sendMessage(jid, { text: `⏳ You are in the queue! Position: #${queue.length}. Please wait.` });
                    }
                    processQueue(sessionId, sock);
                }
            } catch (error) {
                const errorMsg = error.response?.data?.error || 'Failed to verify token.';
                await sock.sendMessage(jid, { text: `❌ ${errorMsg}` });
            }
        }
    });

    return sock;
}

// Load all existing sessions on startup
function loadExistingSessions() {
    const sessionsDir = path.join(__dirname, 'sessions');
    if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir);

    const dirs = fs.readdirSync(sessionsDir);
    for (const dir of dirs) {
        if (dir.startsWith('session_')) {
            const sessionId = dir.replace('session_', '');
            console.log(`Loading existing session: ${sessionId}`);
            startSession(sessionId, { type: 'none' });
        }
    }

    // Ensure main session exists
    if (!dirs.includes('session_main')) {
        startSession('main', { type: 'none' });
    }
}

module.exports = { startSession, loadExistingSessions, sessions };
