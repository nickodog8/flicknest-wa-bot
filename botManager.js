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
const episodeCache = new Map(); // Store last viewed series episodes per chat JID

// In-memory & disk-backed message store for E2EE decryption retry handling (resolves "Waiting for this message")
const messageStore = new Map();
const botSentMessageIds = new Set();
const msgStoreFile = path.join(__dirname, 'sessions', 'msg_store.json');

function loadMsgStoreFromDisk() {
    try {
        if (fs.existsSync(msgStoreFile)) {
            const raw = fs.readFileSync(msgStoreFile, 'utf8');
            const data = JSON.parse(raw);
            if (Array.isArray(data)) {
                for (const [id, msg] of data) {
                    messageStore.set(id, msg);
                }
            }
            console.log(`[Store] Loaded ${messageStore.size} cached E2EE messages from disk.`);
        }
    } catch (e) {
        console.error('[Store] Failed to load msg_store.json:', e.message);
    }
}
loadMsgStoreFromDisk();

let saveMsgStoreTimeout = null;
function scheduleSaveMsgStore() {
    if (saveMsgStoreTimeout) return;
    saveMsgStoreTimeout = setTimeout(() => {
        saveMsgStoreTimeout = null;
        try {
            const sessionsDir = path.join(__dirname, 'sessions');
            if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });
            const entries = Array.from(messageStore.entries()).slice(-1500);
            fs.writeFileSync(msgStoreFile, JSON.stringify(entries), 'utf8');
        } catch (e) {
            console.error('[Store] Failed to save msg_store.json:', e.message);
        }
    }, 4000);
}

function saveMsgToStore(msg) {
    if (msg?.key?.id && msg?.message) {
        messageStore.set(msg.key.id, msg.message);
        if (messageStore.size > 2500) {
            const firstKey = messageStore.keys().next().value;
            messageStore.delete(firstKey);
        }
        scheduleSaveMsgStore();
    }
}

// In-memory retry counter cache for Baileys multi-device E2EE
const retryCounterMap = new Map();
const msgRetryCounterCache = {
    get: (key) => retryCounterMap.get(key),
    set: (key, val) => retryCounterMap.set(key, val),
    del: (key) => retryCounterMap.delete(key),
    delete: (key) => retryCounterMap.delete(key),
    flushAll: () => retryCounterMap.clear(),
};

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
                text: `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n📥 *Downloading:* *${task.movieTitle}*\n⚡ *Quality:* ${task.quality || '720p'}\n⏳ *Uploading file to your chat... Please wait.*` 
            });
            
            const fileName = `${task.movieTitle.replace(/[^a-zA-Z0-9]/g, '_')}_${task.quality || '720p'}.mp4`;
            console.log(`[${sessionId}] Streaming ${task.movieTitle} to ${task.jid}...`);
            
            await sock.sendMessage(task.jid, { 
                document: { url: task.downloadUrl }, 
                mimetype: 'video/mp4',
                fileName: fileName,
                caption: `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n🎬 *${task.movieTitle}*\n⚡ *Quality:* ${task.quality || 'HD'}\n🍿 *Enjoy Watching!*\n\n🌐 *flicknest.site*`
            });
            console.log(`[${sessionId}] Successfully sent to ${task.jid}`);

            if (task.msgKey) {
                try {
                    await sock.sendMessage(task.jid, {
                        react: { text: '🍿', key: task.msgKey }
                    });
                } catch (e) {}
            }
        } catch (error) {
            console.error(`[${sessionId}] Error sending to ${task.jid}:`, error);
            await sock.sendMessage(task.jid, { text: `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n❌ *Failed to send file:* Connection or download error occurred. Please try again.` }).catch(() => {});
            if (task.msgKey) {
                try {
                    await sock.sendMessage(task.jid, {
                        react: { text: '❌', key: task.msgKey }
                    });
                } catch (e) {}
            }
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
        syncFullHistory: false,
        msgRetryCounterCache,
        getMessage: async (key) => {
            if (key?.id && messageStore.has(key.id)) {
                return messageStore.get(key.id);
            }
            return undefined;
        }
    });

    // Automatically store all sent messages for E2EE decryption retry requests & track bot-sent IDs
    const originalSendMessage = sock.sendMessage.bind(sock);
    sock.sendMessage = async (targetJid, content, sendOptions = {}) => {
        const sent = await originalSendMessage(targetJid, content, sendOptions);
        if (sent) {
            if (sent?.key?.id) {
                botSentMessageIds.add(sent.key.id);
                if (botSentMessageIds.size > 4000) {
                    const first = botSentMessageIds.values().next().value;
                    botSentMessageIds.delete(first);
                }
            }
            saveMsgToStore(sent);
        }
        return sent;
    };

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

            // Only send welcome message to personal connected numbers (not main bot)
            if (sessionId !== 'main') {
                const meta = sessionMeta.get(sessionId) || loadSessionMeta(sessionId) || {};
                
                if (!meta.welcomeSent) {
                    setTimeout(async () => {
                        try {
                            const rawId = sock.user?.id || '';
                            const userPhoneNumber = rawId.split(':')[0] || rawId.split('@')[0] || (meta.phoneNumber ? meta.phoneNumber.replace(/[^0-9]/g, '') : '');
                            if (!userPhoneNumber) return;
                            const targetJid = `${userPhoneNumber}@s.whatsapp.net`;

                            const welcomeMessage = 
`*🎬 FLICKNEST WHATSAPP BOT 🍿*

🎉 *Welcome to FlickNest Cinema Bot!*
ඔබගේ WhatsApp ගිණුම සාර්ථකව සම්බන්ධ විය. දැන් ඔබට ඔබගේ WhatsApp එකෙන්ම කෙලින්ම ඕනෑම Movie එකක් හෝ Series එකක් පහසුවෙන්ම ලබාගත හැක!

━━━━━━━━━━━━━━━━━━━━━
🍿 *MOVIES / SERIES ලබාගන්නා ආකාරය:*
━━━━━━━━━━━━━━━━━━━━━
1️⃣ *Direct Search (කෙලින්ම නම Type කරන්න):*
   • කිසිදු code එකක් අවශ්‍ය නැත! කැමති Movie හෝ Series එකේ නම Message කරන්න.
   • උදාහරණ: 
     👉 *Avatar*
     👉 *Spider Man*
     👉 *Money Heist*

2️⃣ *Quick Download (අංකය එවා Download කරගන්න):*
   • Search results ලැබුණු පසු ඔබට අවශ්‍ය Movie එකෙහි අංකය Message කරන්න.
   • 720p HD සඳහා: 👉 *1*
   • 1080p Full HD සඳහා: 👉 *1 1080p*

3️⃣ *TV Series Episodes:*
   • Series එකක අංකය එවූ විට සියලු Episodes ලැයිස්තුව ලැබේ.
   • කැමති Episode අංකය (උදා: *1* හෝ *2*) එවූ විට Episode එක කෙලින්ම Send වේ.

━━━━━━━━━━━━━━━━━━━━━
⚡ *AVAILABLE COMMANDS (විධාන ලැයිස්තුව):*
━━━━━━━━━━━━━━━━━━━━━
• 🔥 *.trending* ➔ දැනට වැඩිපුරම බලන Top Movies & Series
• ✨ *.latest* ➔ අලුතින්ම Site එකට එකතු වූ අලුත්ම චිත්‍රපට
• 📺 *.ep <number>* ➔ Series Episodes ලැයිස්තුව ලබාගැනීමට
• ℹ️ *.info <number>* ➔ Synopsis, Cast, Rating සහ Runtime බැලීමට
• 💎 *.status* ➔ ඔබගේ Pro Membership තත්ත්වය බැලීමට
• ❓ *.help* ➔ මෙම උපදෙස් මාලාව නැවත ලබාගැනීමට

━━━━━━━━━━━━━━━━━━━━━
🔒 *100% PRIVATE & SECURE:*
• මෙම Bot ක්‍රියාත්මක වන්නේ ඔබගේ පෞද්ගලික chat එක තුළ ඔබ යවන Messages වලට පමණි.
• වෙනත් කිසිම කෙනෙකුට ඔබගේ bot එක ක්‍රියාත්මක කළ නොහැක.

🍿 *Enjoy Your Movies with FlickNest!*
🌐 _flicknest.site_`;

                            await sock.sendMessage(targetJid, { text: welcomeMessage });
                            console.log(`[${sessionId}] Sent one-time Welcome & Commands message to ${targetJid}`);
                            
                            // Mark welcomeSent so it is only sent ONCE!
                            meta.welcomeSent = true;
                            saveSessionMeta(sessionId, meta);
                        } catch (err) {
                            console.error(`[${sessionId}] Failed to send welcome message:`, err);
                        }
                    }, 2500);
                }
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Listen for incoming messages
    sock.ev.on('messages.upsert', async (m) => {
        for (const item of (m.messages || [])) {
            saveMsgToStore(item);
        }

        const msg = m.messages[0];
        if (!msg || !msg.message) return;

        // CRITICAL: Ignore messages sent by our bot process itself (prevents infinite echo loops in self-chats)
        if (msg.key?.id && botSentMessageIds.has(msg.key.id)) return;

        let jid = msg.key.remoteJid;
        if (!jid || jid === 'status@broadcast') return;

        // Un-wrap any ephemeral, view-once, or edited wrappers
        const innerMsg = 
            msg.message?.ephemeralMessage?.message ||
            msg.message?.viewOnceMessage?.message ||
            msg.message?.viewOnceMessageV2?.message ||
            msg.message?.documentWithCaptionMessage?.message ||
            msg.message?.editedMessage?.message?.protocolMessage?.editedMessage ||
            msg.message;

        const text = (
            innerMsg?.conversation ||
            innerMsg?.extendedTextMessage?.text ||
            innerMsg?.imageMessage?.caption ||
            innerMsg?.videoMessage?.caption ||
            ''
        ).trim();

        if (!text) return;

        // CRITICAL: Ignore bot self-generated text messages to prevent any runaway loops
        if (text.includes('FLICKNEST WHATSAPP BOT') || text.includes('FLICKNEST CINEMA BOT')) return;

        const websiteUrl = process.env.WEBSITE_URL || 'https://flicknest.site';

        // ═════════════════════════════════════════════════════════════
        // 1. MAIN BOT NUMBER (Site's Number)
        // Main bot ONLY handles website download tokens (GET-MOVIE-<code> or GET-SEASON-<code>).
        // Main bot does NOT respond to commands!
        // ═════════════════════════════════════════════════════════════
        if (sessionId === 'main') {
            if (msg.key.fromMe) return; // Ignore messages from main bot itself

            if (text.startsWith('GET-MOVIE-') || text.startsWith('GET-SEASON-')) {
                const code = text.split('-')[2];
                console.log(`[main] Received website token [${code}] from ${jid}`);

                try {
                    await sock.sendMessage(jid, { text: 'Verifying your download token...' });

                    const response = await axios.post(`${websiteUrl}/api/whatsapp/verify-token`, {
                        code
                    }, {
                        headers: { 'x-api-secret': API_SECRET }
                    });

                    if (response.data.success) {
                        const queue = getQueue(sessionId);
                        if (response.data.isSeasonBulk && Array.isArray(response.data.episodes)) {
                            await sock.sendMessage(jid, {
                                text: `Season Bulk Download verified! Queuing ${response.data.episodes.length} episodes for "${response.data.seriesTitle}" Season ${response.data.seasonNumber}...`
                            });
                            for (const ep of response.data.episodes) {
                                queue.push({
                                    jid,
                                    downloadUrl: ep.downloadUrl,
                                    movieTitle: `${response.data.seriesTitle} - ${ep.title}`,
                                    quality: ep.quality || 'HD'
                                });
                            }
                        } else {
                            queue.push({
                                jid,
                                downloadUrl: response.data.downloadUrl,
                                movieTitle: response.data.movieTitle,
                                quality: response.data.quality
                            });
                        }
                        
                        if (queue.length > 1 || isProcessingQueue.get(sessionId)) {
                            await sock.sendMessage(jid, { text: `You are in queue position #${queue.length}. File(s) will be sent shortly.` });
                        }
                        processQueue(sessionId, sock);
                    }
                } catch (error) {
                    const errorMsg = error.response?.data?.error || 'Failed to verify token.';
                    await sock.sendMessage(jid, { text: errorMsg });
                }
            }
            return; // Exit! Main bot does not process any commands.
        }

        // ═════════════════════════════════════════════════════════════
        // 2. USER'S OWN CONNECTED NUMBER (Personal Bot Session)
        // STRICT PRIVACY & OWNER-ONLY ACCESS:
        // Bot ONLY responds to the user who connected this bot!
        // Handles both Self-Chat (Message Yourself) and Direct WhatsApp interaction.
        // ═════════════════════════════════════════════════════════════
        const meta = sessionMeta.get(sessionId) || loadSessionMeta(sessionId) || {};
        const cleanMetaPhone = meta.phoneNumber ? meta.phoneNumber.replace(/\D/g, '') : null;
        const cleanUserPhone = sock.user?.id ? sock.user.id.split(':')[0].split('@')[0].replace(/\D/g, '') : null;
        const botOwnerPhone = cleanUserPhone || cleanMetaPhone;

        const isGroup = jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter');
        if (isGroup) return; // Never respond to groups or channels

        const remoteNumber = jid.split('@')[0].split(':')[0].replace(/\D/g, '');
        const senderPhone = (msg.key.participant || jid).split('@')[0].split(':')[0].replace(/\D/g, '');
        const myLid = (sock.user?.lid || sock.authState?.creds?.me?.lid || '').split(':')[0].split('@')[0];

        let isAuthorized = false;

        if (msg.key.fromMe) {
            // Sent by this account in self-chat ("Message yourself" or self LID)
            if (botOwnerPhone && remoteNumber === botOwnerPhone) {
                isAuthorized = true;
            } else if (myLid && remoteNumber === myLid) {
                isAuthorized = true;
            } else if (jid.endsWith('@lid')) {
                // Self chat often presents as an internal LID when fromMe is true
                isAuthorized = true;
            } else if (botOwnerPhone && jid.includes(botOwnerPhone)) {
                isAuthorized = true;
            }
        } else {
            // Sent TO this account. Only authorize if the sender is the registered owner!
            if (botOwnerPhone && senderPhone === botOwnerPhone) {
                isAuthorized = true;
            }
        }

        if (!isAuthorized) {
            return; // Silently ignore other people/strangers
        }

        // Ensure jid is a direct WhatsApp phone number JID (resolves internal @lid issues)
        if (jid.endsWith('@lid') && botOwnerPhone) {
            jid = `${botOwnerPhone}@s.whatsapp.net`;
        }

        console.log(`[${sessionId}] 🎯 Processing authorized command: "${text}" on ${jid}`);

        // Auto-React to incoming self-message with ⏳
        try {
            await sock.sendMessage(jid, {
                react: { text: '⏳', key: msg.key }
            });
        } catch (e) {}

        const userEmail = meta.email || null;

        // ── 1. Website Token Download (when user clicks "WhatsApp" on flicknest.site) ──
        if (text.startsWith('GET-MOVIE-') || text.startsWith('GET-SEASON-')) {
            const code = text.split('-')[2];
            console.log(`[${sessionId}] Received code [${code}] from self chat`);

            try {
                await sock.sendMessage(jid, { 
                    text: `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n⏳ *Verifying your download token...*` 
                });

                const response = await axios.post(`${websiteUrl}/api/whatsapp/verify-token`, {
                    code
                }, {
                    headers: { 'x-api-secret': API_SECRET }
                });

                if (response.data.success) {
                    const queue = getQueue(sessionId);
                    if (response.data.isSeasonBulk && Array.isArray(response.data.episodes)) {
                        await sock.sendMessage(jid, {
                            text: `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n✅ *Season Bulk Download Verified!*\n📦 Queuing *${response.data.episodes.length} episodes* for *"${response.data.seriesTitle}" Season ${response.data.seasonNumber}*...\n\n⏳ Files will be delivered shortly!`
                        });
                        for (const ep of response.data.episodes) {
                            queue.push({
                                jid,
                                downloadUrl: ep.downloadUrl,
                                movieTitle: `${response.data.seriesTitle} - ${ep.title}`,
                                quality: ep.quality || 'HD',
                                msgKey: msg.key
                            });
                        }
                    } else {
                        queue.push({
                            jid,
                            downloadUrl: response.data.downloadUrl,
                            movieTitle: response.data.movieTitle,
                            quality: response.data.quality,
                            msgKey: msg.key
                        });
                    }
                    
                    if (queue.length > 1 || isProcessingQueue.get(sessionId)) {
                        await sock.sendMessage(jid, { 
                            text: `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n📋 *Queue Position:* #${queue.length}\n⏳ File(s) are in queue and will be sent to this chat shortly.` 
                        });
                    }
                    processQueue(sessionId, sock);
                }
            } catch (error) {
                const errorMsg = error.response?.data?.error || 'Failed to verify token.';
                await sock.sendMessage(jid, { 
                    text: `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n❌ *Token Error:* ${errorMsg}` 
                });
                try {
                    await sock.sendMessage(jid, { react: { text: '❌', key: msg.key } });
                } catch (e) {}
            }
            return;
        }

        // ── 2. Quick Number Selection (e.g. typing "1" or "1 1080p") ──
        const quickNumberMatch = text.match(/^(\d+)(?:\s+(720p|1080p))?$/i);
        if (quickNumberMatch) {
            const index = parseInt(quickNumberMatch[1], 10);
            const requestedQuality = (quickNumberMatch[2] || '720p').toLowerCase();

            // Check if user is looking at series episodes list first
            const cachedEpisodes = episodeCache.get(jid) || [];
            if (cachedEpisodes.length > 0 && index >= 1 && index <= cachedEpisodes.length) {
                const ep = cachedEpisodes[index - 1];
                await sock.sendMessage(jid, { 
                    text: `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n⏳ *Processing download for Episode:* *${ep.title}* (${requestedQuality})...` 
                });
                try {
                    const dlRes = await axios.post(`${websiteUrl}/api/whatsapp/bot-command`, {
                        action: 'download-episode',
                        episodeId: ep.id,
                        quality: requestedQuality,
                        userEmail
                    }, {
                        headers: { 'x-api-secret': API_SECRET }
                    });
                    if (dlRes.data.success) {
                        const queue = getQueue(sessionId);
                        queue.push({
                            jid,
                            downloadUrl: dlRes.data.downloadUrl,
                            movieTitle: dlRes.data.movieTitle || ep.title || 'Episode',
                            quality: dlRes.data.quality || requestedQuality,
                            msgKey: msg.key
                        });
                        if (queue.length > 1 || isProcessingQueue.get(sessionId)) {
                            await sock.sendMessage(jid, { 
                                text: `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n📋 *Queue Position:* #${queue.length}\n⏳ Episode will be sent shortly.` 
                            });
                        }
                        processQueue(sessionId, sock);
                    }
                } catch (err) {
                    const errMsg = err.response?.data?.error || 'Failed to request episode download.';
                    await sock.sendMessage(jid, { text: `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n❌ *Error:* ${errMsg}` });
                    try {
                        await sock.sendMessage(jid, { react: { text: '❌', key: msg.key } });
                    } catch (e) {}
                }
                return;
            }

            // Check if user is looking at search / trending / latest movie list
            const cachedMovies = searchCache.get(jid) || [];
            if (cachedMovies.length > 0 && index >= 1 && index <= cachedMovies.length) {
                const selected = cachedMovies[index - 1];
                if (selected.isSeries) {
                    // Automatically open episodes for this series!
                    await sock.sendMessage(jid, { 
                        text: `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n📺 *"${selected.title}"* is a TV Series!\n⏳ Fetching episodes...` 
                    });
                    try {
                        const epRes = await axios.post(`${websiteUrl}/api/whatsapp/bot-command`, {
                            action: 'episodes',
                            seriesId: selected.id
                        }, {
                            headers: { 'x-api-secret': API_SECRET }
                        });
                        if (epRes.data.success && Array.isArray(epRes.data.episodes) && epRes.data.episodes.length > 0) {
                            episodeCache.set(jid, epRes.data.episodes);
                            let epText = `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n📺 *${epRes.data.seriesTitle} - Available Episodes*\n\n`;
                            epRes.data.episodes.forEach((ep, idx) => {
                                const num = idx + 1;
                                epText += `*${num}. ${ep.title}*\n`;
                                epText += `   👉 Send *${num}* to download (or *${num} 1080p*)\n\n`;
                            });
                            epText += `💡 *Reply with the episode number (e.g. 1) to download!*`;
                            await sock.sendMessage(jid, { text: epText });
                            try {
                                await sock.sendMessage(jid, { react: { text: '📺', key: msg.key } });
                            } catch (e) {}
                        } else {
                            await sock.sendMessage(jid, { text: `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n❌ No episodes found for this series.` });
                        }
                    } catch (e) {
                        await sock.sendMessage(jid, { text: `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n❌ Failed to load episodes.` });
                    }
                    return;
                } else {
                    // Download movie directly!
                    await sock.sendMessage(jid, { 
                        text: `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n⏳ *Processing download for:* *${selected.title}* (${requestedQuality})...` 
                    });
                    try {
                        const dlRes = await axios.post(`${websiteUrl}/api/whatsapp/bot-command`, {
                            action: 'download',
                            movieId: selected.id,
                            quality: requestedQuality,
                            userEmail
                        }, {
                            headers: { 'x-api-secret': API_SECRET }
                        });
                        if (dlRes.data.success) {
                            const queue = getQueue(sessionId);
                            queue.push({
                                jid,
                                downloadUrl: dlRes.data.downloadUrl,
                                movieTitle: dlRes.data.movieTitle || selected.title,
                                quality: dlRes.data.quality || requestedQuality,
                                msgKey: msg.key
                            });
                            if (queue.length > 1 || isProcessingQueue.get(sessionId)) {
                                await sock.sendMessage(jid, { 
                                    text: `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n📋 *Queue Position:* #${queue.length}\n⏳ File will be sent shortly.` 
                                });
                            }
                            processQueue(sessionId, sock);
                        }
                    } catch (err) {
                        const errMsg = err.response?.data?.error || 'Failed to request download. Pro plan subscription required.';
                        await sock.sendMessage(jid, { text: `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n❌ *Error:* ${errMsg}` });
                        try {
                            await sock.sendMessage(jid, { react: { text: '❌', key: msg.key } });
                        } catch (e) {}
                    }
                    return;
                }
            }
        }

        // ── 3. Command: .trending / trending / top / popular ──
        if (text.match(/^[./!]?(trending|popular|top)$/i)) {
            try {
                await sock.sendMessage(jid, { text: `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n🔥 *Fetching trending titles on FlickNest...*` });
                const res = await axios.post(`${websiteUrl}/api/whatsapp/bot-command`, {
                    action: 'trending'
                }, {
                    headers: { 'x-api-secret': API_SECRET }
                });

                if (res.data.success && Array.isArray(res.data.movies) && res.data.movies.length > 0) {
                    const movies = res.data.movies;
                    searchCache.set(jid, movies);

                    let responseText = `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n🔥 *Trending on FlickNest Today* 🚀\n\n`;
                    movies.forEach((m, idx) => {
                        const num = idx + 1;
                        const year = m.year ? `(${m.year})` : '';
                        const rating = m.rating ? `⭐ ${m.rating}/10` : '';
                        const typeTag = m.isSeries ? '📺 TV Series' : '🎬 Movie';
                        responseText += `*${num}. ${m.title}* ${year} · ${typeTag}\n`;
                        if (rating) responseText += `   ${rating} | 🎭 ${m.genres || 'General'}\n`;
                        if (m.isSeries) {
                            responseText += `   👉 Send *${num}* to view episodes\n\n`;
                        } else {
                            responseText += `   👉 Send *${num}* to download (or *${num} 1080p*)\n\n`;
                        }
                    });

                    responseText += `💡 *Reply with the number (e.g. 1) to download instantly!*`;
                    await sock.sendMessage(jid, { text: responseText });
                    try {
                        await sock.sendMessage(jid, { react: { text: '🔥', key: msg.key } });
                    } catch (e) {}
                } else {
                    await sock.sendMessage(jid, { text: `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n❌ No trending titles available right now.` });
                }
            } catch (err) {
                await sock.sendMessage(jid, { text: `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n❌ Unable to fetch trending titles.` });
            }
            return;
        }

        // ── 4. Command: .latest / .new / latest / new ──
        if (text.match(/^[./!]?(latest|new|recent)$/i)) {
            try {
                await sock.sendMessage(jid, { text: `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n✨ *Fetching latest releases on FlickNest...*` });
                const res = await axios.post(`${websiteUrl}/api/whatsapp/bot-command`, {
                    action: 'latest'
                }, {
                    headers: { 'x-api-secret': API_SECRET }
                });

                if (res.data.success && Array.isArray(res.data.movies) && res.data.movies.length > 0) {
                    const movies = res.data.movies;
                    searchCache.set(jid, movies);

                    let responseText = `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n✨ *Latest Releases on FlickNest* 🆕\n\n`;
                    movies.forEach((m, idx) => {
                        const num = idx + 1;
                        const year = m.year ? `(${m.year})` : '';
                        const typeTag = m.isSeries ? '📺 TV Series' : '🎬 Movie';
                        responseText += `*${num}. ${m.title}* ${year} · ${typeTag}\n`;
                        responseText += `   ⚡ Quality: ${m.quality || 'HD'} | 🎭 ${m.genres || 'General'}\n`;
                        if (m.isSeries) {
                            responseText += `   👉 Send *${num}* to view episodes\n\n`;
                        } else {
                            responseText += `   👉 Send *${num}* to download (or *${num} 1080p*)\n\n`;
                        }
                    });

                    responseText += `💡 *Reply with the number (e.g. 1) to download instantly!*`;
                    await sock.sendMessage(jid, { text: responseText });
                    try {
                        await sock.sendMessage(jid, { react: { text: '✨', key: msg.key } });
                    } catch (e) {}
                } else {
                    await sock.sendMessage(jid, { text: `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n❌ No new releases found.` });
                }
            } catch (err) {
                await sock.sendMessage(jid, { text: `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n❌ Unable to fetch latest releases.` });
            }
            return;
        }

        // ── 5. Command: .info <number|movieId> ──
        const infoMatch = text.match(/^[./!]?(info|details)\s+(\S+)/i);
        if (infoMatch) {
            const target = infoMatch[2].trim();
            let movieId = target;

            const cachedList = searchCache.get(jid) || [];
            const index = parseInt(target, 10);
            if (!isNaN(index) && index >= 1 && index <= cachedList.length) {
                movieId = cachedList[index - 1].id;
            }

            try {
                await sock.sendMessage(jid, { text: `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n⏳ *Fetching title details...*` });
                const infoRes = await axios.post(`${websiteUrl}/api/whatsapp/bot-command`, {
                    action: 'info',
                    movieId
                }, {
                    headers: { 'x-api-secret': API_SECRET }
                });

                if (infoRes.data.success && infoRes.data.movie) {
                    const m = infoRes.data.movie;
                    let text = `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n`;
                    text += `🍿 *${m.title}* (${m.year || 'N/A'})\n\n`;
                    if (m.description) text += `📝 *Synopsis:* ${m.description}\n\n`;
                    if (m.director) text += `🎬 *Director:* ${m.director}\n`;
                    if (m.actors) text += `👥 *Cast:* ${m.actors}\n`;
                    if (m.genres) text += `🎭 *Genres:* ${m.genres}\n`;
                    if (m.runtime) text += `⏱️ *Runtime:* ${m.runtime}\n`;
                    if (m.rating || m.imdbRating) text += `⭐ *Rating:* ${m.rating || m.imdbRating} / 10\n`;
                    if (m.language) text += `🌐 *Language:* ${m.language}\n`;
                    if (m.quality) text += `⚡ *Quality:* ${m.quality}\n\n`;

                    if (m.episodesCount > 0) {
                        text += `📺 *TV Series:* ${m.episodesCount} episode(s) available.\n`;
                        text += `👉 Send *.ep ${m.id}* to view episodes.`;
                    } else {
                        text += `👉 Send *.dl ${m.id} 720p* or *.dl ${m.id} 1080p* to download.`;
                    }

                    await sock.sendMessage(jid, { text });
                    try {
                        await sock.sendMessage(jid, { react: { text: '🍿', key: msg.key } });
                    } catch (e) {}
                } else {
                    await sock.sendMessage(jid, { text: `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n❌ Title details not found.` });
                }
            } catch (err) {
                await sock.sendMessage(jid, { text: `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n❌ Unable to retrieve title info.` });
            }
            return;
        }

        // ── 6. Command: .ep / .series <number|seriesId> [season] ──
        const epMatch = text.match(/^[./!]?(ep|eps|episodes|series)\s+(\S+)(?:\s+(\d+))?/i);
        if (epMatch) {
            const target = epMatch[2].trim();
            const requestedSeason = epMatch[3] ? parseInt(epMatch[3], 10) : null;
            let seriesId = target;

            const cachedList = searchCache.get(jid) || [];
            const index = parseInt(target, 10);
            if (!isNaN(index) && index >= 1 && index <= cachedList.length) {
                seriesId = cachedList[index - 1].id;
            }

            try {
                await sock.sendMessage(jid, { text: `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n⏳ *Fetching TV Series episodes...*` });
                const epRes = await axios.post(`${websiteUrl}/api/whatsapp/bot-command`, {
                    action: 'episodes',
                    seriesId,
                    season: requestedSeason
                }, {
                    headers: { 'x-api-secret': API_SECRET }
                });

                if (epRes.data.success && Array.isArray(epRes.data.episodes) && epRes.data.episodes.length > 0) {
                    const episodes = epRes.data.episodes;
                    episodeCache.set(jid, episodes);

                    let responseText = `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n📺 *${epRes.data.seriesTitle} - Episodes*\n\n`;
                    episodes.forEach((ep, idx) => {
                        const num = idx + 1;
                        responseText += `*${num}. ${ep.title}*\n`;
                        responseText += `   👉 Send *${num}* to download (or *${num} 1080p*)\n\n`;
                    });

                    responseText += `💡 *Reply with the episode number (e.g. 1) to download!*`;
                    await sock.sendMessage(jid, { text: responseText });
                    try {
                        await sock.sendMessage(jid, { react: { text: '📺', key: msg.key } });
                    } catch (e) {}
                } else {
                    await sock.sendMessage(jid, { text: `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n❌ No episodes found for this series or season.` });
                }
            } catch (err) {
                await sock.sendMessage(jid, { text: `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n❌ Unable to retrieve series episodes.` });
            }
            return;
        }

        // ── 7. Command: .dl <number|movieId> [quality] ──
        const dlMatch = text.match(/^[./!]?(dl|download|get)\s+(\S+)(?:\s+(\S+))?/i);
        if (dlMatch) {
            const target = dlMatch[2].trim();
            const requestedQuality = (dlMatch[3] || '720p').trim().toLowerCase();
            let movieId = target;
            let movieTitle = '';

            const cachedList = searchCache.get(jid) || [];
            const index = parseInt(target, 10);
            if (!isNaN(index) && index >= 1 && index <= cachedList.length) {
                const selected = cachedList[index - 1];
                movieId = selected.id;
                movieTitle = selected.title;

                if (selected.isSeries) {
                    await sock.sendMessage(jid, { 
                        text: `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n📺 *"${selected.title}"* is a TV Series with ${selected.episodesCount || 0} episodes.\nSend *.ep ${index}* or *${index}* to browse episodes.` 
                    });
                    return;
                }
            }

            try {
                await sock.sendMessage(jid, { text: `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n⏳ *Processing download request for:* *${movieTitle || movieId}*...` });

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
                        quality: dlRes.data.quality || requestedQuality,
                        msgKey: msg.key
                    });

                    if (queue.length > 1 || isProcessingQueue.get(sessionId)) {
                        await sock.sendMessage(jid, { text: `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n📋 *Queue Position:* #${queue.length}\n⏳ File will be sent shortly.` });
                    }
                    processQueue(sessionId, sock);
                }
            } catch (err) {
                const errorMsg = err.response?.data?.error || 'Failed to request download. Pro plan subscription required.';
                await sock.sendMessage(jid, { text: `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n❌ *Error:* ${errorMsg}` });
                try {
                    await sock.sendMessage(jid, { react: { text: '❌', key: msg.key } });
                } catch (e) {}
            }
            return;
        }

        // ── 8. Command: .status / plan / limit ──
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
                        text: `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n` +
                              `💎 *Account Status: PRO MEMBER*\n\n` +
                              `📱 *Connected Number:* ${myNumber}\n` +
                              `📧 *Email:* ${userEmail || 'Active Pro'}\n` +
                              `🚀 *Downloads:* Unlimited (Movies & Series)\n` +
                              `⚡ *Qualities Available:* 720p HD & 1080p FHD\n` +
                              `🔍 *Smart Search:* Active\n` +
                              `🔒 *Privacy:* Self-chat only (Protected)\n\n` +
                              `_Enjoy watching on FlickNest!_`
                    });
                } else {
                    await sock.sendMessage(jid, {
                        text: `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n` +
                              `ℹ️ *Account Status: Free Plan*\n\n` +
                              `To unlock Unlimited Movie & Series downloads directly on your WhatsApp, subscribe to the Pro Plan at *flicknest.site*.`
                    });
                }
                try {
                    await sock.sendMessage(jid, { react: { text: '💎', key: msg.key } });
                } catch (e) {}
            } catch (err) {
                await sock.sendMessage(jid, { text: `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n❌ Unable to check status at this time.` });
            }
            return;
        }

        // ── 9. Command: .help / menu / hi / hello ──
        if (text.match(/^[./!]?(help|menu|commands|hi|hello|hey|start|bot)$/i)) {
            const helpGuide = 
`*🎬 FLICKNEST WHATSAPP BOT 🍿*

🍿 *MOVIES / SERIES ලබාගන්නා ආකාරය:*
━━━━━━━━━━━━━━━━━━━━━
1️⃣ *Direct Search (කෙලින්ම නම Type කරන්න):*
   • කැමති Movie හෝ Series එකේ නම Message කරන්න.
   • උදා: *Avatar*, *Spider Man*, *Money Heist*

2️⃣ *Quick Download (අංකය එවා Download කරගන්න):*
   • Search results ලැබුණු පසු අවශ්‍ය Movie එකෙහි අංකය එවන්න.
   • 720p HD: 👉 *1*
   • 1080p Full HD: 👉 *1 1080p*

3️⃣ *TV Series Episodes:*
   • Series එකක අංකය එවූ පසු Episode අංකය (උදා: *1*) එවන්න.

━━━━━━━━━━━━━━━━━━━━━
⚡ *AVAILABLE COMMANDS (විධාන ලැයිස්තුව):*
━━━━━━━━━━━━━━━━━━━━━
• 🔥 *.trending* ➔ Top Trending Movies & Series
• ✨ *.latest* ➔ අලුතින්ම එකතු වූ අලුත්ම චිත්‍රපට
• 📺 *.ep <number>* ➔ Series Episodes බැලීමට
• ℹ️ *.info <number>* ➔ Synopsis, Cast, Rating බැලීමට
• 💎 *.status* ➔ ඔබගේ Pro Membership තත්ත්වය බැලීමට
• ❓ *.help* ➔ මෙම උපදෙස් මාලාව නැවත ලබාගැනීමට

🔒 _Private & Secure: Only YOU can trigger this bot via your own chat._
🌐 _flicknest.site_`;

            await sock.sendMessage(jid, { text: helpGuide });
            try {
                await sock.sendMessage(jid, { react: { text: '🍿', key: msg.key } });
            } catch (e) {}
            return;
        }

        // ── 10. Direct Movie Search (Typing movie name directly without any command prefix!) ──
        const isPrefixedCommand = text.startsWith('.') || text.startsWith('!') || text.startsWith('/');
        if (!isPrefixedCommand && text.length >= 2 && text.length <= 60) {
            const query = text.trim();
            console.log(`[${sessionId}] Auto direct search for "${query}" from self chat`);

            try {
                await sock.sendMessage(jid, { 
                    text: `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n🔍 *Searching for:* _"${query}"_...` 
                });

                const searchRes = await axios.post(`${websiteUrl}/api/whatsapp/bot-command`, {
                    action: 'search',
                    query: query
                }, {
                    headers: { 'x-api-secret': API_SECRET }
                });

                if (searchRes.data.success && Array.isArray(searchRes.data.movies) && searchRes.data.movies.length > 0) {
                    const movies = searchRes.data.movies;
                    searchCache.set(jid, movies);

                    let header = `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n🔍 *Search Results for "${query}"*\nFound ${movies.length} title(s):\n\n`;
                    if (searchRes.data.isFuzzy) {
                        header = `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n✨ *Similar Matches for "${query}"*\n(Auto-corrected spelling):\n\n`;
                    }

                    let responseText = header;
                    movies.forEach((m, idx) => {
                        const num = idx + 1;
                        const rating = m.rating ? `⭐ ${m.rating}/10` : '';
                        const year = m.year ? `(${m.year})` : '';
                        const typeTag = m.isSeries ? '📺 TV Series' : '🎬 Movie';

                        responseText += `*${num}. ${m.title}* ${year} · ${typeTag}\n`;
                        if (rating) responseText += `   ${rating} | 🎭 ${m.genres || 'General'}\n`;
                        
                        if (m.isSeries) {
                            responseText += `   👉 Send *${num}* to view episodes\n\n`;
                        } else {
                            responseText += `   👉 Send *${num}* to download (or *${num} 1080p*)\n\n`;
                        }
                    });

                    responseText += `💡 *Tip:* Simply reply with the *number* (e.g. *1* or *1 1080p*) to download instantly!`;
                    await sock.sendMessage(jid, { text: responseText });
                    try {
                        await sock.sendMessage(jid, { react: { text: '🎬', key: msg.key } });
                    } catch (e) {}
                } else {
                    await sock.sendMessage(jid, { 
                        text: `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n❌ No movies or series found matching *"${query}"*.\n\n💡 Try searching with different keywords, or type *.trending* to see popular movies!` 
                    });
                    try {
                        await sock.sendMessage(jid, { react: { text: '🔍', key: msg.key } });
                    } catch (e) {}
                }
            } catch (err) {
                console.error(`[${sessionId}] Direct search error:`, err.message);
                await sock.sendMessage(jid, { text: `*🎬 FLICKNEST WHATSAPP BOT 🍿*\n\n❌ Failed to search movies. Please try again later.` });
            }
            return;
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
