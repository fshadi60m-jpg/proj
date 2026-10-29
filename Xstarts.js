const express = require("express");
const cors = require("cors");
const app = express();

const PORT = process.env.PORT || 3000;

// إعدادات أساسية لعمل السيرفر خلف Nginx أو Cloudflare
app.set('trust proxy', 1);
app.use(cors());

// إعدادات لتمكين السيرفر من قراءة البيانات JSON
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================================
// 1. استدعاء ملفات الـ APIs والمشغل
// ==========================================
const Sadeem = require("./Sadeem.js");
const FloraTv = require("./FloraTv.js");
const YTvPlus = require("./YTvPlus.js");
const YouTube = require("./YouTube.js");
const WebApi = require("./web_api.js"); // <--- هذا هو ملف المشغل الجديد

// ==========================================
// 2. ربط الملفات بمسارات محددة (Routing)
// ==========================================
app.use("/sadeem", Sadeem);
app.use("/floratv", FloraTv);
app.use("/ytvplus", YTvPlus);
app.use("/youtube", YouTube);

// مسار المشغل الجديد سيكون مسبوقاً بـ /web
// (مثال: لدخول المشغل سيكون الرابط موقعك/web/m?v=...)
app.use("/web", WebApi); 

// ==========================================
// 3. مسار رئيسي لفحص حالة السيرفر
// ==========================================
app.get("/", (req, res) => {
    res.json({ status: "ok", message: "Server is running perfectly" });
});

// ==========================================
// 4. تشغيل الخادم
// ==========================================
app.listen(PORT, () => {
    console.log(`🚀 Main Server is running on port ${PORT}`);
});
