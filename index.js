require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { loadExistingSessions, startSession, sessions } = require('./botManager');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3500;
const API_SECRET = process.env.WA_API_SECRET || 'flicknest-wa-secret-2026';

app.get('/status', (req, res) => {
    const mainSock = sessions.get('main');
    res.json({ 
        online: true, 
        waConnected: !!(mainSock && mainSock.user),
        activeSessions: sessions.size
    });
});

app.get('/session-status', (req, res) => {
    const { email, secret } = req.query;
    if (secret !== API_SECRET) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    if (!email) {
        return res.status(400).json({ success: false, error: 'Missing email' });
    }
    const sessionId = email.replace(/[^a-zA-Z0-9]/g, '_');
    const sock = sessions.get(sessionId);
    const connected = !!(sock && sock.user);
    res.json({ success: true, connected });
});

// Endpoint for Admin to pair the MAIN bot using a code instead of QR
app.get('/pair-main', async (req, res) => {
    const { phone } = req.query;
    if (!phone) return res.status(400).send('Please provide a phone number: /pair-main?phone=947XXXXXXXX');
    
    const mainSock = sessions.get('main');
    if (!mainSock) {
        return res.status(500).send('Main session not initialized yet.');
    }
    
    if (mainSock.authState.creds.registered) {
        return res.send('Main bot is already connected! No need to pair.');
    }

    try {
        const formattedNumber = phone.replace(/[^0-9]/g, '');
        const code = await mainSock.requestPairingCode(formattedNumber);
        res.send(`<h1>Your Pairing Code: <strong>${code}</strong></h1><p>Enter this in your linked devices section on WhatsApp.</p>`);
    } catch (err) {
        console.error('Failed to get pairing code for main:', err);
        res.status(500).send(`Error: ${err.message}`);
    }
});


// Endpoint for frontend to request a pairing code for a Pro user
app.post('/pair', async (req, res) => {
    const { email, phoneNumber, secret, type } = req.body; // type can be 'code' or 'qr'
    
    if (secret !== API_SECRET) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    
    // For pairing code, phone number is required
    if (type !== 'qr' && !phoneNumber) {
        return res.status(400).json({ success: false, error: 'Missing phone number for pairing code' });
    }

    try {
        const sessionId = email.replace(/[^a-zA-Z0-9]/g, '_');
        
        // Check if session already exists
        if (sessions.has(sessionId)) {
            const sock = sessions.get(sessionId);
            if (sock.user) {
                return res.json({ success: true, message: 'Already connected', alreadyConnected: true });
            }
        }

        // Start session and get pairing code or QR
        startSession(sessionId, { type: type || 'code', phoneNumber }, (result) => {
            if (result.type === 'error') {
                return res.status(500).json({ success: false, error: result.data || 'Failed to request code/QR' });
            } else if (result.type === 'code') {
                res.json({ success: true, method: 'code', code: result.data });
            } else if (result.type === 'qr') {
                res.json({ success: true, method: 'qr', qr: result.data });
            }
        });

    } catch (error) {
        console.error('Pairing error:', error);
        res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
});

app.listen(PORT, () => {
    console.log(`\n🚀 FlickNest WhatsApp Bot Server running on port ${PORT}`);
    loadExistingSessions();
});

