const express = require('express');
const router = express.Router(); 
const axios = require('axios');
const NodeCache = require('node-cache');
const ejs = require('ejs');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

// استخدام Keep-Alive
const axiosInstance = axios.create({
    httpAgent: new http.Agent({ keepAlive: true }),
    httpsAgent: new https.Agent({ keepAlive: true })
});

// إعدادات الكاش
const matchesCache = new NodeCache({ stdTTL: 60 });
const serverCache = new NodeCache({ stdTTL: 3600 });
const tokenCache = new NodeCache({ stdTTL: 14400, checkperiod: 600 });
const m3u8Cache = new NodeCache({ stdTTL: 2 });
const activeM3u8Requests = new Map(); 

// ميدل وير خاص فقط بهذا الموجه لفرض السماح بتضمين iframe
router.use((req, res, next) => {
    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Security-Policy', "frame-ancestors *");
    next();
});

const encodeId = (id) => Buffer.from(id).toString('base64');
const decodeId = (encoded) => Buffer.from(encoded, 'base64').toString('utf-8');

const getClientIp = (req) => {
    const forwarded = req.headers['x-forwarded-for'];
    return forwarded ? forwarded.split(',')[0].trim() : req.socket.remoteAddress;
};

const generateSecureToken = (ip) => {
    const token = crypto.randomBytes(16).toString('hex');
    tokenCache.set(token, ip);
    return token;
};

async function fetchWithFallback(path) {
    try {
        return await axiosInstance.get(`https://api.kirozozo.xyz${path}`, { timeout: 8000 });
    } catch (error) {
        console.log(`Primary API failed for ${path}, trying fallback...`);
        return await axiosInstance.get(`https://ytv-42qp.onrender.com${path}`, { timeout: 8000 });
    }
}

// === نظام حماية الستريم الصارم ===
const verifyStreamAccess = (req, res, next) => {
    const { tk } = req.query;
    const clientIp = getClientIp(req);
    const cachedIp = tokenCache.get(tk);
    
    // 1. فحص صحة التوكن وارتباطه بالـ IP
    if (!tk || !cachedIp || cachedIp !== clientIp) {
        return res.status(403).send("Access Denied. Invalid or stolen token.");
    }

    const referer = req.headers.referer || req.headers.origin || '';
    const host = req.get('host');
    const userAgent = req.headers['user-agent'] || '';

    // 2. حماية الـ Referer الصارمة (لمنع نسخ الرابط وفتحه خارج المشغل)
    const isApple = /iPhone|iPad|iPod|AppleCoreMedia/i.test(userAgent);
    
    // إذا لم يكن هناك Referer (تم لصق الرابط مباشرة) وليس جهاز آيفون، يتم حظره
    if (!referer && !isApple) {
        return res.status(403).send("Direct Access Not Allowed.");
    }

    // إذا كان هناك Referer، يجب أن يكون من نفس سيرفرنا (السماح لـ iframe داخل المواقع الأخرى بالعمل لأن الـ iframe يعتبر السيرفر الخاص بنا هو الـ origin)
    if (referer && !referer.includes(host)) {
        return res.status(403).send("Hotlinking Not Allowed.");
    }

    next();
};

// ==========================================
// 1. مسار الـ API (تصفية المباريات)
// ==========================================
router.get('/', async (req, res) => {
    try {
        let matches = matchesCache.get('all_matches');
        
        if (!matches) {
            const response = await fetchWithFallback('/ytvplus/mach');
            matches = response.data.map(match => {
                const encodedId = encodeId(match.id_live);
                const cleanedMatch = {
                    ...match,
                    player_url: `https://${req.get('host')}${req.baseUrl}/m?v=${encodedId}`
                };
                delete cleanedMatch.id_live;
                delete cleanedMatch.date;
                return cleanedMatch;
            });
            matchesCache.set('all_matches', matches);
        }

        res.json({ status: "success", cached: matchesCache.getTtl('all_matches') > 0, total: matches.length, data: matches });
    } catch (error) {
        res.status(500).json({ status: "error", message: "حدث خطأ أثناء جلب المباريات" });
    }
});

// ==========================================
// 2. واجهة المشغل
// ==========================================
const playerTemplate = `
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title><%= displayTitle %> - بث مباشر</title>
    <link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;800&display=swap" rel="stylesheet">
    <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body, html { height: 100%; width: 100%; background-color: #000; font-family: 'Tajawal', sans-serif; overflow: hidden; display: flex; justify-content: center; align-items: center; }
        .player-container { position: relative; width: 100%; height: 100%; max-width: 1200px; max-height: 800px; background-color: #000; overflow: hidden; cursor: default; user-select: none; -webkit-user-select: none; }
        .loading-overlay { position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.85); backdrop-filter: blur(10px); display: flex; flex-direction: column; justify-content: center; align-items: center; z-index: 25; transition: opacity 0.3s ease; pointer-events: auto; }
        .spinner { width: 50px; height: 50px; border: 4px solid rgba(255, 255, 255, 0.1); border-top: 4px solid #5c4dff; border-radius: 50%; animation: spin 0.8s linear infinite; margin-bottom: 12px; }
        .loading-text { color: #fff; font-size: 15px; font-weight: 500; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .unmute-overlay { position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.4); z-index: 20; display: none; flex-direction: column; justify-content: center; align-items: center; cursor: pointer; backdrop-filter: blur(2px); }
        .unmute-btn { background: rgba(92, 77, 255, 0.9); border-radius: 50%; width: 70px; height: 70px; display: flex; justify-content: center; align-items: center; margin-bottom: 15px; box-shadow: 0 4px 15px rgba(0,0,0,0.5); transition: transform 0.2s; animation: pulse 2s infinite; }
        .unmute-overlay:hover .unmute-btn { transform: scale(1.1); }
        .unmute-text { color: white; font-weight: 700; font-size: 16px; text-shadow: 0 2px 4px rgba(0,0,0,0.8); }
        #video { position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: contain; z-index: 2; }
        .glass-bar { position: absolute; left: 50%; transform: translateX(-50%); z-index: 10; height: 58px; background: rgba(20, 22, 32, 0.78); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); border-radius: 14px; display: flex; align-items: center; justify-content: space-between; padding: 0 24px; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5); border: 1px solid rgba(255, 255, 255, 0.08); transition: opacity 0.4s ease, transform 0.4s ease, display 0.2s ease; }
        .glass-bar.title-bar { width: 95%; max-width: 980px; height: 68px; top: 25px; }
        .glass-bar.controls-bar { width: 86%; max-width: 820px; bottom: 25px; }
        .player-container.hide-ui { cursor: none; }
        .player-container.hide-ui .glass-bar { opacity: 0; pointer-events: none; }
        .player-container.hide-ui .glass-bar.title-bar { transform: translate(-50%, -15px); }
        .player-container.hide-ui .glass-bar.controls-bar { transform: translate(-50%, 15px); }
        .logo-text { color: #ffffff; font-size: 17px; font-weight: 700; text-decoration: none; cursor: pointer; transition: color 0.2s; }
        .logo-text:hover { color: #5c4dff; }
        .video-title { color: #e5e7eb; font-size: 15px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 65%; text-align: right; }
        .left-controls { display: flex; align-items: center; gap: 8px; width: 100px; }
        .live-dot { width: 8px; height: 8px; background-color: #ff3b30; border-radius: 50%; box-shadow: 0 0 8px rgba(255, 59, 48, 0.8); animation: pulse 2s infinite; }
        @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(92, 77, 255, 0.7); } 70% { box-shadow: 0 0 0 15px rgba(92, 77, 255, 0); } 100% { box-shadow: 0 0 0 0 rgba(92, 77, 255, 0); } }
        .live-text { color: #ffffff; font-size: 13px; font-weight: 700; text-transform: uppercase; }
        .center-controls { position: absolute; left: 50%; transform: translateX(-50%); display: flex; justify-content: center; align-items: center; }
        .play-pause-btn { width: 44px; height: 44px; background-color: #5c4dff; border: none; border-radius: 50%; display: flex; justify-content: center; align-items: center; cursor: pointer; transition: transform 0.2s ease, background-color 0.2s; box-shadow: 0 4px 12px rgba(92, 77, 255, 0.4); }
        .play-pause-icon { fill: #ffffff; width: 18px; height: 18px; }
        .right-controls { display: flex; align-items: center; gap: 18px; width: 130px; justify-content: flex-end; }
        .control-icon-btn { background: none; border: none; cursor: pointer; display: flex; justify-content: center; align-items: center; opacity: 0.8; transition: opacity 0.2s, transform 0.2s; }
        .icon-svg { fill: #d1d5db; width: 20px; height: 20px; }
        .server-popup { display: none; position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 90%; max-width: 340px; background: rgba(20, 22, 35, 0.96); backdrop-filter: blur(16px); border-radius: 16px; border: 1px solid rgba(255, 255, 255, 0.12); color: white; z-index: 100; padding: 20px; }
        .popup-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 14px; border-bottom: 1px solid rgba(255, 255, 255, 0.1); padding-bottom: 10px; }
        .popup-title { display: flex; flex-direction: column; }
        .popup-title .en { font-size: 11px; color: #9ca3af; text-transform: uppercase; }
        .popup-title .ar { font-size: 14px; font-weight: 700; margin-top: 2px; }
        .close-server-popup { background: none; border: none; color: #9ca3af; font-size: 20px; cursor: pointer; }
        .server-list { display: flex; flex-direction: column; gap: 6px; max-height: 250px; overflow-y: auto; }
        .server-item { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; border-radius: 10px; cursor: pointer; }
        .server-item.active { background-color: rgba(92, 77, 255, 0.3); border: 1px solid rgba(92, 77, 255, 0.4); }
        .server-info { display: flex; flex-direction: column; }
        .server-info .en { font-size: 13px; font-weight: 500; }
        .check-icon { width: 18px; height: 18px; fill: #5c4dff; display: none; }
        .signal-icon { width: 16px; height: 16px; fill: #9ca3af; }
        .server-item.active .check-icon { display: block; }
        .server-item.active .signal-icon { display: none; }
        .modal { display: none; position: fixed; z-index: 150; left: 0; top: 0; width: 100%; height: 100%; background-color: rgba(0,0,0,0.8); justify-content: center; align-items: center; backdrop-filter: blur(8px); }
        .modal-content { background-color: rgba(25, 27, 40, 0.95); border-radius: 16px; padding: 24px; width: 90%; max-width: 500px; border: 1px solid rgba(255, 255, 255, 0.1); color: white; display: flex; flex-direction: column; gap: 16px; }
        .modal-header { display: flex; justify-content: space-between; align-items: center; }
        .modal-header h2 { font-size: 18px; font-weight: 700; }
        .close-modal { background: none; border: none; color: #d1d5db; font-size: 22px; cursor: pointer; }
        #embedCodeArea { background-color: rgba(0,0,0,0.4); border: 1px solid rgba(255, 255, 255, 0.1); color: #a78bfa; font-family: monospace; padding: 12px; border-radius: 8px; resize: none; width: 100%; height: 100px; font-size: 12px; direction: ltr; }
        #copyEmbedBtn { background-color: #5c4dff; color: white; border: none; padding: 10px 16px; border-radius: 8px; cursor: pointer; font-weight: 700; font-size: 14px; transition: background-color 0.2s; }
        #copyEmbedBtn:hover { background-color: #4a3be0; }
        @media (max-width: 768px) { .glass-bar.title-bar { width: 96%; padding: 0 16px; top: 15px; } .glass-bar.controls-bar { width: 92%; padding: 0 16px; bottom: 15px; } .video-title { font-size: 13px; max-width: 50%; } }
    </style>
</head>
<body>
    <div class="player-container" id="playerContainer">
        <div id="loadingOverlay" class="loading-overlay"><div class="spinner"></div><div class="loading-text">جاري الاتصال بالبث...</div></div>
        <div id="unmuteOverlay" class="unmute-overlay"><div class="unmute-btn"><svg viewBox="0 0 24 24" width="36" height="36" fill="white"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg></div><span class="unmute-text">انقر لتشغيل الصوت</span></div>
        <video id="video" playsinline webkit-playsinline autoplay muted></video>
        
        <!-- تعديل الشعار ليكون رابط + تعديل العنوان -->
        <div class="glass-bar title-bar" id="titleBar">
            <a href="https://ytvplus.buzz/" target="_blank" class="logo-text">ياسين Tv بلس</a>
            <div class="video-title" dir="rtl"><%= displayTitle %></div>
        </div>
        
        <div id="serverPopup" class="server-popup">
            <div class="popup-header"><div class="popup-title"><span class="ar" dir="rtl">اختر الخادم</span></div><button class="close-server-popup" id="closeServerPopup">&times;</button></div>
            <div class="server-list">
                <% servers.forEach(function(server, i) { %>
                    <div class="server-item <%= i === 0 ? 'active' : '' %>" onclick="changeServer(<%= server.index %>, this)">
                        <div class="server-info"><span class="en"><%= server.name %></span></div>
                        <svg class="check-icon" viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                        <svg class="signal-icon" viewBox="0 0 24 24"><path d="M12 11c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm6 2c0-3.31-2.69-6-6-6s-6 2.69-6 6c0 2.22 1.21 4.15 3 5.19l1-1.74c-1.19-.7-2-1.97-2-3.45 0-2.21 1.79-4 4-4s4 1.79 4 4c0 1.48-.81 2.75-2 3.45l1 1.74c1.79-1.04 3-2.97 3-5.19Z"/></svg>
                    </div>
                <% }); %>
            </div>
        </div>
        
        <div class="glass-bar controls-bar" id="controlsBar">
            <div class="left-controls"><div class="live-dot"></div><span class="live-text">LIVE</span></div>
            <div class="center-controls">
                <button class="play-pause-btn" id="playPauseBtn">
                    <svg class="play-pause-icon" id="pauseIcon" viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16" rx="1"></rect><rect x="14" y="4" width="4" height="16" rx="1"></rect></svg>
                    <svg class="play-pause-icon" id="playIcon" style="display: none;" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"></path></svg>
                </button>
            </div>
            <div class="right-controls">
                <button class="control-icon-btn" id="embedBtn"><svg class="icon-svg" viewBox="0 0 24 24"><path d="M8.293 6.293a1 1 0 0 1 1.414 0L14.414 11H19a1 1 0 0 1 0 2h-4.586l-4.707 4.707a1 1 0 0 1-1.414-1.414L11.586 13H5a1 1 0 0 1 0-2h6.586L8.293 7.707a1 1 0 0 1 0-1.414z"/><path d="M19 19a1 1 0 1 1-2 0V5a1 1 0 0 1 2 0v14z"/></svg></button>
                <button class="control-icon-btn" id="settingsBtn"><svg class="icon-svg" viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg></button>
                <button class="control-icon-btn" id="fullscreenBtn"><svg class="icon-svg" viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg></button>
            </div>
        </div>
    </div>

    <div id="embedModal" class="modal">
        <div class="modal-content">
            <div class="modal-header"><h2>Embed Code / كود التضمين</h2><button class="close-modal" id="closeEmbedModal">&times;</button></div>
            <textarea id="embedCodeArea" readonly><iframe src="<%= fullUrl %>" width="100%" height="500" frameborder="0" allow="autoplay; fullscreen; encrypted-media" allowfullscreen></iframe></textarea>
            <button id="copyEmbedBtn">Copy Code / نسخ الكود</button>
        </div>
    </div>

    <script>
        const video = document.getElementById('video');
        const playerContainer = document.getElementById('playerContainer');
        const unmuteOverlay = document.getElementById('unmuteOverlay');
        const id_live = "<%= id_live %>";
        const token = "<%= token %>";
        const baseUrl = "<%= baseUrl %>";
        let hls = null;
        let inactivityTimeout;

        function resetInactivityTimer() {
            playerContainer.classList.remove('hide-ui');
            clearTimeout(inactivityTimeout);
            inactivityTimeout = setTimeout(() => {
                if (!video.paused && document.getElementById('serverPopup').style.display !== 'block') {
                    playerContainer.classList.add('hide-ui');
                }
            }, 3000);
        }
        playerContainer.addEventListener('mousemove', resetInactivityTimer);
        playerContainer.addEventListener('touchstart', resetInactivityTimer);

        playerContainer.addEventListener('dblclick', (e) => { e.stopPropagation(); toggleFullscreen(); });

        function toggleFullscreen() {
            if (!document.fullscreenElement && !document.webkitFullscreenElement) {
                if (playerContainer.requestFullscreen) playerContainer.requestFullscreen();
                else if (playerContainer.webkitRequestFullscreen) playerContainer.webkitRequestFullscreen();
            } else {
                if (document.exitFullscreen) document.exitFullscreen();
                else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
            }
        }

        function showLoading() { document.getElementById('loadingOverlay').style.opacity = '1'; document.getElementById('loadingOverlay').style.pointerEvents = 'auto'; }
        function hideLoading() { document.getElementById('loadingOverlay').style.opacity = '0'; document.getElementById('loadingOverlay').style.pointerEvents = 'none'; }

        video.muted = true;
        function attemptPlay() {
            video.play().then(() => { 
                unmuteOverlay.style.display = 'flex'; 
                hideLoading(); 
            }).catch(() => { hideLoading(); });
        }

        unmuteOverlay.addEventListener('click', (e) => { e.stopPropagation(); video.muted = false; unmuteOverlay.style.display = 'none'; });

        function changeServer(serverIndex, element = null) {
            showLoading();
            if(element) {
                document.querySelectorAll('.server-item').forEach(el => el.classList.remove('active'));
                element.classList.add('active');
            }

            const manifestUrl = \`\${baseUrl}/proxy/playlist.m3u8?id=\${id_live}&s=\${serverIndex}&tk=\${token}\`;

            if (hls) { hls.destroy(); hls = null; }
            
            if (Hls.isSupported()) {
                hls = new Hls({ 
                    enableWorker: true, lowLatencyMode: true, liveSyncDurationCount: 3, 
                    liveMaxLatencyDurationCount: 5, backBufferLength: 60, fragLoadingTimeOut: 15000, manifestLoadingTimeOut: 15000 
                }); 
                hls.loadSource(manifestUrl); 
                hls.attachMedia(video);
                hls.on(Hls.Events.MANIFEST_PARSED, attemptPlay);
                hls.on(Hls.Events.ERROR, function (event, data) {
                    if (data.fatal) {
                        switch (data.type) {
                            case Hls.ErrorTypes.NETWORK_ERROR: hls.startLoad(); break;
                            case Hls.ErrorTypes.MEDIA_ERROR: hls.recoverMediaError(); break;
                            default: hls.destroy(); break;
                        }
                    }
                });
            } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                video.src = manifestUrl; 
                video.addEventListener('loadedmetadata', attemptPlay);
            }
            document.getElementById('serverPopup').style.display = 'none';
        }

        <% if (servers.length > 0) { %> changeServer(0); <% } %>

        const playPauseBtn = document.getElementById('playPauseBtn');
        const pauseIcon = document.getElementById('pauseIcon');
        const playIcon = document.getElementById('playIcon');

        playPauseBtn.addEventListener('click', (e) => { e.stopPropagation(); video.paused ? video.play() : video.pause(); });
        video.addEventListener('play', () => { pauseIcon.style.display = 'block'; playIcon.style.display = 'none'; resetInactivityTimer(); });
        video.addEventListener('pause', () => { pauseIcon.style.display = 'none'; playIcon.style.display = 'block'; playerContainer.classList.remove('hide-ui'); clearTimeout(inactivityTimeout); });

        document.getElementById('fullscreenBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleFullscreen(); });

        const serverPopup = document.getElementById('serverPopup');
        document.getElementById('settingsBtn').addEventListener('click', (e) => { e.stopPropagation(); serverPopup.style.display = serverPopup.style.display === 'block' ? 'none' : 'block'; });
        document.getElementById('closeServerPopup').addEventListener('click', () => serverPopup.style.display = 'none');

        const embedModal = document.getElementById('embedModal');
        document.getElementById('embedBtn').addEventListener('click', () => embedModal.style.display = 'flex');
        document.getElementById('closeEmbedModal').addEventListener('click', () => embedModal.style.display = 'none');
        document.getElementById('copyEmbedBtn').addEventListener('click', () => {
            document.getElementById('embedCodeArea').select(); 
            document.execCommand('copy'); 
            alert('تم نسخ كود التضمين!'); 
            embedModal.style.display = 'none';
        });
    </script>
</body>
</html>
`;

// ==========================================
// 3. مسار المشغل الرئيسي
// ==========================================
router.get('/m', async (req, res) => {
    try {
        const encodedId = req.query.v;
        if (!encodedId) return res.status(400).send("Invalid Request");

        const id_live = decodeId(encodedId);

        let matches = matchesCache.get('all_matches');
        if (!matches) {
            const matchRes = await fetchWithFallback('/ytvplus/mach');
            matches = matchRes.data;
        }
        
        // جلب اسم المباراة الحقيقي 
        const matchInfo = matches.find(m => m.id_live === id_live) || {};
        
        // استخراج العنوان سواء كان مسجل في title أو name أو كفريقين
        let displayTitle = matchInfo.title || matchInfo.name || "بث مباشر";
        if (matchInfo.team1 && matchInfo.team2 && displayTitle === "بث مباشر") {
            displayTitle = `${matchInfo.team1} x ${matchInfo.team2}`;
        }

        let parsedServers = serverCache.get(`servers_${id_live}`);
        if (!parsedServers) {
            const serversRes = await fetchWithFallback(`/ytvplus/stream?id_live=${id_live}`);
            
            parsedServers = serversRes.data.map((srv, index) => {
                let realUrl = "", customHeaders = {}, swapKey = null, swapVal = null, userAgent = "Mozilla/5.0";

                try {
                    if (srv.data.url.startsWith('{') && srv.data.url.endsWith('}')) {
                        const nestedObj = JSON.parse(srv.data.url);
                        realUrl = nestedObj.url;
                        if (nestedObj.agent) userAgent = nestedObj.agent;
                        if (nestedObj.swap) {
                            swapKey = Object.keys(nestedObj.swap)[0];
                            swapVal = nestedObj.swap[swapKey];
                        }
                        if (nestedObj.headers) customHeaders = { ...nestedObj.headers };
                    } else {
                        realUrl = srv.data.url;
                    }

                    if (!customHeaders['User-Agent']) customHeaders['User-Agent'] = userAgent;
                    if (realUrl) {
                        const parsedUrl = new URL(realUrl);
                        const origin = `${parsedUrl.protocol}//${parsedUrl.host}`;
                        if (!customHeaders['Referer']) customHeaders['Referer'] = origin + '/';
                        if (!customHeaders['Origin']) customHeaders['Origin'] = origin;
                    }
                } catch (e) {
                    realUrl = srv.data.url;
                }

                const serverConfig = { realUrl, customHeaders, swapKey, swapVal, name: srv.name || `سيرفر ${index + 1}` };
                serverCache.set(`srv_${id_live}_${index}`, serverConfig); 
                return { index, name: serverConfig.name };
            });
            serverCache.set(`servers_${id_live}`, parsedServers);
        }

        const clientIp = getClientIp(req);
        const secureToken = generateSecureToken(clientIp);
        const fullUrl = `https://${req.get('host')}${req.originalUrl}`;
        const renderedHtml = ejs.render(playerTemplate, { 
            displayTitle: displayTitle, 
            servers: parsedServers, 
            id_live, 
            token: secureToken, 
            fullUrl, 
            baseUrl: req.baseUrl 
        });
        res.send(renderedHtml);

    } catch (error) {
        res.status(500).send("حدث خطأ أثناء الاتصال بالخادم.");
    }
});

// ==========================================
// 4. مسار البروكسي لملف (M3U8)
// ==========================================
router.get('/proxy/playlist.m3u8', verifyStreamAccess, async (req, res) => {
    const { id, s, tk } = req.query; 
    const srvConfig = serverCache.get(`srv_${id}_${s}`);
    
    if (!srvConfig || !srvConfig.realUrl) return res.status(404).send("Server not found");

    const cacheKey = `m3u8_raw_${id}_${s}`;
    let rawM3u8 = m3u8Cache.get(cacheKey);

    try {
        if (!rawM3u8) {
            if (activeM3u8Requests.has(cacheKey)) {
                rawM3u8 = await activeM3u8Requests.get(cacheKey);
            } else {
                const requestPromise = axiosInstance.get(srvConfig.realUrl, { 
                    headers: srvConfig.customHeaders, responseType: 'text', timeout: 10000 
                }).then(response => response.data);
                
                activeM3u8Requests.set(cacheKey, requestPromise);
                rawM3u8 = await requestPromise;
                
                m3u8Cache.set(cacheKey, rawM3u8); 
                activeM3u8Requests.delete(cacheKey); 
            }
        }

        const baseUrl = srvConfig.realUrl.substring(0, srvConfig.realUrl.lastIndexOf('/') + 1);
        const lines = rawM3u8.split('\n');
        
        const modifiedLines = lines.map(line => {
            let trimmed = line.trim();
            if (!trimmed.startsWith('#') && trimmed !== '') {
                let segmentUrl = trimmed.startsWith('http') ? trimmed : baseUrl + trimmed;
                if (srvConfig.swapKey && srvConfig.swapVal !== null && segmentUrl.includes(srvConfig.swapKey)) {
                    segmentUrl = segmentUrl.replace(srvConfig.swapKey, srvConfig.swapVal);
                }
                return `${req.baseUrl}/proxy/segment.ts?id=${id}&s=${s}&tk=${tk}&url=${encodeURIComponent(segmentUrl)}`;
            }
            return line;
        });

        res.set({ 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*' });
        res.send(modifiedLines.join('\n'));
    } catch (error) {
        activeM3u8Requests.delete(cacheKey); 
        res.status(500).send("Playlist Error");
    }
});

// ==========================================
// 5. مسار البروكسي لقطع الفيديو (TS)
// ==========================================
router.get('/proxy/segment.ts', verifyStreamAccess, async (req, res) => {
    const { id, s, url } = req.query;
    const srvConfig = serverCache.get(`srv_${id}_${s}`);
    
    if (!srvConfig) return res.status(404).send();

    const controller = new AbortController();
    req.on('close', () => controller.abort());

    try {
        const response = await axiosInstance.get(decodeURIComponent(url), {
            headers: srvConfig.customHeaders, 
            responseType: 'stream', 
            timeout: 15000,
            signal: controller.signal 
        });
        
        res.set({ 'Content-Type': 'video/MP2T', 'Access-Control-Allow-Origin': '*' });
        response.data.pipe(res);
    } catch (error) {
        if (!axios.isCancel(error)) {
            res.status(500).send();
        }
    }
});

module.exports = router;
