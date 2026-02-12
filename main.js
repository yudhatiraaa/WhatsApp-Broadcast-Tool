const { Client, LocalAuth, MessageMedia, Location } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const fs = require('fs');
const os = require('os');
const multer = require('multer');
const xlsx = require('xlsx');
const axios = require('axios');
const app = express();
const port = 3000;

// Konfigurasi Express untuk JSON dan file statis
app.use(express.json());
app.use(express.static('public'));

// Konfigurasi Multer untuk menangani upload file (disimpan di memori sementara)
const upload = multer({ storage: multer.memoryStorage() });

// --- Session Management ---
const sessions = new Map(); // Menyimpan data sesi: { id, client, qr, ready, info, ... }
let clients = [];

function startSession(id) {
    if (sessions.has(id)) return;

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: id }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });

    const session = {
        id: id,
        client: client,
        qr: null,
        ready: false,
        info: null,
        broadcasting: false,
        paused: false,
        startTime: 0,
        report: [],
        isLoading: true,
        isChecking: false,
        shouldStopCheck: false
    };

    sessions.set(id, session);

    client.on('ready', async () => {
        console.log(`[${id}] Client is ready!`);
        session.ready = true;
        session.qr = null;
        session.isLoading = false;
        
        const info = client.info;
        session.info = {
            name: info.pushname || 'WhatsApp User',
            number: info.wid.user,
            platform: info.platform
        };

        sendEvent({ type: 'ready', sessionId: id, user: session.info });
        broadcastLog(`[${id}] WhatsApp Siap: ${session.info.name}`);
        
        try {
            const batteryInfo = await client.getBatteryStatus();
            sendEvent({ type: 'battery', sessionId: id, data: { level: batteryInfo.battery, charging: batteryInfo.plugged } });
        } catch (e) {}
    });

    client.on('qr', qr => {
        // qrcode.generate(qr, {small: true}); // Optional di terminal
        session.qr = qr;
        session.ready = false;
        session.isLoading = false;
        console.log(`[${id}] QR Code received.`);
        sendEvent({ type: 'qr', sessionId: id, data: qr });
        broadcastLog(`[${id}] Silakan scan QR Code.`);
    });

    client.on('change_battery', (batteryInfo) => {
        const { battery, plugged } = batteryInfo;
        sendEvent({ type: 'battery', sessionId: id, data: { level: battery, charging: plugged } });
    });

    client.on('disconnected', (reason) => {
        console.log(`[${id}] Disconnected:`, reason);
        session.ready = false;
        session.qr = null;
        session.info = null;
        session.isLoading = true;
        broadcastLog(`[${id}] Terputus (${reason}). Restarting...`);
        sendEvent({ type: 'loading', sessionId: id });
        client.initialize();
    });

    // Fitur Auto Reject Call
    client.on('call', async (call) => {
        if (appSettings.autoRejectCall) {
            try {
                await call.reject();
                broadcastLog(`[${id}] 📞 Menolak panggilan masuk dari ${call.from}`);
            } catch (e) {
                console.error(`[${id}] Gagal menolak panggilan:`, e);
            }
        }
    });

    // Attach Message Handler (Shared Logic)
    client.on('message', async message => {
        handleIncomingMessage(message, id);
    });

    // Event khusus untuk Live Chat (Mendeteksi pesan masuk DAN keluar)
    client.on('message_create', async (msg) => {
        try {
            // LOGIKA BARU: Tentukan ID Chat secara pasti
            // Jika pesan keluar (fromMe), maka Chat ID = msg.to (Penerima)
            // Jika pesan masuk (!fromMe), maka Chat ID = msg.from (Pengirim)
            const chatId = msg.fromMe ? msg.to : msg.from;
            let senderName = msg._data.notifyName || '';

            // Jika pesan grup (ada author), ambil nama kontak yang tersimpan
            if (!msg.fromMe && msg.author) {
                try {
                    const contact = await session.client.getContactById(msg.author);
                    senderName = contact.name || contact.pushname || contact.number;
                } catch (e) {}
            }
            if (!senderName) senderName = msg._data.notifyName || (msg.author ? msg.author.split('@')[0] : '');

            sendEvent({
                type: 'new_message',
                sessionId: id,
                message: {
                    id: msg.id._serialized,
                    from: msg.from,
                    to: msg.to,
                    author: msg.author,
                    body: msg.body,
                    timestamp: msg.timestamp,
                    fromMe: msg.fromMe,
                    chatId: chatId,
                    senderName: senderName,
                    hasMedia: msg.hasMedia,
                    type: msg.type
                }
            });
        } catch (e) {
            console.error('Error handling message_create:', e);
        }
    });

    sendEvent({ type: 'loading', sessionId: id });
    client.initialize();
}

// Start default session
startSession('session1');

// --- Pengaturan (Settings) ---
const SETTINGS_FILE = 'settings.json';
let appSettings = { webhookUrl: '', aiEnabled: false, aiSystemPrompt: 'Kamu adalah asisten virtual yang membantu menjawab pertanyaan pelanggan dengan ramah dan singkat.', aiAllowedTopics: '', welcomeMessage: '', aiBlacklist: [], aiIgnoreGroups: false, autoRejectCall: false, arIgnoreGroups: false, aiDailyLimit: 0 };

if (fs.existsSync(SETTINGS_FILE)) {
    try {
        const loadedSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE));
        appSettings = { ...appSettings, ...loadedSettings }; // Merge dengan default
    } catch (e) {}
}

function saveSettings() {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(appSettings, null, 2));
}
// -----------------------------

// --- Seen Contacts (Welcome Message) ---
const SEEN_FILE = 'seen.json';
let seenContacts = new Set();

if (fs.existsSync(SEEN_FILE)) {
    try {
        const data = JSON.parse(fs.readFileSync(SEEN_FILE));
        seenContacts = new Set(data);
    } catch (e) {}
}

function saveSeenContacts() {
    fs.writeFileSync(SEEN_FILE, JSON.stringify([...seenContacts]));
}
// ---------------------------------------

// --- Auto Reply ---
const AUTOREPLY_FILE = 'autoreply.json';

function getAutoReplies() {
    if (!fs.existsSync(AUTOREPLY_FILE)) return [];
    try {
        return JSON.parse(fs.readFileSync(AUTOREPLY_FILE));
    } catch (e) {
        return [];
    }
}

function saveAutoReplies(replies) {
    fs.writeFileSync(AUTOREPLY_FILE, JSON.stringify(replies, null, 2));
}

app.get('/autoreply', (req, res) => {
    res.json(getAutoReplies());
});

app.post('/autoreply', (req, res) => {
    const { keyword, response, type } = req.body; // type: 'exact' (persis) or 'contains' (mengandung)
    if (!keyword || !response) return res.status(400).json({ status: 'error', message: 'Keyword dan Response harus diisi' });
    
    const replies = getAutoReplies();
    // Cek jika keyword sudah ada, update
    const index = replies.findIndex(r => r.keyword.toLowerCase() === keyword.toLowerCase());
    if (index >= 0) {
        replies[index] = { keyword, response, type: type || 'contains' };
    } else {
        replies.push({ keyword, response, type: type || 'contains' });
    }
    
    saveAutoReplies(replies);
    res.json({ status: 'success', message: 'Auto-reply disimpan' });
});

app.delete('/autoreply/:keyword', (req, res) => {
    const keyword = req.params.keyword;
    let replies = getAutoReplies();
    const newReplies = replies.filter(r => r.keyword !== keyword);
    saveAutoReplies(newReplies);
    res.json({ status: 'success', message: 'Auto-reply dihapus' });
});

// --- AI Usage Tracking (In-Memory) ---
let aiUsage = { date: new Date().toDateString(), counts: {} };

function checkAndIncrementAiUsage(number) {
    if (!appSettings.aiDailyLimit || appSettings.aiDailyLimit <= 0) return true;
    
    const today = new Date().toDateString();
    if (aiUsage.date !== today) {
        aiUsage = { date: today, counts: {} };
    }
    
    const count = aiUsage.counts[number] || 0;
    if (count >= appSettings.aiDailyLimit) return false;
    
    aiUsage.counts[number] = count + 1;
    return true;
}

async function handleIncomingMessage(message, sessionId) {
    if (message.body === '!ping') {
        message.reply('pong');
    }

    // --- Welcome Message Logic ---
    // Cek apakah fitur aktif, bukan grup, dan nomor belum pernah berinteraksi
    if (appSettings.welcomeMessage && !message.from.includes('@g.us') && !message.from.includes('status@broadcast')) {
        if (!seenContacts.has(message.from)) {
            try {
                // Simulasi mengetik
                const chat = await message.getChat();
                await chat.sendStateTyping();
                await new Promise(resolve => setTimeout(resolve, 1500));
                await chat.clearState();

                await message.reply(appSettings.welcomeMessage);
                console.log(`[${sessionId}] [Welcome] Mengirim sambutan ke ${message.from}`);
                
                seenContacts.add(message.from);
                saveSeenContacts();
            } catch (e) {
                console.error(`[${sessionId}] Welcome Msg Error:`, e);
            }
        }
    }
    // -----------------------------

    // Webhook Forwarding: Kirim pesan masuk ke URL eksternal
    if (appSettings.webhookUrl) {
        try {
            const payload = {
                from: message.from,
                sessionId: sessionId,
                senderName: message._data.notifyName || '',
                message: message.body,
                timestamp: message.timestamp,
                hasMedia: message.hasMedia
            };
            // Jangan await agar tidak memblokir proses lain
            axios.post(appSettings.webhookUrl, payload).catch(err => {
                console.error('Webhook Error:', err.message);
            });
        } catch (error) {
            console.error('Webhook Error:', error);
        }
    }

    // --- Logika Auto Reply ---
    try {
        let replied = false;
        const replies = getAutoReplies();
        const msgBody = message.body.toLowerCase();
        
        const isGroupMessage = message.from.endsWith('@g.us');
        // Jalankan auto-reply jika bukan grup, atau jika ini grup tapi setting ignore tidak aktif
        if (!isGroupMessage || !appSettings.arIgnoreGroups) {
            for (const rule of replies) {
                const keyword = rule.keyword.toLowerCase();
                let match = false;
                
                if (rule.type === 'exact') {
                    if (msgBody === keyword) match = true;
                } else { // contains
                    if (msgBody.includes(keyword)) match = true;
                }
    
                if (match) {
                    // Simulasi mengetik agar terlihat natural
                    const chat = await message.getChat();
                    await chat.sendStateTyping();
                    await new Promise(resolve => setTimeout(resolve, 2000)); 
                    await chat.clearState();
                    
                    await message.reply(rule.response);
                    console.log(`[${sessionId}] [AutoReply] Membalas ${message.from} untuk keyword: ${rule.keyword}`);
                    replied = true;
                    break; // Berhenti setelah menemukan satu kecocokan
                }
            }
        }

        // --- AI Auto Reply (Fallback) ---
        // Jika tidak ada keyword yang cocok DAN AI diaktifkan
        if (!replied && appSettings.aiEnabled && !message.from.includes('status@broadcast') && (!appSettings.aiBlacklist || !appSettings.aiBlacklist.includes(message.from))) {
            const chat = await message.getChat();
            
            // Double check jika chat adalah grup dan grup tersebut di blacklist
            if (chat.isGroup) {
                if (appSettings.aiIgnoreGroups) return; // Fitur baru: Otomatis abaikan semua grup
                if (appSettings.aiBlacklist && appSettings.aiBlacklist.includes(chat.id._serialized)) return;
            }

            // Cek Limit Harian AI
            if (!checkAndIncrementAiUsage(message.from)) {
                console.log(`[${sessionId}] [AI] Limit harian tercapai untuk ${message.from}`);
                return;
            }

            // Simulasi mengetik
            await chat.sendStateTyping();
            
            try {
                const prompt = message.body;
                let systemPrompt = appSettings.aiSystemPrompt;

                // Tambahkan instruksi pembatasan topik jika ada
                if (appSettings.aiAllowedTopics) {
                    systemPrompt += `\n\nPENTING: Kamu hanya boleh menjawab pertanyaan yang berkaitan dengan topik: ${appSettings.aiAllowedTopics}. Jika pengguna bertanya di luar topik tersebut, tolak dengan sopan dan arahkan kembali ke topik utama.`;
                }

                // Request ke Pollinations.ai (Gratis & Unlimited)
                const response = await axios.post('https://text.pollinations.ai/', {
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: prompt }
                    ],
                    model: 'openai', // Menggunakan model GPT-4o like
                    seed: Math.floor(Math.random() * 1000)
                }, { headers: { 'Content-Type': 'application/json' } });

                const aiReply = response.data; // Respon teks langsung
                await message.reply(aiReply);
                console.log(`[${sessionId}] [AI Reply] Membalas ${message.from}`);
            } catch (err) {
                console.error(`[${sessionId}] AI Error:`, err.message);
            } finally {
                await chat.clearState();
            }
        }
    } catch (e) {
        console.error(`[${sessionId}] Auto Reply Error:`, e);
    }
}

// Fungsi untuk memproses Spintax (Spin Syntax)
function parseSpintax(text) {
    if (!text) return "";
    let matches;
    // Cari pola {a|b|c} dan ganti dengan salah satu pilihan secara acak
    while ((matches = text.match(/{([^{}]+?)}/))) {
        const options = matches[1].split('|').map(opt => opt.trim());
        const randomOption = options[Math.floor(Math.random() * options.length)];
        text = text.replace(matches[0], randomOption);
    }
    return text;
}

// --- Setup Server-Sent Events (SSE) untuk Log Real-time ---

app.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Kirim status awal semua sesi
    for (const [id, session] of sessions) {
        if (session.isLoading) res.write(`data: ${JSON.stringify({ type: 'loading', sessionId: id })}\n\n`);
        if (session.qr) res.write(`data: ${JSON.stringify({ type: 'qr', sessionId: id, data: session.qr })}\n\n`);
        if (session.ready) res.write(`data: ${JSON.stringify({ type: 'ready', sessionId: id, user: session.info })}\n\n`);
        if (session.broadcasting) res.write(`data: ${JSON.stringify({ type: 'broadcast_start', sessionId: id })}\n\n`);
        if (session.paused) res.write(`data: ${JSON.stringify({ type: 'broadcast_paused', sessionId: id })}\n\n`);
    }

    // Keep-Alive: Kirim komentar setiap 15 detik agar koneksi tidak diputus browser/proxy
    const keepAlive = setInterval(() => {
        res.write(': keep-alive\n\n');
    }, 15000);

    clients.push(res);

    req.on('close', () => {
        clearInterval(keepAlive);
        clients = clients.filter(client => client !== res);
    });
});

function sendEvent(data) {
    // Kirim ke semua browser yang terhubung
    clients.forEach(client => client.write(`data: ${JSON.stringify(data)}\n\n`));
}

function broadcastLog(message) {
    console.log(message);
    sendEvent({ type: 'log', message });
}
// ----------------------------------------------------------

// --- Fitur Template Pesan ---
const TEMPLATE_FILE = 'templates.json';

function getTemplates() {
    if (!fs.existsSync(TEMPLATE_FILE)) return [];
    try {
        return JSON.parse(fs.readFileSync(TEMPLATE_FILE));
    } catch (e) {
        return [];
    }
}

function saveTemplates(templates) {
    fs.writeFileSync(TEMPLATE_FILE, JSON.stringify(templates, null, 2));
}

app.get('/templates', (req, res) => {
    res.json(getTemplates());
});

app.post('/templates', (req, res) => {
    const { name, message } = req.body;
    if (!name || !message) return res.status(400).json({ status: 'error', message: 'Nama dan pesan harus diisi' });
    
    const templates = getTemplates();
    const index = templates.findIndex(t => t.name === name);
    if (index >= 0) {
        templates[index].message = message; // Update jika nama sama
    } else {
        templates.push({ name, message });
    }
    
    saveTemplates(templates);
    res.json({ status: 'success', message: 'Template berhasil disimpan' });
});

app.delete('/templates/:name', (req, res) => {
    const name = req.params.name;
    let templates = getTemplates();
    const newTemplates = templates.filter(t => t.name !== name);
    saveTemplates(newTemplates);
    res.json({ status: 'success', message: 'Template berhasil dihapus' });
});
// ----------------------------

// --- Fitur Label / Grup Kontak ---
const LABELS_FILE = 'labels.json';

function getLabels() {
    if (!fs.existsSync(LABELS_FILE)) return [];
    try {
        return JSON.parse(fs.readFileSync(LABELS_FILE));
    } catch (e) {
        return [];
    }
}

function saveLabels(labels) {
    fs.writeFileSync(LABELS_FILE, JSON.stringify(labels, null, 2));
}

app.get('/labels', (req, res) => {
    const labels = getLabels().map(l => ({ name: l.name, count: l.numbers.length }));
    res.json({ status: 'success', labels });
});

app.get('/labels/:name', (req, res) => {
    const name = req.params.name;
    const labels = getLabels();
    const label = labels.find(l => l.name === name);
    if (label) {
        res.json({ status: 'success', numbers: label.numbers });
    } else {
        res.status(404).json({ status: 'error', message: 'Label tidak ditemukan' });
    }
});

app.post('/labels', (req, res) => {
    const { name, numbers } = req.body;
    if (!name || !numbers || !Array.isArray(numbers)) return res.status(400).json({ status: 'error', message: 'Data tidak valid' });
    
    const labels = getLabels();
    const index = labels.findIndex(l => l.name === name);
    const cleanNumbers = numbers.filter(n => typeof n === 'string' && n.trim().length > 0);

    if (index >= 0) {
        labels[index].numbers = cleanNumbers; // Update jika ada
    } else {
        labels.push({ name, numbers: cleanNumbers });
    }
    
    saveLabels(labels);
    res.json({ status: 'success', message: 'Label berhasil disimpan' });
});

app.delete('/labels/:name', (req, res) => {
    const name = req.params.name;
    let labels = getLabels();
    const newLabels = labels.filter(l => l.name !== name);
    saveLabels(newLabels);
    res.json({ status: 'success', message: 'Label berhasil dihapus' });
});
// ---------------------------------

// --- Session Endpoints ---
app.get('/sessions', (req, res) => {
    const list = [];
    for (const [id, session] of sessions) {
        list.push({
            id: id,
            ready: session.ready,
            info: session.info
        });
    }
    res.json({ status: 'success', sessions: list });
});

app.post('/sessions/add', (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ status: 'error', message: 'ID Sesi harus diisi' });
    if (sessions.has(id)) return res.status(400).json({ status: 'error', message: 'Sesi sudah ada' });
    
    startSession(id);
    res.json({ status: 'success', message: 'Sesi dibuat' });
});

app.post('/sessions/delete', async (req, res) => {
    const { id } = req.body;
    const session = sessions.get(id);
    if (session) {
        await session.client.destroy();
        sessions.delete(id);
        res.json({ status: 'success', message: 'Sesi dihapus' });
    } else {
        res.status(404).json({ status: 'error', message: 'Sesi tidak ditemukan' });
    }
});

// Endpoint untuk menghentikan broadcast
app.post('/stop', (req, res) => {
    const session = sessions.get(req.body.sessionId);
    if (session) session.shouldStop = true; // Tambahkan properti shouldStop ke objek session
    res.json({ status: 'success', message: 'Permintaan berhenti diterima. Broadcast akan berhenti setelah pesan saat ini.' });
});

// Endpoint untuk logout
app.post('/logout', async (req, res) => {
    const session = sessions.get(req.body.sessionId);
    if (!session) return res.status(404).json({ status: 'error', message: 'Sesi tidak ditemukan' });
    
    // Update status sesi segera agar UI merespon saat reload
    session.ready = false;
    session.info = null;
    session.qr = null;
    session.isLoading = true;

    try {
        await session.client.logout();
        res.json({ status: 'success', message: 'Berhasil logout. Silakan tunggu QR Code muncul kembali.' });
    } catch (error) {
        console.error('Logout error, forcing restart:', error);
        try { await session.client.destroy(); } catch (e) {}
        session.client.initialize(); // Restart manual jika logout gagal
        res.json({ status: 'success', message: 'Logout berhasil (dipaksa).' });
    }
});

// Endpoint untuk Jeda (Pause)
app.post('/pause', (req, res) => {
    const session = sessions.get(req.body.sessionId);
    if (session && session.broadcasting && !session.paused) {
        session.paused = true;
        broadcastLog('⏸️ Broadcast dijeda sementara.');
        sendEvent({ type: 'broadcast_paused', sessionId: session.id });
        res.json({ status: 'success', message: 'Broadcast dijeda.' });
    } else {
        res.status(400).json({ status: 'error', message: 'Tidak bisa jeda saat ini.' });
    }
});

// Endpoint untuk Lanjut (Resume)
app.post('/resume', (req, res) => {
    const session = sessions.get(req.body.sessionId);
    if (session && session.broadcasting && session.paused) {
        session.paused = false;
        broadcastLog('▶️ Broadcast dilanjutkan.');
        sendEvent({ type: 'broadcast_resumed', sessionId: session.id });
        res.json({ status: 'success', message: 'Broadcast dilanjutkan.' });
    } else {
        res.status(400).json({ status: 'error', message: 'Tidak bisa lanjut saat ini.' });
    }
});

// Endpoint untuk download laporan broadcast terakhir
app.get('/export-report', (req, res) => {
    const session = sessions.get(req.query.sessionId);
    const broadcastReport = session ? session.report : [];
    if (!broadcastReport || broadcastReport.length === 0) {
        return res.status(404).send('Belum ada data laporan broadcast.');
    }
    
    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet(broadcastReport);
    xlsx.utils.book_append_sheet(wb, ws, "Laporan Whatsapp Tool");
    
    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="Laporan_Whatsapp_Tool.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
});

// Endpoint untuk menghentikan pengecekan nomor
app.post('/stop-check-numbers', (req, res) => {
    const session = sessions.get(req.body.sessionId);
    if (session) session.shouldStopCheck = true;
    res.json({ status: 'success', message: 'Permintaan berhenti diterima.' });
});

// Endpoint untuk Cek Nomor (Validasi)
app.post('/check-numbers', upload.fields([{ name: 'excel', maxCount: 1 }]), async (req, res) => {
    const { numbers, sessionId } = req.body;
    const session = sessions.get(sessionId);
    if (!session || !session.ready) return res.status(400).json({ status: 'error', message: 'Sesi tidak siap' });

    if (session.isChecking) return res.status(400).json({ status: 'error', message: 'Sedang melakukan pemeriksaan.' });
    session.isChecking = true;
    session.shouldStopCheck = false;

    const excelFile = req.files && req.files['excel'] ? req.files['excel'][0] : null;

    let combinedNumbers = [];
    
    if (numbers) {
        combinedNumbers = numbers.split('\n').map(n => n.trim()).filter(n => n);
    }

    if (excelFile) {
        try {
            const workbook = xlsx.read(excelFile.buffer, { type: 'buffer' });
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });

            data.forEach(row => {
                if (row[0]) {
                    let num = String(row[0]).replace(/[^0-9]/g, '');
                    if (num.startsWith('0')) num = '62' + num.slice(1);
                    const name = row[1] ? String(row[1]).trim() : '';
                    if (num.length > 5) combinedNumbers.push(`${num},${name}`);
                }
            });
        } catch (e) {
            return res.status(400).json({ status: 'error', message: 'Gagal membaca file Excel.' });
        }
    }

    if (combinedNumbers.length === 0) {
        session.isChecking = false;
        return res.status(400).json({ status: 'error', message: 'Tidak ada nomor untuk diperiksa.' });
    }

    let valid = 0;
    let invalid = 0;
    let invalidList = [];
    let processed = 0;
    const total = combinedNumbers.length;

    for (const line of combinedNumbers) {
        if (session.shouldStopCheck) {
            broadcastLog(`[${sessionId}] 🛑 Pemeriksaan nomor dihentikan paksa.`);
            break;
        }

        processed++;
        const [rawNumber] = line.split(',');

        // Support Cek ID Grup
        if (rawNumber.includes('@g.us')) {
            valid++;
            sendEvent({
                type: 'check_progress',
                sessionId: sessionId,
                data: { processed, total, current: rawNumber + ' (Grup)' }
            });
            await new Promise(r => setTimeout(r, 50)); // Delay kecil untuk grup
            continue;
        }

        let sanitized = rawNumber.replace(/\D/g, '');
        if (sanitized.startsWith('0')) sanitized = '62' + sanitized.slice(1);
        
        // Kirim event progress ke UI
        sendEvent({
            type: 'check_progress',
            sessionId: sessionId,
            data: { processed, total, current: rawNumber }
        });

        try {
            const registered = await session.client.getNumberId(sanitized);
            if (registered) {
                valid++;
            } else {
                invalid++;
                invalidList.push(rawNumber);
            }
        } catch (e) {
            invalid++;
            invalidList.push(rawNumber);
        }
        // Beri jeda sedikit agar tidak dianggap spamming request check
        await new Promise(r => setTimeout(r, 200));
    }

    session.isChecking = false;
    res.json({ status: 'success', valid, invalid, invalidList });
});

// --- API Live Chat ---

// Ambil daftar chat (terurut dari terbaru)
app.get('/api/chats', async (req, res) => {
    const session = sessions.get(req.query.sessionId);
    if (!session || !session.ready) return res.status(400).json({ status: 'error', message: 'Client belum siap.' });

    try {
        const chats = await session.client.getChats();
        const formatted = chats.map(c => ({
            id: c.id._serialized,
            name: c.name || c.id.user,
            number: c.id.user,
            unreadCount: c.unreadCount,
            timestamp: c.timestamp,
            isGroup: c.isGroup,
            lastMessage: c.lastMessage ? c.lastMessage.body : ''
        })).sort((a, b) => b.timestamp - a.timestamp);
        
        res.json({ status: 'success', chats: formatted });
    } catch (e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// Ambil pesan dari chat tertentu
app.get('/api/chats/:id/messages', async (req, res) => {
    const session = sessions.get(req.query.sessionId);
    if (!session || !session.ready) return res.status(400).json({ status: 'error', message: 'Client belum siap.' });

    try {
        const chat = await session.client.getChatById(req.params.id);
        const messages = await chat.fetchMessages({ limit: 50 }); // Ambil 50 pesan terakhir
        
        const formatted = await Promise.all(messages.map(async m => {
            let senderName = null;
            if (!m.fromMe && chat.isGroup) {
                const authorId = m.author || m.from;
                try {
                    const contact = await session.client.getContactById(authorId);
                    senderName = contact.name || contact.pushname || contact.number;
                } catch (e) {
                    senderName = m._data.notifyName || authorId.split('@')[0];
                }
            }
            return {
                id: m.id._serialized,
                from: m.from,
                to: m.to,
                author: m.author,
                senderName: senderName,
                body: m.body,
                timestamp: m.timestamp,
                fromMe: m.fromMe,
                hasMedia: m.hasMedia,
                type: m.type
            };
        }));
        res.json({ status: 'success', messages: formatted });
    } catch (e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// Kirim pesan balasan
app.post('/api/chats/:id/send', async (req, res) => {
    const { message, sessionId, quotedMessageId } = req.body;
    const session = sessions.get(sessionId);
    if (!session || !session.ready) return res.status(400).json({ status: 'error', message: 'Client belum siap.' });

    try {
        const options = {};
        if (quotedMessageId) options.quotedMessageId = quotedMessageId;
        await session.client.sendMessage(req.params.id, message, options);
        res.json({ status: 'success' });
    } catch (e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// Kirim media (gambar/file) dari live chat
app.post('/api/chats/:id/send-media', upload.single('file'), async (req, res) => {
    const { sessionId, caption, quotedMessageId } = req.body;
    const session = sessions.get(sessionId);
    if (!session || !session.ready) return res.status(400).json({ status: 'error', message: 'Client belum siap.' });

    if (!req.file) return res.status(400).json({ status: 'error', message: 'File tidak ditemukan.' });

    try {
        const media = new MessageMedia(req.file.mimetype, req.file.buffer.toString('base64'), req.file.originalname);
        const options = {};
        if (caption) options.caption = caption;
        if (quotedMessageId) options.quotedMessageId = quotedMessageId;
        
        await session.client.sendMessage(req.params.id, media, options);
        res.json({ status: 'success' });
    } catch (e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// Endpoint untuk Mark as Read (Centang Biru)
app.post('/api/chats/:id/mark-read', async (req, res) => {
    const { sessionId } = req.body;
    const session = sessions.get(sessionId);
    if (!session || !session.ready) return res.status(400).json({ status: 'error', message: 'Client belum siap.' });

    try {
        const chat = await session.client.getChatById(req.params.id);
        await chat.sendSeen();
        res.json({ status: 'success' });
    } catch (e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// Endpoint untuk Mengirim Status Mengetik (Typing...)
app.post('/api/chats/:id/state', async (req, res) => {
    const { sessionId, state } = req.body; // state: 'typing' | 'recording' | 'clear'
    const session = sessions.get(sessionId);
    if (!session || !session.ready) return res.status(400).json({ status: 'error', message: 'Client belum siap.' });

    try {
        const chat = await session.client.getChatById(req.params.id);
        if (state === 'typing') await chat.sendStateTyping();
        else if (state === 'recording') await chat.sendStateRecording();
        else await chat.clearState();
        res.json({ status: 'success' });
    } catch (e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// Endpoint untuk Cek Status Online (Presence)
app.get('/api/chats/:id/presence', async (req, res) => {
    const session = sessions.get(req.query.sessionId);
    if (!session || !session.ready) return res.status(400).json({ status: 'error', message: 'Client belum siap.' });

    try {
        const presence = await session.client.pupPage.evaluate((chatId) => {
            try {
                const wid = window.Store.WidFactory.createWid(chatId);
                const p = window.Store.Presence.get(wid);
                if (!p) return { isOnline: false };
                return {
                    isOnline: p.isOnline === true,
                    isTyping: p.chatstate && p.chatstate.type === 'typing',
                    isRecording: p.chatstate && p.chatstate.type === 'recording'
                };
            } catch (e) {
                return { isOnline: false };
            }
        }, req.params.id);
        
        res.json({ status: 'success', presence });
    } catch (e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// Endpoint untuk Mengambil Media Pesan (Gambar/Sticker)
app.get('/api/messages/:id/media', async (req, res) => {
    const { sessionId } = req.query;
    const session = sessions.get(sessionId);
    if (!session || !session.ready) return res.status(400).send('Session not ready');

    try {
        const msg = await session.client.getMessageById(req.params.id);
        if (!msg) return res.status(404).send('Message not found');
        
        if (msg.hasMedia) {
            const media = await msg.downloadMedia();
            if (media) {
                const buffer = Buffer.from(media.data, 'base64');
                res.setHeader('Content-Type', media.mimetype);
                res.send(buffer);
                return;
            }
        }
        res.status(404).send('No media found');
    } catch (e) {
        console.error('Error downloading media:', e);
        res.status(500).send('Error downloading media');
    }
});

// Endpoint untuk Menghapus Pesan
app.post('/api/messages/:id/delete', async (req, res) => {
    const { sessionId, everyone } = req.body;
    const session = sessions.get(sessionId);
    if (!session || !session.ready) return res.status(400).json({ status: 'error', message: 'Client belum siap.' });

    try {
        const msg = await session.client.getMessageById(req.params.id);
        if (!msg) return res.status(404).json({ status: 'error', message: 'Pesan tidak ditemukan.' });
        
        await msg.delete(everyone === undefined ? true : everyone);
        res.json({ status: 'success' });
    } catch (e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// Endpoint untuk Edit Pesan
app.post('/api/messages/:id/edit', async (req, res) => {
    const { sessionId, newBody } = req.body;
    const session = sessions.get(sessionId);
    if (!session || !session.ready) return res.status(400).json({ status: 'error', message: 'Client belum siap.' });

    try {
        const msg = await session.client.getMessageById(req.params.id);
        if (!msg) return res.status(404).json({ status: 'error', message: 'Pesan tidak ditemukan.' });
        
        await msg.edit(newBody);
        res.json({ status: 'success' });
    } catch (e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// Endpoint untuk Forward Pesan
app.post('/api/messages/:id/forward', async (req, res) => {
    const { sessionId, targetChatId } = req.body;
    const session = sessions.get(sessionId);
    if (!session || !session.ready) return res.status(400).json({ status: 'error', message: 'Client belum siap.' });

    try {
        const msg = await session.client.getMessageById(req.params.id);
        if (!msg) return res.status(404).json({ status: 'error', message: 'Pesan tidak ditemukan.' });
        
        const targetChat = await session.client.getChatById(targetChatId);
        await msg.forward(targetChat);
        res.json({ status: 'success' });
    } catch (e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// Endpoint untuk Mengelola Settings (Webhook)
app.get('/settings', (req, res) => {
    res.json(appSettings);
});

app.post('/settings', (req, res) => {
    const { webhookUrl, aiEnabled, aiSystemPrompt, aiAllowedTopics, welcomeMessage, aiBlacklist, aiIgnoreGroups, autoRejectCall, arIgnoreGroups, aiDailyLimit } = req.body;
    if (webhookUrl !== undefined) appSettings.webhookUrl = webhookUrl;
    if (aiEnabled !== undefined) appSettings.aiEnabled = aiEnabled;
    if (aiSystemPrompt !== undefined) appSettings.aiSystemPrompt = aiSystemPrompt;
    if (aiAllowedTopics !== undefined) appSettings.aiAllowedTopics = aiAllowedTopics;
    if (welcomeMessage !== undefined) appSettings.welcomeMessage = welcomeMessage;
    if (aiBlacklist !== undefined) appSettings.aiBlacklist = aiBlacklist;
    if (aiIgnoreGroups !== undefined) appSettings.aiIgnoreGroups = aiIgnoreGroups;
    if (arIgnoreGroups !== undefined) appSettings.arIgnoreGroups = arIgnoreGroups;
    if (autoRejectCall !== undefined) appSettings.autoRejectCall = autoRejectCall;
    if (aiDailyLimit !== undefined) appSettings.aiDailyLimit = parseInt(aiDailyLimit) || 0;
    saveSettings();
    res.json({ status: 'success', message: 'Pengaturan disimpan.' });
});

// Endpoint API untuk Mengirim Pesan dari Luar (Incoming Webhook)
app.post('/api/send-message', async (req, res) => {
    const { number, message, sessionId } = req.body;
    const session = sessions.get(sessionId || 'session1'); // Default session1

    if (!number || !message || !session) {
        return res.status(400).json({ status: 'error', message: 'Parameter number dan message wajib diisi.' });
    }

    if (!session.ready) {
        return res.status(503).json({ status: 'error', message: 'WhatsApp Client belum siap.' });
    }

    try {
        const chatId = number.replace(/\D/g, '') + '@c.us';
        await session.client.sendMessage(chatId, message);
        res.json({ status: 'success', message: 'Pesan terkirim ke antrian WhatsApp.' });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Endpoint untuk mendapatkan daftar grup
app.get('/groups', async (req, res) => {
    const session = sessions.get(req.query.sessionId);
    if (!session || !session.ready) return res.status(400).json({ status: 'error', message: 'Client belum siap.' });
    
    try {
        const chats = await session.client.getChats();
        const groups = chats.filter(chat => chat.isGroup).map(chat => ({
            id: chat.id._serialized,
            name: chat.name
        }));
        res.json({ status: 'success', groups });
    } catch (e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// Endpoint untuk mendapatkan anggota grup
app.get('/groups/:id/members', async (req, res) => {
    const session = sessions.get(req.query.sessionId);
    if (!session || !session.ready) return res.status(400).json({ status: 'error', message: 'Client belum siap.' });
    try {
        const chatId = req.params.id;
        const chat = await session.client.getChatById(chatId);
        
        if (!chat.isGroup) {
            return res.status(400).json({ status: 'error', message: 'Chat bukan grup.' });
        }

        const members = [];
        // Loop participants
        for (const participant of chat.participants) {
            // Kita coba ambil info kontak untuk nama
            try {
                const contact = await session.client.getContactById(participant.id._serialized);
                members.push({
                    number: participant.id.user,
                    name: contact.pushname || contact.name || '' // Prioritas pushname (nama WA)
                });
            } catch (err) {
                // Fallback jika gagal ambil kontak
                members.push({
                    number: participant.id.user,
                    name: ''
                });
            }
        }
        res.json({ status: 'success', members });
    } catch (e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// Endpoint untuk mendapatkan list chat aktif (Riwayat Chat)
app.get('/chats', async (req, res) => {
    const session = sessions.get(req.query.sessionId);
    if (!session || !session.ready) return res.status(400).json({ status: 'error', message: 'Client belum siap.' });
    try {
        const chats = await session.client.getChats();
        // Filter: bukan grup, id server c.us
        const chatList = chats
            .filter(c => !c.isGroup && c.id.server === 'c.us')
            .map(c => ({
                number: c.id.user,
                name: c.name || c.pushname || ''
            }));
        res.json({ status: 'success', chats: chatList });
    } catch (e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// Endpoint untuk mendapatkan kontak yang tersimpan (My Contacts)
app.get('/contacts', async (req, res) => {
    const session = sessions.get(req.query.sessionId);
    if (!session || !session.ready) return res.status(400).json({ status: 'error', message: 'Client belum siap.' });
    try {
        const contacts = await session.client.getContacts();
        // Filter: isMyContact = true, dan bukan grup/status (id.server = 'c.us')
        const myContacts = contacts
            .filter(c => c.isMyContact && c.id.server === 'c.us')
            .map(c => ({
                id: c.id._serialized,
                number: c.id.user,
                name: c.name || c.pushname || '' // Prioritas nama di HP (name), lalu pushname
            }));
        res.json({ status: 'success', contacts: myContacts });
    } catch (e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// Endpoint untuk mendapatkan opsi blacklist (Grup & Chat Personal)
app.get('/blacklist-options', async (req, res) => {
    const session = sessions.get(req.query.sessionId);
    if (!session || !session.ready) return res.status(400).json({ status: 'error', message: 'Client belum siap.' });
    
    try {
        const chats = await session.client.getChats();
        const options = chats.map(chat => ({
            id: chat.id._serialized,
            name: chat.name || chat.pushname || chat.id.user,
            type: chat.isGroup ? 'group' : 'user'
        }));
        
        res.json({ status: 'success', options });
    } catch (e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// Endpoint untuk Generate Caption AI
app.post('/generate-caption', async (req, res) => {
    const { product, price, promo, tone } = req.body;
    
    if (!product) return res.status(400).json({ status: 'error', message: 'Nama produk wajib diisi.' });

    try {
        const systemPrompt = "Kamu adalah copywriter ahli untuk marketing WhatsApp. Buatlah pesan promosi yang menarik, singkat, dan persuasif menggunakan emoji. Gunakan Bahasa Indonesia. Format pesan agar mudah dibaca di WhatsApp (gunakan bold *text*, bullet points, dll).";
        const userPrompt = `Buatkan caption promosi untuk produk: ${product}. \nHarga: ${price || 'Tidak disebutkan'}. \nDetail Promo/Keunggulan: ${promo || '-'}. \nGaya Bahasa: ${tone || 'Ramah dan Seru'}.`;

        const response = await axios.post('https://text.pollinations.ai/', {
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            model: 'openai',
            seed: Math.floor(Math.random() * 1000)
        }, { headers: { 'Content-Type': 'application/json' } });

        res.json({ status: 'success', caption: response.data });
    } catch (e) {
        console.error('AI Gen Error:', e.message);
        res.status(500).json({ status: 'error', message: 'Gagal menghubungi AI.' });
    }
});

// Endpoint untuk Preview Pesan (Spintax & Personalisasi)
app.post('/preview-message', (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ status: 'error', message: 'Pesan kosong' });

    let processed = message.replace(/{name}/gi, 'Budi'); // Simulasi nama
    processed = parseSpintax(processed);

    res.json({ status: 'success', preview: processed });
});

// Endpoint untuk download template Excel
app.get('/download-template', (req, res) => {
    const wb = xlsx.utils.book_new();
    const ws_data = [
        ["Nomor", "Nama"],
        ["628123456789", "Contoh Budi"],
        ["081234567890", "Contoh Siti"]
    ];
    const ws = xlsx.utils.aoa_to_sheet(ws_data);
    xlsx.utils.book_append_sheet(wb, ws, "Template");
    
    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="Template_Broadcast.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
});

// Endpoint Helper: Parse & Clean Excel Data
app.post('/parse-excel', upload.single('excel'), (req, res) => {
    if (!req.file) return res.status(400).json({ status: 'error', message: 'File tidak ditemukan' });

    try {
        const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });
        
        const cleanedData = [];
        data.forEach(row => {
            // Row[0] = Nomor, Row[1] = Nama. Abaikan jika Row[0] kosong.
            if (row && row.length > 0 && row[0]) {
                let rawNum = String(row[0]).replace(/[^0-9]/g, ''); // Hapus simbol
                if (rawNum.startsWith('0')) rawNum = '62' + rawNum.slice(1);
                const name = row[1] ? String(row[1]).trim() : '';
                
                // Hanya masukkan jika nomor valid (misal > 5 digit)
                if (rawNum.length > 5) {
                    cleanedData.push(`${rawNum},${name}`);
                }
            }
        });
        
        res.json({ status: 'success', data: cleanedData, count: cleanedData.length });
    } catch (e) {
        console.error('Parse Excel Error:', e);
        res.status(500).json({ status: 'error', message: 'Gagal memproses file Excel.' });
    }
});

// Endpoint untuk menerima request broadcast dari HTML
app.post('/broadcast', upload.fields([{ name: 'attachment', maxCount: 1 }, { name: 'excel', maxCount: 1 }]), async (req, res) => {
    const { numbers, message, schedule, minDelay, maxDelay, batchSize, batchDelay, shuffle, latitude, longitude, footer, simulateTyping, sendAsPtt, sessionId } = req.body;
    const session = sessions.get(sessionId);

    if (!session || session.broadcasting) {
        return res.status(400).json({ status: 'error', message: 'Broadcast sedang berjalan!' });
    }

    session.shouldStop = false;
    session.paused = false;
    session.report = []; // Reset laporan lama
    
    // Ambil file dari req.files karena menggunakan upload.fields
    const attachmentFile = req.files && req.files['attachment'] ? req.files['attachment'][0] : null;
    const excelFile = req.files && req.files['excel'] ? req.files['excel'][0] : null;

    // Gabungkan nomor dari input manual dan Excel
    let combinedNumbers = [];
    
    if (numbers) {
        combinedNumbers = numbers.split('\n').map(n => n.trim()).filter(n => n);
    }

    if (excelFile) {
        try {
            const workbook = xlsx.read(excelFile.buffer, { type: 'buffer' });
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            const data = xlsx.utils.sheet_to_json(sheet, { header: 1 }); // Baca sebagai array baris

            data.forEach(row => {
                // Asumsi: Kolom A (indeks 0) = Nomor, Kolom B (indeks 1) = Nama (Opsional)
                if (row[0]) {
                    let num = String(row[0]).replace(/[^0-9]/g, ''); // Ambil angka saja
                    if (num.startsWith('0')) num = '62' + num.slice(1);
                    const name = row[1] ? String(row[1]).trim() : '';
                    if (num.length > 5) combinedNumbers.push(`${num},${name}`);
                }
            });
        } catch (e) {
            console.error('Error parsing Excel:', e);
            return res.status(400).json({ status: 'error', message: 'Gagal membaca file Excel.' });
        }
    }

    // Validasi: Harus ada nomor, dan harus ada konten (Pesan Teks ATAU File ATAU Lokasi)
    if (combinedNumbers.length === 0 || (!message && !attachmentFile && (!latitude || !longitude))) {
        return res.status(400).json({ status: 'error', message: 'Nomor dan konten pesan (Teks/File/Lokasi) harus diisi!' });
    }

    // Logika Shuffle (Acak Urutan)
    if (shuffle === 'true') {
        for (let i = combinedNumbers.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [combinedNumbers[i], combinedNumbers[j]] = [combinedNumbers[j], combinedNumbers[i]];
        }
        broadcastLog(`🔀 Urutan pengiriman diacak (${combinedNumbers.length} nomor).`);
    }

    // Hitung delay jadwal (jika ada)
    let startDelayMs = 0;
    if (schedule) {
        const targetDate = new Date(schedule);
        const now = new Date();
        startDelayMs = targetDate - now;
    }

    // Kirim respon segera agar browser tidak timeout
    const statusMsg = startDelayMs > 0 
        ? `Broadcast dijadwalkan berjalan dalam ${Math.round(startDelayMs/1000)} detik.` 
        : 'Broadcast sedang diproses di latar belakang.';

    res.json({ status: 'success', message: statusMsg });

    // Set status broadcasting dan kirim event ke UI
    session.broadcasting = true;
    session.startTime = Date.now() + startDelayMs; // Estimasi waktu mulai
    sendEvent({ type: 'broadcast_start', sessionId: sessionId });

    const runBroadcast = async () => {
        session.startTime = Date.now(); // Waktu mulai aktual saat loop berjalan
        const numberList = combinedNumbers;
        
        // Konfigurasi Anti-Banned
        const minD = parseInt(minDelay) || 5;
        const maxD = parseInt(maxDelay) || 10;
        const bSize = parseInt(batchSize) || 0;
        const bDelay = parseInt(batchDelay) || 60;

        broadcastLog(`Memulai broadcast ke ${numberList.length} nomor...`);

        let sentCount = 0;
        let failCount = 0;

        for (const line of numberList) {
            if (session.shouldStop) {
                broadcastLog('⛔ Broadcast dihentikan paksa oleh pengguna.');
                break;
            }

            // Logika Pause: Tunggu di sini jika isPaused = true
            while (session.paused) {
                if (session.shouldStop) break; // Tetap izinkan stop saat sedang pause
                await new Promise(resolve => setTimeout(resolve, 1000)); // Cek setiap 1 detik
            }
            if (session.shouldStop) {
                broadcastLog('⛔ Broadcast dihentikan paksa oleh pengguna.');
                break;
            }

            // Logika Batching (Istirahat Panjang)
            if (bSize > 0 && sentCount > 0 && sentCount % bSize === 0) {
                broadcastLog(`⏸️ Anti-Ban: Istirahat sejenak selama ${bDelay} detik...`);
                await new Promise(resolve => setTimeout(resolve, bDelay * 1000));
            }

            try {
                // Pisahkan nomor dan nama (format: nomor,nama)
                const [rawNumber, name] = line.split(',');
                let chatId;
                const recipientName = name ? name.trim() : '';

                // LOGIKA BARU: Support Broadcast ke Grup
                if (rawNumber.includes('@g.us')) {
                    chatId = rawNumber.trim();
                } else {
                    // Logika Lama: Broadcast ke Nomor Personal
                    let sanitizedNumber = rawNumber.replace(/\D/g, '');
                    if (sanitizedNumber.startsWith('0')) sanitizedNumber = '62' + sanitizedNumber.slice(1);
                    
                    const registeredUser = await session.client.getNumberId(sanitizedNumber);
                    if (!registeredUser) {
                        broadcastLog(`Gagal: Nomor tidak terdaftar di WhatsApp (${rawNumber})`);
                        failCount++;
                        sendEvent({ type: 'progress', sessionId: sessionId, data: { success: sentCount, failed: failCount, total: numberList.length, startTime: session.startTime } });
                        session.report.push({ Nomor: rawNumber, Nama: recipientName, Status: 'GAGAL', Keterangan: 'Nomor tidak terdaftar', Waktu: new Date().toLocaleString() });
                        continue;
                    }
                    chatId = registeredUser._serialized;
                }

                
                // Personalization: Ganti {name} dengan nama penerima
                let personalizedMessage = message.replace(/{name}/gi, recipientName);
                
                // Tambahkan Footer jika ada
                if (footer) {
                    personalizedMessage += '\n\n' + footer;
                }

                // Proses pesan dengan Spintax agar unik untuk setiap nomor
                const finalMessage = parseSpintax(personalizedMessage);

                // Simulasi mengetik seperti manusia
                if (simulateTyping === 'true') {
                    try {
                        const chat = await session.client.getChatById(chatId);
                        // Hitung durasi ketik: ~100ms per karakter + variasi acak, min 2 detik, max 10 detik
                        const typingDuration = Math.min(Math.max(finalMessage.length * 100, 2000), 10000); 
                        
                        broadcastLog(`⌨️ Mengetik ke ${rawNumber}... (${(typingDuration/1000).toFixed(1)}s)`);
                        await chat.sendStateTyping();
                        await new Promise(resolve => setTimeout(resolve, typingDuration));
                        await chat.clearState();
                    } catch (e) {
                        // Abaikan error jika gagal simulasi mengetik
                    }
                }

                if (latitude && longitude) {
                    // Jika ada koordinat, kirim Lokasi (Pesan teks jadi deskripsi)
                    const loc = new Location(parseFloat(latitude), parseFloat(longitude), finalMessage || undefined);
                    await session.client.sendMessage(chatId, loc);
                } else if (attachmentFile) {
                    // Jika ada file (gambar/dokumen), buat objek MessageMedia dan kirim dengan caption
                    const media = new MessageMedia(attachmentFile.mimetype, attachmentFile.buffer.toString('base64'), attachmentFile.originalname);
                    
                    let options = { caption: finalMessage };
                    // Fitur PTT (Voice Note)
                    if (sendAsPtt === 'true' && attachmentFile.mimetype.startsWith('audio/')) {
                        options.sendAudioAsVoice = true;
                    }
                    await session.client.sendMessage(chatId, media, options);
                } else {
                    // Jika tidak ada gambar, kirim pesan teks biasa
                    await session.client.sendMessage(chatId, finalMessage);
                }
                
                broadcastLog(`Sukses kirim ke: ${chatId}`);
                sentCount++;
                sendEvent({ type: 'progress', sessionId: sessionId, data: { success: sentCount, failed: failCount, total: numberList.length, startTime: session.startTime } });
                session.report.push({ Nomor: rawNumber, Nama: recipientName, Status: 'BERHASIL', Keterangan: 'Terkirim', Waktu: new Date().toLocaleString() });
                
                // Random Delay (Anti-Ban)
                const randomDelay = Math.floor(Math.random() * (maxD - minD + 1)) + minD;
                broadcastLog(`⏳ Menunggu ${randomDelay} detik...`);
                await new Promise(resolve => setTimeout(resolve, randomDelay * 1000));

            } catch (err) {
                broadcastLog(`Gagal kirim ke ${line}: ${err.message || err}`);
                failCount++;
                sendEvent({ type: 'progress', sessionId: sessionId, data: { success: sentCount, failed: failCount, total: numberList.length, startTime: session.startTime } });
                session.report.push({ Nomor: line, Nama: '', Status: 'GAGAL', Keterangan: err.message || 'Error', Waktu: new Date().toLocaleString() });
                // Tetap delay meskipun gagal agar tidak spamming error
                const randomDelay = Math.floor(Math.random() * (maxD - minD + 1)) + minD;
                await new Promise(resolve => setTimeout(resolve, randomDelay * 1000));
            }
        }
        
        session.broadcasting = false;
        session.paused = false;
        broadcastLog('Broadcast selesai.');
        sendEvent({ type: 'broadcast_end', sessionId: sessionId });
    };

    if (startDelayMs > 0) {
        broadcastLog(`Menunggu jadwal broadcast... (${Math.round(startDelayMs/1000)} detik)`);
        setTimeout(runBroadcast, startDelayMs);
    } else {
        runBroadcast();
    }
});

app.listen(port, () => {
    // Mendapatkan IP Address Lokal (LAN)
    const interfaces = os.networkInterfaces();
    let networkIp = 'localhost';
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                networkIp = iface.address;
            }
        }
    }

    console.log(`\n✅ Whatsapp Tool Berjalan!`);
    console.log(`   - Di Komputer ini : http://localhost:${port}`);
    console.log(`   - Dari HP/PC lain : http://${networkIp}:${port}\n`);
});
