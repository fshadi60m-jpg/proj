const express = require('express');
const cheerio = require('cheerio');
const crypto = require('crypto');
const NodeCache = require('node-cache'); // إضافة الكاش

const app = express();
app.use(express.json());

// إعداد الكاش الذكي: مدة 10 دقائق (600 ثانية)، وتنظيف الذاكرة كل دقيقتين
const appCache = new NodeCache({ stdTTL: 600, checkperiod: 120 });
const activeRequests = new Map();

// دالة الكاش الذكي لمنع تكرار الطلبات في نفس اللحظة
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

app.get('/api/page', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.json([emptyResponse]);

    const cacheKey = `topcinma_page_${targetUrl}`;
    
    try {
        const data = await fetchWithCache(cacheKey, async () => {
            const response = await fetch(targetUrl, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } });
            if (!response.ok) return [emptyResponse];

            const html = await response.text();
            const $ = cheerio.load(html);
            const moviesList = [];

            $('div.entry-box, .item__contents').each((index, element) => {
                const box = $(element);
                const movieUrl = box.find('a.movie__block').attr('href') || box.find('h3 a').attr('href') || box.find('.entry-image a').attr('href') || box.find('> a').attr('href') || "";
                const title = box.find('.post__info h3').text().trim() || box.find('h3 a').text().trim() || box.find('a.movie__block').attr('title') || "";
                const imgTag = box.find('.post__image img, .entry-image img');
                const imageUrl = imgTag.attr('data-src') || imgTag.attr('data-lazy-src') || imgTag.attr('src') || "";

                let eclip_Num = "";
                const seriesText = box.find('.__number').text().trim() || box.find('.label.series').text().trim();
                if (seriesText) {
                    const num = seriesText.replace(/\D/g, '');
                    if(num) eclip_Num = "حلقة " + num; 
                }

                let genre = box.find('.post__category, .badge-light').text().trim().replace(/\s+/g, ' ') || ""; 
                let quality = box.find('.__quality, .badge-secondary').first().text().trim() || ""; 
                let imdbRating = box.find('.label.rating').text().replace(/[^\d.]/g, '') || "";
                const id = movieUrl ? crypto.createHash('md5').update(movieUrl).digest('hex') : "";

                if (title && movieUrl) {
                    moviesList.push({ id, title, url: movieUrl, image: imageUrl, genres: genre, quality, imdb: imdbRating, eclip_Num });
                }
            });

            return moviesList.length > 0 ? moviesList : [emptyResponse];
        });

        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.json(data);
    } catch (error) { res.json([emptyResponse]); }
});

app.get('/api/seasons', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.json([emptyResponse]);

    const cacheKey = `topcinma_seasons_${targetUrl}`;

    try {
        const data = await fetchWithCache(cacheKey, async () => {
            const response = await fetch(targetUrl, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } });
            if (!response.ok) return [emptyResponse];

            const html = await response.text();
            const $ = cheerio.load(html);
            const seasonsList = [];
            const metaImage = $('meta[name="twitter:image"]').attr('content') || $('meta[property="og:image"]').attr('content') || "";

            $('#series-episodes .widget-body a.btn, #series-episodes .widget-body > a').each((index, element) => {
                const el = $(element);
                const seasonUrl = el.attr('href') || "";
                const title = el.text().trim() || "";
                const id = seasonUrl ? crypto.createHash('md5').update(seasonUrl).digest('hex') : "";
                if (title && seasonUrl) seasonsList.push({ id, title, url: seasonUrl, image: metaImage, genres: "", quality: "", imdb: "", eclip_Num: "" });
            });

            if(seasonsList.length === 0){
                 $('a:contains("الموسم")').each((index, element) => {
                    const el = $(element);
                    const seasonUrl = el.attr('href') || "";
                    let title = el.text().trim() || "";
                    if (title.length > 50) return; 
                    const id = seasonUrl ? crypto.createHash('md5').update(seasonUrl).digest('hex') : "";
                    if (title && seasonUrl && seasonUrl.includes('series')) {
                        seasonsList.push({ id, title, url: seasonUrl, image: metaImage, genres: "", quality: "", imdb: "", eclip_Num: "" });
                    }
                 });
            }

            if (seasonsList.length === 0) {
                const hasEpisodes = $('div.bg-primary2').length > 0 || $('.item__contents.is__episode').length > 0;
                if (hasEpisodes) {
                    const fakeId = crypto.createHash('md5').update(targetUrl).digest('hex');
                    seasonsList.push({ id: fakeId, title: "الموسم الاول", url: targetUrl, image: metaImage, genres: "", quality: "", imdb: "", eclip_Num: "" });
                }
            }

            if (seasonsList.length === 0) return [emptyResponse];
            return Array.from(new Map(seasonsList.map(item => [item.url, item])).values());
        });

        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.json(data);
    } catch (error) { res.json([emptyResponse]); }
});

app.get('/api/episodes', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.json([emptyResponse]);

    const cacheKey = `topcinma_episodes_${targetUrl}`;

    try {
        const data = await fetchWithCache(cacheKey, async () => {
            const response = await fetch(targetUrl, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } });
            if (!response.ok) return [emptyResponse];

            const html = await response.text();
            const $ = cheerio.load(html);
            const episodesList = [];

            $('div.bg-primary2').each((index, element) => {
                const el = $(element);
                const titleElement = el.find('h2 a');
                const url = titleElement.attr('href') || "";
                const title = titleElement.text().trim() || "";
                const imgTag = el.find('picture img');
                const image = imgTag.attr('data-src') || imgTag.attr('data-lazy-src') || imgTag.attr('src') || "";
                const altText = imgTag.attr('alt') || "";
                const eclip_Num = altText.replace(/\D/g, '') || ""; 
                const id = url ? crypto.createHash('md5').update(url).digest('hex') : "";

                if (title && url) {
                    episodesList.push({ id, title, url, image, genres: "", quality: "", imdb: "", eclip_Num });
                }
            });

            return episodesList.length > 0 ? episodesList : [emptyResponse];
        });

        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.json(data);
    } catch (error) { res.json([emptyResponse]); }
});

app.get('/api/watch', async (req, res) => {
    let targetUrl = req.query.url;
    if (!targetUrl) return res.json([]);
    
    if (!targetUrl.endsWith('/watch/')) targetUrl = targetUrl.replace(/\/$/, '') + '/watch/';
    const cacheKey = `topcinma_watch_${targetUrl}`;

    try {
        const data = await fetchWithCache(cacheKey, async () => {
            const pageResponse = await fetch(encodeURI(targetUrl), { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } });
            const pageHtml = await pageResponse.text();
            const $ = cheerio.load(pageHtml);
            const validServers = [];
            const blockedDomains = ['llvpn', 'ads', 'pop', 'blank','d0o0d','d0o0d.com', 'updown.icu', 'updown'];

            $('.watch-top .server-btn').each((i, el) => {
                const serverLink = $(el).attr('data-link');
                if (serverLink && serverLink.startsWith('http')) {
                    const isBlocked = blockedDomains.some(d => serverLink.includes(d));
                    if (!isBlocked) validServers.push({ url: serverLink });
                }
            });
            return validServers;
        });

        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return res.json(data);
    } catch (error) { return res.json([]); }
});


// إضافة مسار الدومين الأساسي ليعرض مصفوفة فارغة
app.get('/', (req, res) => {
  res.json([]);
});


app.get('/api/next-episode', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.json([]);

    const cacheKey = `topcinma_next_${targetUrl}`;

    try {
        const data = await fetchWithCache(cacheKey, async () => {
            const response = await fetch(targetUrl, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } });
            if (!response.ok) return [];

            const html = await response.text();
            const $ = cheerio.load(html);
            const nextElement = $('a.next');

            if (nextElement.length > 0) {
                const nextUrl = nextElement.attr('href') || "";
                const nextNumber = nextElement.find('strong').text().trim() || "";
                const nextTitle = nextElement.find('.txtDiv span').text().trim() || "";
                if (nextUrl) return [{ title: nextTitle, number: nextNumber, url: nextUrl }];
            }
            return [];
        });

        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return res.json(data);
    } catch (error) { return res.json([]); }
});

module.exports = app;
