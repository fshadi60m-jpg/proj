const express = require("express");
const vm = require("vm");
const app = express();

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 1. استدعاء الملفات المحلية
const Sadeem = require("./Sadeem.js");
const FloraTv = require("./FloraTv.js");
const YTvPlus = require("./YTvPlus.js");

app.use("/sadeem", Sadeem);
app.use("/floratv", FloraTv);
app.use("/ytvplus", YTvPlus);

app.get("/", (req, res) => {
    res.json([]);
});

// 2. جلب الملف من الرابط وتشغيله مباشرة في الذاكرة
async function loadRemoteRoute() {
    try {
        const rawUrl = "https://raw.githubusercontent.com/ftvww-arch/yacienTv/main/yacintv.js";
        const response = await fetch(rawUrl);
        const code = await response.text();

        // تجهيز سياق الوحدة (Module Context)
        const module = { exports: {} };
        const context = vm.createContext({
            module,
            exports: module.exports,
            require,
            console,
            process,
            __filename,
            __dirname
        });

        // تنفيذ الكود القادم من الرابط
        const script = new vm.Script(code);
        script.runInContext(context);

        // ربطه بمسار /yacintv
        app.use("/yacintv", module.exports);
        console.log("✅ YacinTv loaded directly from URL");
    } catch (err) {
        console.error("❌ Failed to load remote script:", err.message);
    }

    app.listen(PORT, () => {
        console.log(`🚀 Main Server is running on port ${PORT}`);
    });
}

loadRemoteRoute();
