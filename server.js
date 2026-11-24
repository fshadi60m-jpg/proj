const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const session = require('express-session');
const path = require('path');

const router = express.Router();

router.use(session({
  secret: 'arel-secret-key-2026',
  resave: false,
  saveUninitialized: true
}));

const userJars = new Map();

// الأكواد السرية محفوظة في السيرفر فقط ولا تظهر للمستخدمين
const QR_CODES = {
  checkin: '570ac7ce-70e2-463a-8584-57917f6bc20d',
  checkout: '803609ec-0e8f-41c7-b4c3-3aad71b6543b'
};

function getClient(sessionId) {
  if (!userJars.has(sessionId)) {
    const jar = new CookieJar();
    const client = wrapper(axios.create({
      jar,
      withCredentials: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    }));
    userJars.set(sessionId, { client, jar });
  }
  return userJars.get(sessionId);
}

// توجيه تلقائي لإضافة (/) في نهاية الرابط لضمان عمل مسارات api النسبية
router.get('/', (req, res) => {
  if (!req.originalUrl.endsWith('/')) {
    return res.redirect(301, req.originalUrl + '/');
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 1. جلب الكابتشا
router.get('/arelim/api/captcha', async (req, res) => {
  try {
    userJars.delete(req.sessionID);
    const { client } = getClient(req.sessionID);

    const response = await client.get('https://arelim.arel.edu.tr/login/sign-in');
    const $ = cheerio.load(response.data);

    const captchaKey = $('#captcha_key').val();
    const captchaImg = $('img[alt="Captcha Image"]').attr('src');

    if (!captchaKey || !captchaImg) {
      return res.status(500).json({ success: false, message: 'فشل استخراج الكابتشا من موقع الجامعة' });
    }

    res.json({ success: true, captchaKey, captchaImg });
  } catch (error) {
    res.status(500).json({ success: false, message: 'خطأ في الاتصال بموقع الجامعة' });
  }
});

// 2. تسجيل الدخول
router.post('/api/login', async (req, res) => {
  try {
    const { username, password, captcha, captchaKey } = req.body;
    const { client } = getClient(req.sessionID);

    const payload = {
      data: {
        txt_usercode: username.replace(/\s/g, '').toLowerCase(),
        txt_userpass: password,
        txt_ipadress: '',
        captcha_key: captchaKey,
        captcha: String(captcha),
        kisiselverikvk: 'Y',
        txt_fcmtoken: ''
      }
    };

    const response = await client.post('https://arelim.arel.edu.tr/login/staff', payload, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Referer': 'https://arelim.arel.edu.tr/login/sign-in',
        'Origin': 'https://arelim.arel.edu.tr'
      }
    });

    const result = response.data;

    if (result.success === false) {
      return res.json({ success: false, message: result.mesajtxt || 'فشل تسجيل الدخول' });
    }

    req.session.isLoggedIn = true;
    req.session.userData = result.userdata[0];

    res.json({
      success: true,
      message: 'تم تسجيل الدخول بنجاح!',
      user: {
        usercode: result.userdata[0].usercode,
        name: result.userdata[0].adsoyad || result.userdata[0].usercode
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'حدث خطأ أثناء محاولة تسجيل الدخول' });
  }
});

// 3. تنفيذ كود الدخول أو الخروج (البوابة)
router.post('/api/action', async (req, res) => {
  try {
    if (!req.session.isLoggedIn) {
      return res.status(401).json({ success: false, message: 'انتهت الجلسة، يرجى تسجيل الدخول مجدداً' });
    }

    const { type } = req.body;
    const qrCode = QR_CODES[type];

    if (!qrCode) {
      return res.status(400).json({ success: false, message: 'نوع العملية غير صحيح' });
    }

    const { client } = getClient(req.sessionID);
    const targetUrl = `https://arelim.arel.edu.tr/qrcode/${qrCode}/Student`;

    const response = await client.get(targetUrl, {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://arelim.arel.edu.tr/student_dashboard'
      }
    });

    res.json({
      success: true,
      statusCode: response.status,
      data: response.data
    });

  } catch (error) {
    console.error('Action Error:', error.message);
    res.status(500).json({
      success: false,
      message: 'فشل تنفيذ العملية: ' + (error.response?.data?.message || error.message)
    });
  }
});

// 4. جلب قائمة القاعات الدراسية
router.get('/api/locations', async (req, res) => {
  try {
    if (!req.session.isLoggedIn) {
      return res.status(401).json({ success: false, message: 'انتهت الجلسة، يرجى تسجيل الدخول مجدداً' });
    }

    const { client } = getClient(req.sessionID);

    const response = await client.post('https://arelim.arel.edu.tr/api/restapi', {
      request: '13116',
      usercode: 'WebUser',
      data: {
        txt_lokasyon_id: '0'
      }
    }, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Referer': 'https://arelim.arel.edu.tr/tr/yoklamaqr',
        'Origin': 'https://arelim.arel.edu.tr'
      }
    });

    res.json(response.data);
  } catch (error) {
    res.status(500).json({ success: false, message: 'فشل جلب القاعات: ' + error.message });
  }
});

// 5. تسجيل حضور المحاضرة
router.post('/api/yoklama', async (req, res) => {
  try {
    if (!req.session.isLoggedIn || !req.session.userData) {
      return res.status(401).json({ success: false, message: 'انتهت الجلسة، يرجى تسجيل الدخول مجدداً' });
    }

    const { lokasyonId } = req.body;
    if (!lokasyonId) {
      return res.status(400).json({ success: false, message: 'يرجى اختيار القاعة أولاً' });
    }

    const usercode = String(req.session.userData.usercode);
    const { client } = getClient(req.sessionID);

    const qrRes = await client.post('https://arelim.arel.edu.tr/api/restapi', {
      request: '13116',
      usercode: 'WebUser',
      data: {
        txt_lokasyon_id: String(lokasyonId)
      }
    }, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Referer': 'https://arelim.arel.edu.tr/tr/yoklamaqr',
        'Origin': 'https://arelim.arel.edu.tr'
      }
    });

    const rows = qrRes.data?.rows;
    if (!rows || rows.length === 0 || !rows[0].karekod) {
      return res.status(400).json({ success: false, message: 'تعذر الحصول على رمز QR اللحظي لهذه القاعة' });
    }

    const liveQrCode = rows[0].karekod;

    const attendanceRes = await client.post('https://arelim.arel.edu.tr/api/restapi', {
      request: '8006',
      usercode: usercode,
      data: {
        txt_qrkod: liveQrCode,
        txt_ogrencino: usercode
      }
    }, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Referer': 'https://arelim.arel.edu.tr/student_dashboard',
        'Origin': 'https://arelim.arel.edu.tr'
      }
    });

    res.json({
      success: true,
      statusCode: attendanceRes.status,
      data: attendanceRes.data
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'فشل تسجيل الحضور: ' + (error.response?.data?.message || error.message)
    });
  }
});

module.exports = router;
