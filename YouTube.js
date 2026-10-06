const express = require('express');
const cors = require('cors');
const YTDLPWrapper = require('yt-dlp-wrap').default;
const path = require('path');
const fs = require('fs');

// استخدام Router بدلاً من app مستقل ليتوافق تماماً مع Xstarts.js
const router = express.Router();

// تحديد اسم وقارئ ملف yt-dlp بناءً على نظام تشغيل البيئة (Windows أو Linux الاستضافة)
const isWindows = process.platform === 'win32';
const binaryName = isWindows ? 'yt-dlp.exe' : 'yt-dlp';
const binaryPath = path.join(__dirname, binaryName);

let ytDlpWrap;

// دالة التهيئة والتحقق من وجود الملف التنفيذي أو تنزيله تلقائياً
async function initYtDlp() {
    try {
        if (!fs.existsSync(binaryPath)) {
            console.log(`⏳ جاري تنزيل أحدث نسخة من ${binaryName} للبيئة الحالية...`);
            await YTDLPWrapper.downloadFromGithub(binaryPath);
            // إعطاء صلاحيات التشغيل التنفيذية على بيئات Linux
            if (!isWindows) {
                fs.chmodSync(binaryPath, '755');
            }
            console.log(`✅ تم تنزيل ${binaryName} بنجاح!`);
        }
        ytDlpWrap = new YTDLPWrapper(binaryPath);
    } catch (err) {
        console.error('❌ خطأ في تهيئة yt-dlp:', err.message);
    }
}

// دالة مساعدة لتنسيق الأرقام إلى رموز مقروءة (K, M, B)
function formatNumber(num) {
    if (num === undefined || num === null || isNaN(num)) return null;
    const n = Number(num);
    if (n >= 1000000000) return (n / 1000000000).toFixed(1).replace(/\.0$/, '') + 'B';
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    return n.toString();
}

// دالة مساعدة لمعالجة تاريخ النشر بدقة بالغة ورده بصيغة YYYY-MM-DD و Timestamp
function extractUploadDate(item) {
    if (!item) return { dateFormatted: null, timestamp: null };

    // فحص حقل upload_date الأساسي بصيغة YYYYMMDD
    if (item.upload_date && typeof item.upload_date === 'string' && item.upload_date.length === 8) {
        const year = item.upload_date.substring(0, 4);
        const month = item.upload_date.substring(4, 6);
        const day = item.upload_date.substring(6, 8);
        const formatted = `${year}-${month}-${day}`;
        const timestamp = Math.floor(new Date(`${formatted}T00:00:00Z`).getTime() / 1000);
        return { dateFormatted: formatted, timestamp: isNaN(timestamp) ? null : timestamp };
    }

    // فحص حقول الختم الزمني (timestamp / release_timestamp)
    const ts = item.timestamp || item.release_timestamp;
    if (ts && !isNaN(ts)) {
        const dateObj = new Date(ts * 1000);
        const formatted = dateObj.toISOString().split('T')[0];
        return { dateFormatted: formatted, timestamp: ts };
    }

    return { dateFormatted: null, timestamp: null };
}

// ==========================================
// 1. مسار استخراج روابط وبيانات الفيديو المباشرة
// ==========================================
router.get('/api/extract', async (req, res) => {
    const videoUrl = req.query.url;

    if (!videoUrl) {
        return res.status(400).json({ error: 'يرجى تقديم رابط الفيديو عبر url' });
    }

    try {
        if (!ytDlpWrap) {
            return res.status(500).json({ error: 'الأداة قيد التهيئة، يرجى المحاولة بعد لحظات...' });
        }

        // استخدام عميل أندرويد لتجاوز فحص البوت (Bot Detection)
        const stdout = await ytDlpWrap.execPromise([
            videoUrl,
            '--dump-json',
            '--no-check-certificates',
            '--no-warnings',
            '--extractor-args', 'youtube:player_client=android,web',
            '--add-header', 'referer:youtube.com',
            '--add-header', 'user-agent:Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36'
        ]);

        const output = JSON.parse(stdout);
        const formats = output.formats || [];

        const isShort = (output.duration && output.duration <= 60) || videoUrl.includes('/shorts/');
        const dateInfo = extractUploadDate(output);

        const bestAudio = formats
            .filter(f => f.acodec !== 'none' && f.vcodec === 'none' && f.url)
            .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];

        const videoStreamsMap = new Map();

        formats.forEach(f => {
            if (f.height && f.vcodec !== 'none' && f.url) {
                const height = f.height;
                const hasAudio = f.acodec !== 'none';

                if (!videoStreamsMap.has(height) || hasAudio) {
                    videoStreamsMap.set(height, {
                        quality: `${height}p`,
                        height: height,
                        hasAudio: hasAudio,
                        formatId: f.format_id,
                        ext: f.ext || 'mp4',
                        url: f.url
                    });
                }
            }
        });

        const videoStreams = Array.from(videoStreamsMap.values()).sort((a, b) => b.height - a.height);

        res.json({
            status: 'success',
            id: output.id,
            title: output.title,
            description: output.description || '',
            isShort: isShort,
            duration: output.duration || 0,
            uploadDate: dateInfo.dateFormatted,
            timestamp: dateInfo.timestamp,
            viewCountRaw: output.view_count || null,
            viewCountFormatted: formatNumber(output.view_count),
            likeCountRaw: output.like_count || null,
            likeCountFormatted: formatNumber(output.like_count),
            thumbnail: output.thumbnail,
            channelName: output.uploader || output.channel || null,
            channelId: output.channel_id || null,
            channelUrl: output.channel_url || null,
            audioStream: bestAudio ? {
                quality: 'High Audio',
                bitrate: `${Math.round(bestAudio.abr || 0)}kbps`,
                ext: bestAudio.ext || 'm4a',
                url: bestAudio.url
            } : null,
            videoStreams: videoStreams
        });

    } catch (error) {
        console.error('خطأ في استخراج الروابط:', error);
        res.status(500).json({ status: 'error', message: 'فشل استخراج الروابط المباشرة', details: error.message });
    }
});
// ==========================================
// 2. مسار استخراج معلومات القناة
// ==========================================
router.get('/api/channel/info', async (req, res) => {
    const channelUrl = req.query.url;

    if (!channelUrl) {
        return res.status(400).json({ error: 'يرجى تقديم رابط القناة عبر url' });
    }

    try {
        if (!ytDlpWrap) {
            return res.status(500).json({ error: 'الأداة قيد التهيئة...' });
        }

        const stdout = await ytDlpWrap.execPromise([
            channelUrl,
            '--dump-single-json',
            '--playlist-items', '0',
            '--no-check-certificates',
            '--no-warnings'
        ]);

        const output = JSON.parse(stdout);
        const subCount = output.channel_follower_count || null;

        res.json({
            status: 'success',
            channelName: output.channel || output.uploader || output.title,
            channelId: output.channel_id,
            channelUrl: output.channel_url,
            subscribersRaw: subCount,
            subscribersFormatted: formatNumber(subCount),
            description: output.description || '',
            avatar: output.thumbnails ? output.thumbnails.find(t => t.id === 'avatar_uncropped' || t.id === 'avatar')?.url || output.thumbnails[0]?.url : null,
            banner: output.thumbnails ? output.thumbnails.find(t => t.id === 'banner_uncropped' || t.id === 'banner')?.url : null
        });

    } catch (error) {
        console.error('خطأ في استخراج بيانات القناة:', error);
        res.status(500).json({ status: 'error', message: 'فشل استخراج بيانات القناة', details: error.message });
    }
});

// ==========================================
// 3. مسار استخراج فيديوهات القناة
// ==========================================
router.get('/api/channel/videos', async (req, res) => {
    const channelUrl = req.query.url;
    const limit = req.query.limit || 20;

    if (!channelUrl) {
        return res.status(400).json({ error: 'يرجى تقديم رابط القناة عبر url' });
    }

    try {
        if (!ytDlpWrap) {
            return res.status(500).json({ error: 'الأداة قيد التهيئة...' });
        }

        const targetUrl = channelUrl.endsWith('/videos') ? channelUrl : `${channelUrl.replace(/\/$/, '')}/videos`;

        const stdout = await ytDlpWrap.execPromise([
            targetUrl,
            '--dump-single-json',
            '--flat-playlist',
            '--playlist-end', String(limit),
            '--no-check-certificates',
            '--no-warnings'
        ]);

        const output = JSON.parse(stdout);
        const entries = output.entries || [];

        const videos = entries.map(item => {
            const dateInfo = extractUploadDate(item);
            return {
                id: item.id,
                title: item.title,
                url: item.url || `https://www.youtube.com/watch?v=${item.id}`,
                isShort: (item.duration && item.duration <= 60) || false,
                duration: item.duration || null,
                uploadDate: dateInfo.dateFormatted,
                timestamp: dateInfo.timestamp,
                viewCountRaw: item.view_count || null,
                viewCountFormatted: formatNumber(item.view_count),
                thumbnail: item.thumbnails && item.thumbnails.length > 0 
                    ? item.thumbnails[item.thumbnails.length - 1].url 
                    : `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`
            };
        });

        res.json({
            status: 'success',
            channelName: output.title || output.channel,
            totalRetrieved: videos.length,
            videos: videos
        });

    } catch (error) {
        console.error('خطأ في استخراج فيديوهات القناة:', error);
        res.status(500).json({ status: 'error', message: 'فشل استخراج فيديوهات القناة', details: error.message });
    }
});

// ==========================================
// 4. مسار البحث الشامل عن الفيديوهات (Search)
// ==========================================
router.get('/api/search', async (req, res) => {
    const query = req.query.q;
    const limit = req.query.limit || 20;

    if (!query) {
        return res.status(400).json({ error: 'يرجى تقديم كلمة البحث عبر q' });
    }

    try {
        if (!ytDlpWrap) {
            return res.status(500).json({ error: 'الأداة قيد التهيئة...' });
        }

        const stdout = await ytDlpWrap.execPromise([
            `ytsearch${limit}:${query}`,
            '--dump-single-json',
            '--flat-playlist',
            '--no-check-certificates',
            '--no-warnings'
        ]);

        const output = JSON.parse(stdout);
        const entries = output.entries || [];

        const results = entries.map(item => {
            const dateInfo = extractUploadDate(item);
            return {
                id: item.id,
                title: item.title,
                url: item.url || `https://www.youtube.com/watch?v=${item.id}`,
                isShort: (item.duration && item.duration <= 60) || false,
                channel: item.uploader || item.channel || null,
                channelUrl: item.uploader_url || null,
                duration: item.duration || null,
                uploadDate: dateInfo.dateFormatted,
                timestamp: dateInfo.timestamp,
                viewCountRaw: item.view_count || null,
                viewCountFormatted: formatNumber(item.view_count),
                thumbnail: item.thumbnails && item.thumbnails.length > 0 
                    ? item.thumbnails[item.thumbnails.length - 1].url 
                    : `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`
            };
        });

        res.json({
            status: 'success',
            query: query,
            totalResults: results.length,
            results: results
        });

    } catch (error) {
        console.error('خطأ في البحث:', error);
        res.status(500).json({ status: 'error', message: 'فشلت عملية البحث', details: error.message });
    }
});

// تهيئة أداة yt-dlp فور تحميل الملف
initYtDlp();

// تصدير الـ Router ليتم ربطه بـ Xstarts.js عبر app.use('/youtube', YouTube)
module.exports = router;
