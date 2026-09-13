const express = require('express');
const cheerio = require('cheerio');
const crypto = require('crypto');
const NodeCache = require('node-cache');

const app = express();
app.use(express.json());

// استبدال كاش Map اليدوي لتجنب تسريب الذاكرة (Memory Leak)
// مدة الكاش: 10 دقائق
const appCache = new NodeCache({ stdTTL: 600, checkperiod: 120 });
const activeRequests = new Map();

async function fetchWithCache(cacheKey, fetchFunction) {
    if (appCache.has(cacheKey)) return appCache.get(cacheKey);
    if (activeRequests.has(cacheKey)) return await activeRequests.get(cacheKey);
    const requestPromise = (async () => {
        try {
            const data = await fetchFunction();
            appCache.set(cacheKey, data);
            return data;
        } finally {
            activeRequests.delete(cacheKey);
        }
    })();
    activeRequests.set(cacheKey, requestPromise);
    return await requestPromise;
}

const emptyResponse = { id: "", title: "", url: "", image: "", genres: "", quality: "", imdb: "", eclip_Num: "" };

function cleanTitle(title) {
    if (!title) return "";
    return title.replace(/مترجم|اون\s*لاين|اونلاين|HD|1080p|720p|4k|مشاهدة|تحميل|جودة\s*عالية|كامل|حصرياً|حصريا|برابط\s*مباشر/gi, '').replace(/\s+/g, ' ').trim();
}

function formatUrl(url, baseUrl) {
    if (!url) return "";
    let fullUrl = url.startsWith('http') ? url : new URL(url, baseUrl).href;
    return fullUrl.replace('/video.php?vid=', '/play.php?vid=');
}

app.get('/api/page', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.json([emptyResponse]);

    try {
        const data = await fetchWithCache(`laroza_page_${targetUrl}`, async () => {
            const response = await fetch(targetUrl, {
                headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
                signal: AbortSignal.timeout(5000)
            });
            if (!response.ok) return [emptyResponse];

            const html = await response.text();
            const $ = cheerio.load(html);
            const baseUrl = new URL(targetUrl).origin;
            const host = req.protocol + '://' + req.get('host');
            const finalMoviesList = [];

            $('li.col-xs-6.col-sm-4.col-md-3').each((index, element) => {
                if (index >= 30) return false; 
                const box = $(element);
                const rawUrl = box.find('a').first().attr('href') || "";
                if (!rawUrl) return true;

                const fetchUrl = rawUrl.startsWith('http') ? rawUrl : new URL(rawUrl, baseUrl).href;
                const movieUrl = formatUrl(rawUrl, baseUrl);
                const rawTitle = box.find('.caption h3 a').text().trim() || box.find('a').first().attr('title') || "";
                const title = cleanTitle(rawTitle);
                const quality = box.find('.pm-video-labels .hot').text().trim() || "";
                const eclip_Num = box.find('.pm-label-duration').text().trim() || "";
                const id = movieUrl ? crypto.createHash('md5').update(movieUrl).digest('hex') : "";

                finalMoviesList.push({
                    id, title, url: movieUrl,
                    image: `${host}/floratv/api/image?url=${encodeURIComponent(fetchUrl)}&baseUrl=${encodeURIComponent(baseUrl)}`,
                    quality, eclip_Num, genres: "", imdb: ""
                });
            });
            return finalMoviesList.length > 0 ? finalMoviesList : [emptyResponse];
        });
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.json(data);
    } catch (error) { res.json([emptyResponse]); }
});

app.get('/api/ramadan', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.json([emptyResponse]);

    try {
        const data = await fetchWithCache(`laroza_ramadan_${targetUrl}`, async () => {
            const response = await fetch(targetUrl, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(5000) });
            if (!response.ok) return [emptyResponse];

            const html = await response.text();
            const $ = cheerio.load(html);
            const baseUrl = new URL(targetUrl).origin;
            const host = req.protocol + '://' + req.get('host');
            const ramadanList = [];

            $('a.icon-link').each((index, element) => {
                const aTag = $(element);
                const rawUrl = aTag.attr('href') || "";
                if (!rawUrl.includes('view-serie1.php')) return true;

                const rawTitle = aTag.text().trim();
                const title = cleanTitle(rawTitle);
                if (!title) return true;

                const fetchUrl = rawUrl.startsWith('http') ? rawUrl : new URL(rawUrl, baseUrl).href;
                const serieUrl = formatUrl(rawUrl, baseUrl);
                const id = serieUrl ? crypto.createHash('md5').update(serieUrl).digest('hex') : "";

                ramadanList.push({
                    id, title, url: serieUrl,
                    image: `${host}/floratv/api/image?url=${encodeURIComponent(fetchUrl)}&baseUrl=${encodeURIComponent(baseUrl)}`,
                    quality: "", eclip_Num: "", genres: "", imdb: ""
                });
            });
            return ramadanList.length > 0 ? ramadanList : [emptyResponse];
        });
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.json(data);
    } catch (error) { res.json([emptyResponse]); }
});

app.get('/api/image', async (req, res) => {
    const targetUrl = req.query.url;
    const baseUrl = req.query.baseUrl;
    const fallbackImage = "https://via.placeholder.com/300x450?text=No+Image";

    if (!targetUrl) return res.redirect(fallbackImage);
    
    const cacheKey = `laroza_img_${targetUrl}`;
    if (appCache.has(cacheKey)) return res.redirect(appCache.get(cacheKey));

    try {
        const pageResponse = await fetch(targetUrl, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(2500) });
        const pageHtml = await pageResponse.text();
        const $$ = cheerio.load(pageHtml);
        
        let imageUrl = $$('link[rel="image_src"]').attr('href') || $$('meta[property="og:image"]').attr('content') || "";
        if (imageUrl && !imageUrl.startsWith('http')) imageUrl = new URL(imageUrl, baseUrl).href;

        if (imageUrl) {
            appCache.set(cacheKey, imageUrl);
            return res.redirect(imageUrl);
        }
        return res.redirect(fallbackImage);
    } catch (err) { return res.redirect(fallbackImage); }
});

app.get('/api/seasons', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.json([emptyResponse]);

    try {
        const data = await fetchWithCache(`laroza_seasons_${targetUrl}`, async () => {
            const response = await fetch(targetUrl, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(5000) });
            if (!response.ok) return [emptyResponse];

            const html = await response.text();
            const $ = cheerio.load(html);
            const seasonsList = [];
            const metaImage = $('meta[property="og:image"]').attr('content') || "";
            const tabButtons = $('div.SeasonsBoxUL button.tablinks, div.Tab button.tablinks');

            if (tabButtons.length > 0) {
                tabButtons.each((index, element) => {
                    const btn = $(element);
                    const title = cleanTitle(btn.text().trim());
                    const onclick = btn.attr('onclick') || "";
                    const match = onclick.match(/openCity\([^,]+,\s*['"]([^'"]+)['"]\)/);
                    const seasonId = match ? match[1] : `Season${index + 1}`;
                    const seasonUrl = `${targetUrl}&season_id=${seasonId}`;
                    const id = crypto.createHash('md5').update(seasonUrl).digest('hex');
                    seasonsList.push({ id, title, url: seasonUrl, image: metaImage, genres: "", quality: "", imdb: "", eclip_Num: "" });
                });
            } else {
                $('div.SeasonsBoxUL ul li').each((index, element) => {
                    const li = $(element);
                    const seasonNumber = li.attr('data-serie') || "";
                    const title = cleanTitle(li.text().trim()) || `الموسم ${seasonNumber}`;
                    const seasonUrl = `${targetUrl}&season_id=${seasonNumber}`;
                    const id = seasonUrl ? crypto.createHash('md5').update(seasonUrl).digest('hex') : "";
                    seasonsList.push({ id, title, url: seasonUrl, image: metaImage, genres: "", quality: "", imdb: "", eclip_Num: "" });
                });
            }
            return seasonsList.length > 0 ? seasonsList : [emptyResponse];
        });
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.json(data);
    } catch (error) { res.json([emptyResponse]); }
});

app.get('/api/episodes', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.json([emptyResponse]);

    try {
        const data = await fetchWithCache(`laroza_episodes_${targetUrl}`, async () => {
            let seasonId = req.query.season_id || new URL(targetUrl).searchParams.get('season_id');
            const response = await fetch(targetUrl, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(5000) });
            if (!response.ok) return [emptyResponse];

            const html = await response.text();
            const $ = cheerio.load(html);
            const baseUrl = new URL(targetUrl).origin;
            let defaultImageUrl = $('link[rel="image_src"]').attr('href') || $('meta[property="og:image"]').attr('content') || "";
            if (defaultImageUrl && !defaultImageUrl.startsWith('http')) defaultImageUrl = new URL(defaultImageUrl, baseUrl).href;

            const episodesList = [];
            let container = $;
            if (seasonId) {
                if ($(`#${seasonId}`).length > 0) container = $(`#${seasonId}`);
                else if ($(`div.SeasonsEpisodes[data-serie="${seasonId}"]`).length > 0) container = $(`div.SeasonsEpisodes[data-serie="${seasonId}"]`);
            }

            const newEpisodeItems = container.find('li.col-xs-6, li.col-sm-4, li.col-md-3');
            if (newEpisodeItems.length > 0) {
                newEpisodeItems.each((i, el) => {
                    const item = $(el);
                    const aTag = item.find('.pm-video-thumb a, .caption h3 a, a').first();
                    let rawUrl = aTag.attr('href') || "";
                    if (!rawUrl) return true;

                    let episodeUrl = formatUrl(rawUrl, baseUrl);
                    const rawTitle = item.find('.caption h3 a').text().trim() || aTag.attr('title') || "";
                    const title = cleanTitle(rawTitle);
                    let imgTagSrc = item.find('img').attr('src') || item.find('img').attr('data-src') || "";
                    let episodeImage = defaultImageUrl;
                    if (imgTagSrc) episodeImage = imgTagSrc.startsWith('http') ? imgTagSrc : new URL(imgTagSrc, baseUrl).href;

                    const epMatch = rawTitle.match(/الحلقة\s*(\d+)/i) || rawTitle.match(/حلقة\s*(\d+)/i);
                    const eclip_Num = epMatch ? `الحلقة ${epMatch[1]}` : "";
                    const id = crypto.createHash('md5').update(episodeUrl).digest('hex');
                    episodesList.push({ id, title, url: episodeUrl, image: episodeImage, genres: "", quality: "", imdb: "", eclip_Num });
                });
            } 
            
            if (episodesList.length === 0) {
                let episodesContainer = seasonId ? $(`div.SeasonsEpisodes[data-serie="${seasonId}"]`) : $('div.SeasonsEpisodes').first();
                episodesContainer.find('a').each((i, el) => {
                    const aTag = $(el);
                    let rawUrl = aTag.attr('href') || "";
                    if (!rawUrl) return true;
                    let episodeUrl = formatUrl(rawUrl, baseUrl);
                    const rawTitle = aTag.attr('title') || aTag.text().trim() || "";
                    const title = cleanTitle(rawTitle);
                    const epNumText = aTag.find('em').text().trim();
                    const eclip_Num = epNumText ? `الحلقة ${epNumText}` : "";
                    const id = crypto.createHash('md5').update(episodeUrl).digest('hex');
                    episodesList.push({ id, title, url: episodeUrl, image: defaultImageUrl, genres: "", quality: "", imdb: "", eclip_Num });
                });
            }
            return episodesList.length > 0 ? episodesList : [emptyResponse];
        });
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.json(data);
    } catch (error) { res.json([emptyResponse]); }
});

// إضافة مسار الدومين الأساسي ليعرض مصفوفة فارغة
app.get('/', (req, res) => {
  res.json([]);
});


app.get('/api/watch', async (req, res) => {
    let targetUrl = req.query.url;
    if (!targetUrl) return res.json([]);

    try {
        const data = await fetchWithCache(`laroza_watch_${targetUrl}`, async () => {
            const response = await fetch(targetUrl, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(5000) });
            if (!response.ok) return [{ url: targetUrl }];

            const html = await response.text();
            const $ = cheerio.load(html);
            const finalServers = [];
            const serverElements = $('ul.WatchList li');

            if (serverElements.length > 0) {
                serverElements.each((index, element) => {
                    const embedId = $(element).attr('data-embed-id') || (index + 1);
                    const separator = targetUrl.includes('?') ? '&' : '?';
                    finalServers.push({ url: `${targetUrl}${separator}s=${embedId}` });
                });
            } else {
                finalServers.push({ url: targetUrl });
            }
            return finalServers;
        });
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return res.json(data);
    } catch (error) { return res.json([{ url: targetUrl }]); }
});

module.exports = app;
