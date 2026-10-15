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
                text: `Downloading ${task.movieTitle} (${task.quality || '720p'})...\nPlease wait while the file is sent.` 
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
            await sock.sendMessage(task.jid, { text: `Failed to send file due to a connection or download error.` }).catch(() => {});
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

        const text = (
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            msg.message.videoMessage?.caption ||
            ''
        ).trim();

        if (!text) return;

        const websiteUrl = process.env.WEBSITE_URL || 'http://localhost:3000';

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
        // 2. USER'S OWN CONNECTED NUMBER (Personal / Group Bot Session)
        // Commands are ONLY active on the user's personal connected bot!
        // Includes:
        // • Smart fuzzy / typo-tolerant movie search
        // • TV Series & Episode viewing and downloading
        // • Full movie details & synopsis (.info)
        // • Trending (.trending) and Latest (.latest)
        // • Unlimited movie & episode downloads for Pro members!
        // ═════════════════════════════════════════════════════════════
        const meta = sessionMeta.get(sessionId) || {};
        const userEmail = meta.email || null;

        // Website token download if clicked
        if (text.startsWith('GET-MOVIE-') || text.startsWith('GET-SEASON-')) {
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
            return;
        }

        // ── Command: .trending ──
        if (text.match(/^[./!]?(trending|popular)$/i)) {
            try {
                await sock.sendMessage(jid, { text: 'Fetching trending titles on FlickNest...' });
                const res = await axios.post(`${websiteUrl}/api/whatsapp/bot-command`, {
                    action: 'trending'
                }, {
                    headers: { 'x-api-secret': API_SECRET }
                });

                if (res.data.success && Array.isArray(res.data.movies) && res.data.movies.length > 0) {
                    const movies = res.data.movies;
                    searchCache.set(jid, movies);

                    let responseText = `*Trending on FlickNest*\n\n`;
                    movies.forEach((m, idx) => {
                        const num = idx + 1;
                        const year = m.year ? `(${m.year})` : '';
                        const rating = m.rating ? `Rating: ${m.rating}` : '';
                        const typeTag = m.isSeries ? '[TV Series]' : '[Movie]';
                        responseText += `${num}. *${m.title}* ${year} ${typeTag}\n`;
                        if (rating) responseText += `   ${rating} | ${m.genres || 'General'}\n`;
                        if (m.isSeries) {
                            responseText += `   Episodes: .ep ${num}\n\n`;
                        } else {
                            responseText += `   Download: .dl ${num} 720p  or  .dl ${num} 1080p\n\n`;
                        }
                    });

                    responseText += `Reply with *.dl <number> <quality>* to download, or *.info <number>* for synopsis.`;
                    await sock.sendMessage(jid, { text: responseText });
                } else {
                    await sock.sendMessage(jid, { text: 'No trending titles available right now.' });
                }
            } catch (err) {
                await sock.sendMessage(jid, { text: 'Unable to fetch trending titles.' });
            }
            return;
        }

        // ── Command: .latest / .new ──
        if (text.match(/^[./!]?(latest|new|recent)$/i)) {
            try {
                await sock.sendMessage(jid, { text: 'Fetching latest releases on FlickNest...' });
                const res = await axios.post(`${websiteUrl}/api/whatsapp/bot-command`, {
                    action: 'latest'
                }, {
                    headers: { 'x-api-secret': API_SECRET }
                });

                if (res.data.success && Array.isArray(res.data.movies) && res.data.movies.length > 0) {
                    const movies = res.data.movies;
                    searchCache.set(jid, movies);

                    let responseText = `*Latest Releases on FlickNest*\n\n`;
                    movies.forEach((m, idx) => {
                        const num = idx + 1;
                        const year = m.year ? `(${m.year})` : '';
                        const typeTag = m.isSeries ? '[TV Series]' : '[Movie]';
                        responseText += `${num}. *${m.title}* ${year} ${typeTag}\n`;
                        responseText += `   Quality: ${m.quality || 'HD'} | ${m.genres || 'General'}\n`;
                        if (m.isSeries) {
                            responseText += `   Episodes: .ep ${num}\n\n`;
                        } else {
                            responseText += `   Download: .dl ${num} 720p  or  .dl ${num} 1080p\n\n`;
                        }
                    });

                    responseText += `Reply with *.dl <number> <quality>* to download.`;
                    await sock.sendMessage(jid, { text: responseText });
                } else {
                    await sock.sendMessage(jid, { text: 'No new releases found.' });
                }
            } catch (err) {
                await sock.sendMessage(jid, { text: 'Unable to fetch latest releases.' });
            }
            return;
        }

        // ── Command: .info <number|movieId> ──
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
                await sock.sendMessage(jid, { text: 'Fetching title details...' });
                const infoRes = await axios.post(`${websiteUrl}/api/whatsapp/bot-command`, {
                    action: 'info',
                    movieId
                }, {
                    headers: { 'x-api-secret': API_SECRET }
                });

                if (infoRes.data.success && infoRes.data.movie) {
                    const m = infoRes.data.movie;
                    let text = `*${m.title}* (${m.year || 'N/A'})\n\n`;
                    if (m.description) text += `*Synopsis:* ${m.description}\n\n`;
                    if (m.director) text += `*Director:* ${m.director}\n`;
                    if (m.actors) text += `*Cast:* ${m.actors}\n`;
                    if (m.genres) text += `*Genres:* ${m.genres}\n`;
                    if (m.runtime) text += `*Runtime:* ${m.runtime}\n`;
                    if (m.rating || m.imdbRating) text += `*Rating:* ${m.rating || m.imdbRating} / 10\n`;
                    if (m.language) text += `*Language:* ${m.language}\n`;
                    if (m.quality) text += `*Quality:* ${m.quality}\n\n`;

                    if (m.episodesCount > 0) {
                        text += `*TV Series:* ${m.episodesCount} episode(s) available.\n`;
                        text += `Use *.ep ${m.id}* to view episodes.`;
                    } else {
                        text += `To download: *.dl ${m.id} 720p* or *.dl ${m.id} 1080p*`;
                    }

                    await sock.sendMessage(jid, { text });
                } else {
                    await sock.sendMessage(jid, { text: 'Title details not found.' });
                }
            } catch (err) {
                await sock.sendMessage(jid, { text: 'Unable to retrieve title info.' });
            }
            return;
        }

        // ── Command: .ep / .series <number|seriesId> [season] ──
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
                await sock.sendMessage(jid, { text: 'Fetching TV Series episodes...' });
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

                    let responseText = `*${epRes.data.seriesTitle} - Episodes*\n\n`;
                    episodes.forEach((ep, idx) => {
                        const num = idx + 1;
                        let dlOpt = [];
                        if (ep.has720p) dlOpt.push(`.dlep ${num} 720p`);
                        if (ep.has1080p) dlOpt.push(`.dlep ${num} 1080p`);
                        if (dlOpt.length === 0) dlOpt.push(`.dlep ${num}`);

                        responseText += `${num}. *${ep.title}*\n`;
                        responseText += `   Download: ${dlOpt.join('  or  ')}\n\n`;
                    });

                    responseText += `Reply with *.dlep <number> <quality>* to download the episode!\nExample: *.dlep 1 720p*`;
                    await sock.sendMessage(jid, { text: responseText });
                } else {
                    await sock.sendMessage(jid, { text: 'No episodes found for this series or season.' });
                }
            } catch (err) {
                await sock.sendMessage(jid, { text: 'Unable to retrieve series episodes.' });
            }
            return;
        }

        // ── Command: .dlep <number|episodeId> [quality] ──
        const dlepMatch = text.match(/^[./!]?(dlep|downloadep)\s+(\S+)(?:\s+(\S+))?/i);
        if (dlepMatch) {
            const target = dlepMatch[2].trim();
            const requestedQuality = (dlepMatch[3] || '720p').trim().toLowerCase();
            let episodeId = target;
            let epTitle = '';

            const cachedEpisodes = episodeCache.get(jid) || [];
            const index = parseInt(target, 10);
            if (!isNaN(index) && index >= 1 && index <= cachedEpisodes.length) {
                const selected = cachedEpisodes[index - 1];
                episodeId = selected.id;
                epTitle = selected.title;
            }

            try {
                await sock.sendMessage(jid, { text: 'Processing episode download request...' });

                const dlRes = await axios.post(`${websiteUrl}/api/whatsapp/bot-command`, {
                    action: 'download-episode',
                    episodeId,
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
                        movieTitle: dlRes.data.movieTitle || epTitle || 'Episode',
                        quality: dlRes.data.quality || requestedQuality
                    });

                    if (queue.length > 1 || isProcessingQueue.get(sessionId)) {
                        await sock.sendMessage(jid, { text: `Queued at position #${queue.length}. File will be sent shortly.` });
                    }
                    processQueue(sessionId, sock);
                }
            } catch (err) {
                const errorMsg = err.response?.data?.error || 'Failed to request episode download.';
                await sock.sendMessage(jid, { text: errorMsg });
            }
            return;
        }

        // ── Command: .movie / .search with Typo Tolerance ──
        const searchMatch = text.match(/^[./!]?(movie|search|film)\s+(.+)/i);
        if (searchMatch) {
            const query = searchMatch[2].trim();
            console.log(`[${sessionId}] User bot search for "${query}" in ${jid}`);

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

                    let header = `*FlickNest Search Results*\n\nFound ${movies.length} result(s) for "${query}":\n\n`;
                    if (searchRes.data.isFuzzy) {
                        header = `*Similar Matches Found for "${query}"*\n(Auto-corrected spelling to closest titles):\n\n`;
                    }

                    let responseText = header;
                    movies.forEach((m, idx) => {
                        const num = idx + 1;
                        const rating = m.rating ? `Rating: ${m.rating}` : '';
                        const year = m.year ? `(${m.year})` : '';
                        const typeTag = m.isSeries ? '[TV Series]' : '[Movie]';

                        responseText += `${num}. *${m.title}* ${year} ${typeTag}\n`;
                        if (rating) responseText += `   ${rating} | ${m.genres || 'General'}\n`;
                        
                        if (m.isSeries) {
                            responseText += `   Episodes: .ep ${num}\n\n`;
                        } else {
                            let dlOptions = [];
                            if (m.has720p) dlOptions.push(`.dl ${num} 720p`);
                            if (m.has1080p) dlOptions.push(`.dl ${num} 1080p`);
                            if (dlOptions.length === 0) dlOptions.push(`.dl ${num}`);
                            responseText += `   Download: ${dlOptions.join('  or  ')}\n\n`;
                        }
                    });

                    responseText += `Reply with *.dl <number> <quality>* to download movie,\n` +
                                    `or *.ep <number>* to view TV Series episodes,\n` +
                                    `or *.info <number>* for full synopsis.`;
                    await sock.sendMessage(jid, { text: responseText });
                } else {
                    await sock.sendMessage(jid, { text: `No movies or series found matching "${query}". Please check the spelling or search another keyword.` });
                }
            } catch (err) {
                console.error(`[${sessionId}] Search error:`, err.message);
                await sock.sendMessage(jid, { text: 'Failed to search movies. Please try again later.' });
            }
            return;
        }

        // ── Command: .dl <number|movieId> [quality] ──
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

                // If user tries to .dl a TV Series, guide them to episodes
                if (selected.isSeries) {
                    await sock.sendMessage(jid, { 
                        text: `"${selected.title}" is a TV Series with ${selected.episodesCount || 0} episodes.\nUse *.ep ${index}* to browse and download episodes.` 
                    });
                    return;
                }
            }

            try {
                await sock.sendMessage(jid, { text: 'Processing download request...' });

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

                    if (queue.length > 1 || isProcessingQueue.get(sessionId)) {
                        await sock.sendMessage(jid, { text: `Queued at position #${queue.length}. File will be sent shortly.` });
                    }
                    processQueue(sessionId, sock);
                }
            } catch (err) {
                const errorMsg = err.response?.data?.error || 'Failed to request download. Pro plan subscription required.';
                await sock.sendMessage(jid, { text: errorMsg });
            }
            return;
        }

        // ── Command: .status ──
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
                        text: `*FlickNest Connected Bot Status*\n\n` +
                              `Bot Number: Connected (Personal Number)\n` +
                              `Account: ${userEmail || 'Active Pro'}\n` +
                              `Plan: Pro Member\n` +
                              `Movie & Series Downloads: Unlimited\n` +
                              `Typo-Tolerant Search: Enabled\n` +
                              `TV Series Support: Enabled\n` +
                              `Status: Active\n\n` +
                              `Commands are active in your direct chats and any WhatsApp groups you create!`
                    });
                } else {
                    await sock.sendMessage(jid, {
                        text: `*FlickNest Connected Bot Status*\n\n` +
                              `Status: Pro subscription not active.\n\n` +
                              `To use your personal number as a FlickNest bot with unlimited downloads and TV Series support, please subscribe to the Pro Plan at flicknest.site.`
                    });
                }
            } catch (err) {
                await sock.sendMessage(jid, { text: 'Unable to check status at this time.' });
            }
            return;
        }

        // ── Command: .help ──
        if (text.match(/^[./!]?(help|menu|commands)$/i)) {
            await sock.sendMessage(jid, {
                text: `*FlickNest Personal WhatsApp Bot (Pro)*\n\n` +
                      `Use these commands in direct chat or in any group you create:\n\n` +
                      `• *.movie <title>* - Search movies & TV series (with smart typo auto-correction)\n` +
                      `• *.dl <number> <quality>* - Download movie (e.g. .dl 1 720p or .dl 1 1080p)\n` +
                      `• *.ep <number> [season]* - View TV Series episodes (e.g. .ep 1)\n` +
                      `• *.dlep <number> <quality>* - Download TV Series episode (e.g. .dlep 1 720p)\n` +
                      `• *.info <number>* - View plot summary, cast, director, rating\n` +
                      `• *.trending* - View top trending movies & series\n` +
                      `• *.latest* - View newly added titles\n` +
                      `• *.status* - Check Pro status & unlimited downloads\n` +
                      `• *.help* - Show this menu\n\n` +
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
