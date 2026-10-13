const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const qrcode = require('qrcode-terminal');

const API_SECRET = process.env.WA_API_SECRET || 'flicknest-wa-secret-2026';
const sessions = new Map(); // Store active sockets
const downloadQueues = new Map(); // Queue per session
const isProcessingQueue = new Map();
const sessionMeta = new Map(); // Store { email, phoneNumber } per session
const searchCache = new Map(); // Store last search results per chat JID

// Save session metadata to disk
function saveSessionMeta(sessionId, meta) {
    if (!meta) return;
    sessionMeta.set(sessionId, meta);
    try {
        const sessionDir = path.join(__dirname, 'sessions', `session_${sessionId}`);
        if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, 'meta.json'), JSON.stringify(meta, null, 2));
    } catch (e) {
        console.error(`Failed to save meta for ${sessionId}:`, e);
    }
}

// Load session metadata from disk
function loadSessionMeta(sessionId) {
    try {
        const metaPath = path.join(__dirname, 'sessions', `session_${sessionId}`, 'meta.json');
        if (fs.existsSync(metaPath)) {
            const data = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            sessionMeta.set(sessionId, data);
            return data;
        }
    } catch (e) {}
    return null;
}

// Helper to get or create queue for a session
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
            await sock.sendMessage(task.jid, { 
                text: `Verified Pro Member. Downloading ${task.movieTitle} (${task.quality || '720p'})...\nPlease wait while the file is sent.` 
            });
            
            const fileName = `${task.movieTitle.replace(/[^a-zA-Z0-9]/g, '_')}_${task.quality || '720p'}.mp4`;
            console.log(`[${sessionId}] Streaming ${task.movieTitle} to ${task.jid}...`);
            
            await sock.sendMessage(task.jid, { 
                document: { url: task.downloadUrl }, 
                mimetype: 'video/mp4',
                fileName: fileName,
                caption: `*${task.movieTitle}*\n\nQuality: ${task.quality || 'HD'}\nEnjoy watching via FlickNest Pro Bot!\n\nflicknest.site`
            });
            console.log(`[${sessionId}] Successfully sent to ${task.jid}`);
        } catch (error) {
            console.error(`[${sessionId}] Error sending to ${task.jid}:`, error);
            await sock.sendMessage(task.jid, { text: `Failed to send movie file due to a connection or server error.` }).catch(() => {});
        }
    }
    isProcessingQueue.set(sessionId, false);
}

async function startSession(sessionId, options = {}, onResult = null) {
    const sessionDir = path.join(__dirname, `sessions`, `session_${sessionId}`);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    // Save metadata if provided
    if (options.email || options.phoneNumber) {
        saveSessionMeta(sessionId, {
            email: options.email,
            phoneNumber: options.phoneNumber
        });
    } else {
        loadSessionMeta(sessionId);
    }

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
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
        
        if (qr) {
            if (sessionId === 'main') {
                console.log('\nScan this QR code with WhatsApp to connect the main bot:');
                qrcode.generate(qr, { small: true });
            }
            if (options.type === 'qr' && !sock.authState.creds.registered) {
                if (onResult && !resultSent) {
                    resultSent = true;
                    onResult({ type: 'qr', data: qr });
                }
            }
        }
        
        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`[${sessionId}] Connection closed (status: ${statusCode}). Reconnecting: ${shouldReconnect}`);
            
            if (statusCode === DisconnectReason.loggedOut) {
                console.log(`[${sessionId}] Logged out. Deleting session files...`);
                try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) { }
                sessions.delete(sessionId);
                sessionMeta.delete(sessionId);
            } else if (shouldReconnect) {
                setTimeout(() => startSession(sessionId, options), 3000);
            }
        } else if (connection === 'open') {
            console.log(`[${sessionId}] WhatsApp Bot Connected Successfully!`);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Listen for incoming messages
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg || !msg.message) return;

        const jid = msg.key.remoteJid;
        if (!jid || jid === 'status@broadcast') return;

        // For main bot, ignore messages sent from itself.
        // For personal user linked bot sessions, allow fromMe so users can command from their own account.
        if (sessionId === 'main' && msg.key.fromMe) return;

        const text = (
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            msg.message.videoMessage?.caption ||
            ''
        ).trim();

        if (!text) return;

        const websiteUrl = process.env.WEBSITE_URL || 'http://localhost:3000';
        const meta = sessionMeta.get(sessionId) || {};
        const userEmail = meta.email || null;

        // 1. Direct website token download: GET-MOVIE-<code>
        if (text.startsWith('GET-MOVIE-')) {
            const code = text.split('-')[2];
            console.log(`[${sessionId}] Received code [${code}] from ${jid}`);

            try {
                await sock.sendMessage(jid, { text: 'Verifying your download token...' });

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
                        await sock.sendMessage(jid, { text: `You are in queue position #${queue.length}. File will be sent shortly.` });
                    }
                    processQueue(sessionId, sock);
                }
            } catch (error) {
                const errorMsg = error.response?.data?.error || 'Failed to verify token.';
                await sock.sendMessage(jid, { text: errorMsg });
            }
            return;
        }

        // 2. Search command: .movie <name> or .search <name> or /movie <name> or !movie <name>
        const searchMatch = text.match(/^[./!]?(movie|search|film)\s+(.+)/i);
        if (searchMatch) {
            const query = searchMatch[2].trim();
            console.log(`[${sessionId}] Search command for "${query}" from ${jid}`);

            try {
                await sock.sendMessage(jid, { text: `Searching FlickNest for "${query}"...` });

                const searchRes = await axios.post(`${websiteUrl}/api/whatsapp/bot-command`, {
                    action: 'search',
                    query: query
                }, {
                    headers: { 'x-api-secret': API_SECRET }
                });

                if (searchRes.data.success && Array.isArray(searchRes.data.movies) && searchRes.data.movies.length > 0) {
                    const movies = searchRes.data.movies;
                    searchCache.set(jid, movies);

                    let responseText = `*FlickNest Search Results*\n\nFound ${movies.length} result(s) for "${query}":\n\n`;
                    movies.forEach((m, idx) => {
                        const num = idx + 1;
                        const rating = m.rating ? `Rating: ${m.rating}` : '';
                        const year = m.year ? `(${m.year})` : '';
                        responseText += `${num}. *${m.title}* ${year}\n`;
                        if (rating) responseText += `   ${rating} | ${m.genres || 'Movie'}\n`;
                        
                        let dlOptions = [];
                        if (m.has720p) dlOptions.push(`.dl ${num} 720p`);
                        if (m.has1080p) dlOptions.push(`.dl ${num} 1080p`);
                        if (dlOptions.length === 0) dlOptions.push(`.dl ${num}`);
                        
                        responseText += `   Download: ${dlOptions.join('  or  ')}\n\n`;
                    });

                    responseText += `Reply with *.dl <number> <quality>* to download.\nExample: *.dl 1 720p*\n\n_Note: Downloads are exclusive to FlickNest Pro members._`;
                    await sock.sendMessage(jid, { text: responseText });
                } else {
                    await sock.sendMessage(jid, { text: `No movies found matching "${query}". Please check the spelling and try again.` });
                }
            } catch (err) {
                console.error(`[${sessionId}] Search error:`, err.message);
                await sock.sendMessage(jid, { text: 'Failed to search movies. Please try again later.' });
            }
            return;
        }

        // 3. Download command: .dl <number|movieId> [quality] or .download <number|movieId> [quality]
        const dlMatch = text.match(/^[./!]?(dl|download|get)\s+(\S+)(?:\s+(\S+))?/i);
        if (dlMatch) {
            const target = dlMatch[2].trim();
            const requestedQuality = (dlMatch[3] || '720p').trim().toLowerCase();
            console.log(`[${sessionId}] Download request for "${target}" (${requestedQuality}) from ${jid}`);

            let movieId = target;
            let movieTitle = '';

            // Check if user specified a number corresponding to last search in this chat
            const cachedList = searchCache.get(jid) || [];
            const index = parseInt(target, 10);
            if (!isNaN(index) && index >= 1 && index <= cachedList.length) {
                const selected = cachedList[index - 1];
                movieId = selected.id;
                movieTitle = selected.title;
            }

            try {
                await sock.sendMessage(jid, { text: 'Verifying FlickNest Pro access...' });

                const dlRes = await axios.post(`${websiteUrl}/api/whatsapp/bot-command`, {
                    action: 'download',
                    movieId: movieId,
                    quality: requestedQuality,
                    userEmail: userEmail
                }, {
                    headers: { 'x-api-secret': API_SECRET }
                });

                if (dlRes.data.success) {
                    const queue = getQueue(sessionId);
                    queue.push({
                        jid,
                        downloadUrl: dlRes.data.downloadUrl,
                        movieTitle: dlRes.data.movieTitle || movieTitle || 'Movie',
                        quality: dlRes.data.quality || requestedQuality
                    });

                    const remainingText = dlRes.data.remaining !== undefined ? ` (${dlRes.data.remaining} downloads remaining today)` : '';
                    if (queue.length > 1 || isProcessingQueue.get(sessionId)) {
                        await sock.sendMessage(jid, { text: `Verified Pro Member! Queued at position #${queue.length}.${remainingText} File will be sent shortly.` });
                    }
                    processQueue(sessionId, sock);
                }
            } catch (err) {
                const errorMsg = err.response?.data?.error || 'Failed to request download. Pro plan subscription required.';
                await sock.sendMessage(jid, { text: errorMsg });
            }
            return;
        }

        // 4. Status command: .status or /status
        if (text.match(/^[./!]?(status|plan|limit)$/i)) {
            try {
                const stRes = await axios.post(`${websiteUrl}/api/whatsapp/bot-command`, {
                    action: 'check-pro',
                    userEmail: userEmail
                }, {
                    headers: { 'x-api-secret': API_SECRET }
                });

                if (stRes.data.success && stRes.data.isPro) {
                    await sock.sendMessage(jid, {
                        text: `*FlickNest Account Status*\n\nPlan: Pro Plan (Active)\nDaily Downloads Used: ${stRes.data.requestsUsed} / ${stRes.data.dailyLimit}\nRemaining Downloads Today: ${stRes.data.remaining}\nBot Integration: Connected\n\nEnjoy direct movie downloads via WhatsApp groups and chats!`
                    });
                } else {
                    await sock.sendMessage(jid, {
                        text: `*FlickNest Account Status*\n\nPlan: Free\nStatus: Pro subscription not active.\n\nTo use direct WhatsApp bot downloads in groups and chats, please subscribe to the Pro Plan at flicknest.site.`
                    });
                }
            } catch (err) {
                await sock.sendMessage(jid, { text: 'Unable to check status at this time.' });
            }
            return;
        }

        // 5. Help command: .help or /help or !help
        if (text.match(/^[./!]?(help|menu|commands)$/i)) {
            await sock.sendMessage(jid, {
                text: `*FlickNest WhatsApp Bot (Pro)*\n\n` +
                      `Use these commands in direct chat or in any group you create:\n\n` +
                      `• *.movie <title>* - Search movies (e.g. .movie Avatar)\n` +
                      `• *.search <title>* - Search movies\n` +
                      `• *.dl <number> <quality>* - Download movie (e.g. .dl 1 720p or .dl 1 1080p)\n` +
                      `• *.status* - Check Pro status and remaining daily downloads\n` +
                      `• *.help* - Show available commands\n\n` +
                      `_Powered by FlickNest (flicknest.site)_`
            });
            return;
        }
    });

    return sock;
}

// Load all existing sessions on startup
function loadExistingSessions() {
    const sessionsDir = path.join(__dirname, 'sessions');
    if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });

    const dirs = fs.readdirSync(sessionsDir);
    for (const dir of dirs) {
        if (dir.startsWith('session_')) {
            const sessionId = dir.replace('session_', '');
            console.log(`Loading existing session: ${sessionId}`);
            loadSessionMeta(sessionId);
            startSession(sessionId, { type: 'none' });
        }
    }

    if (!dirs.includes('session_main')) {
        startSession('main', { type: 'none' });
    }
}

async function unlinkSession(sessionId) {
    const sock = sessions.get(sessionId);
    if (sock) {
        try {
            await sock.logout().catch(() => {});
            sock.end(undefined);
        } catch (e) {}
        sessions.delete(sessionId);
        sessionMeta.delete(sessionId);
    }
    const sessionDir = path.join(__dirname, `sessions`, `session_${sessionId}`);
    try {
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
    } catch (e) {}
    return true;
}

module.exports = { startSession, loadExistingSessions, sessions, unlinkSession };
