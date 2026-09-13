const express = require("express");
const app = express();

// تحديد المنفذ (Port) - المنصة ستضع المنفذ الخاص بها هنا، أو سيعمل على 3000 محلياً
const PORT = process.env.PORT || 3000;

// إعدادات أساسية لتمكين السيرفر من قراءة البيانات المرسلة بصيغة JSON
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================================
// 1. استدعاء ملفات الـ APIs الخاصة بك بالأسماء الجديدة
// ==========================================
const Sadeem = require("./Sadeem.js");
const FloraTv = require("./FloraTv.js");
const YTvPlus = require("./YTvPlus.js");

// ==========================================
// 2. ربط الملفات بمسارات محددة (Routing)
// ==========================================
// مسارات Sadeem (توب سينما سابقاً) ستكون مسبوقة بـ /sadeem
app.use("/sadeem", Sadeem);

// مسارات FloraTv (لاروزا سابقاً) ستكون مسبوقة بـ /floratv
app.use("/floratv", FloraTv);

// مسارات YTvPlus (دراما لايف سابقاً) ستكون مسبوقة بـ /ytvplus
app.use("/ytvplus", YTvPlus);

// ==========================================
// 3. مسار رئيسي لفحص حالة السيرفر (Health Check)
// مهم لتعرف أن السيرفر يعمل ولتتأكد منصة الاستضافة من نجاح التشغيل
// ==========================================
app.get("/", (req, res) => {
    res.json({
        status: "success",
        message: "Server is running perfectly!",
        endpoints: {
            sadeem_api: "/sadeem",
            floratv_api: "/floratv",
            ytvplus_api: "/ytvplus"
        }
    });
});


// ==========================================
// 4. تشغيل الخادم
// ==========================================
app.listen(PORT, () => {
    console.log(`🚀 Main Server is running on port ${PORT}`);
});
