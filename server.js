import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import OpenAI from "openai";

// ======================================================
// Hawa Co Booking Bot - Server (ESM + OpenAI + Make)
// ======================================================

dotenv.config();


const app = express();
app.use(cors());
app.use(express.json());

// ------------ إعداد OpenAI (مفتاح من ملف .env) ------------
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// ------------ Webhook بتاع Make ------------
const MAKE_WEBHOOK_URL =
    "https://hook.eu2.make.com/pyh4mn7phqis5liyl4u8fysgphvj9klj";

// ------------ تخزين السيشن فى الرام ------------
const sessions = {};

// ------------ مساعدات عامة ------------
const allowedBrands = [
    "ابو حوا", "أبو حوا",
    "دايون", "dayun",
    "هوجان", "hogan",
    "بنلي", "benelli",
    "كي واي", "كيوى", "keeway", "keway",
    "فيجورى", "vigory",
    "زونتيس", "zontes", "زانتوس",
    "cmg", "سي ام جي",
    "تايجر", "tiger",
    "تروسكل", "تروسيكل", "tricycle"
];

function isAllowedBike(text = "") {
    const lower = text.toLowerCase();
    return allowedBrands.some((brand) =>
        lower.includes(brand.toLowerCase())
    );
}

function getSession(id) {
    if (!sessions[id]) {
        sessions[id] = { step: null, data: {} };
    }
    return sessions[id];
}

function isValidFullName(name = "") {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    return parts.length >= 3; // لازم ثلاثي أو أكتر
}

function normalize(t = "") {
    return t.trim().toLowerCase();
}

// ======================================================
// دالة تستخدم OpenAI للتحقق من المحافظة والحي
// ======================================================
async function checkAddressWithAI(governorate, district) {
    const prompt = `
انت مساعد خبير فى عناوين جمهورية مصر العربية.
المطلوب:

- تستقبل محافظة وحي/منطقة كما كتبهم العميل.
- تصحح الأخطاء الإملائية البسيطة.
- تحدد هل الحي تابع فعلاً للمحافظة أم لا (حسب أفضل معرفة لديك).
- ترجع النتيجة فى JSON "سطر واحد" فقط بالشكل التالي (بدون أى كلام إضافى):

{"normalized_governorate": "اسم المحافظة بعد التصحيح", "normalized_district": "اسم الحي بعد التصحيح", "is_match": true أو false, "note": "توضيح قصير بالعربي"}

المحافظة: ${governorate}
الحي: ${district}
`;

    try {
        const response = await openai.responses.create({
            model: "gpt-4.1-mini",
            input: prompt
        });

        const text = response.output[0].content[0].text.trim();
        const result = JSON.parse(text);
        return result;
    } catch (err) {
        console.error("OPENAI ADDRESS CHECK ERROR:", err);
        return null; // لو حصل خطأ، نكمّل عادي من غير ما نوقف الحجز
    }
}

// ======================================================
// Chat endpoint
// ======================================================
app.post("/chat", async (req, res) => {
    try {
        const { sessionId, message } = req.body;

        if (!sessionId || typeof message !== "string") {
            return res.status(400).json({ reply: "خطأ في البيانات.", done: false });
        }

        const session = getSession(sessionId);
        const text = message.trim();
        let reply = "";
        let done = false;

        // ---- بداية المحادثة من الفرونت ----
        // الفرونت بيبعت "__start__" أول ما الصفحة تفتح
        // هنا بس بنظبط الstep من غير ما نرجع رسالة (الترحيب من الـ HTML)
        if (text === "__start__") {
            session.step = "askName";
            return res.json({ reply: "", done: false });
        }

        if (!session.step) {
            session.step = "askName";
        }

        // لو الحجز خلص قبل كده
        if (session.step === "finished") {
            return res.json({
                reply:
                    "طلبك مسجّل بالفعل ✔️\n" +
                    "فريق المبيعات هيتم التواصل معاك خلال 24 ساعة عمل.",
                done: true
            });
        }

        // ======================================================
        // Conversation flow
        // ======================================================
        switch (session.step) {
            // 1) الاسم الثلاثي (مرة واحدة بس)
            case "askName": {
                if (!isValidFullName(text)) {
                    reply =
                        "من فضلك اكتب اسمك *الثلاثي* (الاسم + اسم الأب + اسم العائلة).\n" +
                        "مثال: أحمد محمد علي.";
                    break;
                }
                session.data.name = text;
                session.step = "askAge";
                reply = `تشرفنا يا ${text} 🙏\nكام سنك؟`;
                break;
            }

            // 2) السن
            case "askAge": {
                session.data.age = text;
                session.step = "askPhone";
                reply = "تمام 👌\nاكتب رقم الموبايل للتواصل.";
                break;
            }

            // 3) رقم الموبايل
            case "askPhone": {
                session.data.phone = text;
                session.step = "askWhatsapp";
                reply =
                    "تمام ✔️\nلو واتساب نفس الرقم اكتب (نفس الرقم)\nولو مختلف اكتبه.";
                break;
            }

            // 4) الواتساب
            case "askWhatsapp": {
                const norm = normalize(text);
                if (
                    norm === "نفس الرقم" ||
                    norm === "نفس" ||
                    norm === "هو" ||
                    norm === "نفسه"
                ) {
                    session.data.whatsapp = session.data.phone;
                } else {
                    session.data.whatsapp = text;
                }

                session.step = "askGovernorate";
                reply = "تمام.\nاكتب *المحافظة* (مثال: الجيزة – القاهرة – الإسكندرية).";
                break;
            }

            // 5) المحافظة
            case "askGovernorate": {
                session.data.governorate = text;
                session.step = "askDistrict";
                reply =
                    "تمام 👌\nاكتب اسم *الحي أو المنطقة* (مثال: الهرم – شبرا – سموحة).\n" +
                    "ولو لقيت إن المحافظة اللي كتبتها غلط بعدين، اكتب: (تغيير المحافظة).";
                break;
            }

            // 6) الحي + التحقق عن طريق OpenAI
            case "askDistrict": {
                const norm = normalize(text);

                // لو العميل كتب تغيير المحافظة
                if (norm === normalize("تغيير المحافظة")) {
                    session.step = "askGovernorate";
                    reply = "اكتب المحافظة الصحيحة (مثال: الجيزة – القاهرة – الإسكندرية).";
                    break;
                }

                session.data.district = text;

                const aiCheck = await checkAddressWithAI(
                    session.data.governorate,
                    session.data.district
                );

                if (aiCheck && aiCheck.normalized_governorate && aiCheck.normalized_district) {
                    session.data.governorate = aiCheck.normalized_governorate;
                    session.data.district = aiCheck.normalized_district;
                }

                if (aiCheck && aiCheck.is_match === false) {
                    reply =
                        `فيه تعارض بين المحافظة والحي حسب قاعدة البيانات:\n` +
                        `المحافظة: ${session.data.governorate}\n` +
                        `الحي: ${session.data.district}\n` +
                        `ملاحظة: ${aiCheck.note || "من فضلك راجع العنوان."}\n\n` +
                        `لو المحافظة غلط اكتب: (تغيير المحافظة)\n` +
                        `لو الحي غلط، اكتب الحي الصحيح تاني تابع للمحافظة.`;
                    break;
                }

                session.step = "askBike";
                reply =
                    "جميل.\n" +
                    "دلوقتي اكتب نوع الموتسيكل اللي عايز تحجزه 🏍️\n" +
                    "◀️ الحجز متاح لأصناف أبو حوا فقط (دايون – هوجان – Zontes – CMG Tiger – بنلي – Keeway – Vigory...).";
                break;
            }

            // 7) نوع الموتسيكل
            case "askBike": {
                if (!isAllowedBike(text)) {
                    reply =
                        "الموتسيكل اللي كتبته مش من أصناف أبو حوا ❌\n" +
                        "اختار نوع من: دايون – هوجان – Zontes – CMG Tiger – بنلي – Keeway – Vigory.\n" +
                        "اكتب النوع تاني.";
                    break;
                }

                session.data.bikeModel = text;
                session.step = "askPayment";
                reply = "تمام ✔️\nطريقة الشراء: كاش ولا قسط؟";
                break;
            }

            // 8) طريقة الدفع (لو قسط نسأل عن المقدم)
            case "askPayment": {
                session.data.paymentMethod = text;
                const norm = normalize(text);

                if (norm.includes("قسط") || norm.includes("تقسيط")) {
                    session.step = "askDownPayment";
                    reply =
                        "تمام، نظام قسط 💳\nتحب تدفع *مقدم كام تقريبًا*؟ اكتب المبلغ بالجنيه.";
                } else {
                    session.step = "askContactTime";
                    reply = "تمام.\nإمتى أنسب وقت نكلمك فيه؟";
                }
                break;
            }

            // 9) المقدم في حالة القسط
            case "askDownPayment": {
                session.data.downPayment = text;
                session.step = "askContactTime";
                reply = "تمام.\nإمتى أنسب وقت نكلمك فيه للتأكيد على الحجز؟";
                break;
            }

            // 10) وقت التواصل → ملخص + Webhook + إنهاء
            case "askContactTime": {
                session.data.contactTime = text;

                const d = {
                    source: "hawa-co-bot",
                    sessionId,
                    ...session.data,
                    createdAt: new Date().toISOString()
                };

                let summary =
                    "📋 **ملخص الحجز:**\n" +
                    `• الاسم: ${d.name}\n` +
                    `• السن: ${d.age}\n` +
                    `• الموبايل: ${d.phone}\n` +
                    `• واتساب: ${d.whatsapp}\n` +
                    `• المحافظة: ${d.governorate}\n` +
                    `• الحي/المنطقة: ${d.district}\n` +
                    `• الموتسيكل: ${d.bikeModel}\n` +
                    `• طريقة الشراء: ${d.paymentMethod}\n`;

                if (d.downPayment) {
                    summary += `• المقدم المتوقع: ${d.downPayment}\n`;
                }

                summary += `• وقت التواصل المناسب: ${d.contactTime}\n\n`;

                reply = summary + "جارٍ تسجيل الطلب… لحظة واحدة ⏳";

                // إرسال للويب هوك
                try {
                    await fetch(MAKE_WEBHOOK_URL, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(d)
                    });

                    reply +=
                        "\n\n🎉 تم إرسال الطلب بنجاح.\n" +
                        "فريق المبيعات هيتم التواصل معاك خلال 24 ساعة عمل.";
                } catch (err) {
                    console.error("WEBHOOK ERROR:", err);
                    reply +=
                        "\n\n⚠️ حصلت مشكلة أثناء الإرسال.\n" +
                        "لكن بياناتك محفوظة وهنتابع يدويًا.";
                }

                session.step = "finished";
                done = true;
                break;
            }

            default: {
                reply =
                    "في حاجة مش واضحة… هنرجع من الأول.\n" +
                    "من فضلك اكتب اسمك الثلاثي.";
                session.step = "askName";
                break;
            }
        }

        res.json({ reply, done });
    } catch (err) {
        console.error("SERVER ERROR:", err);
        res.status(500).json({
            reply: "خطأ داخلي في السيرفر.",
            done: false
        });
    }
});
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// نديه الـ public عشان يقدم الهوا كو بوت
app.use(express.static(path.join(__dirname, "public")));

// ======================================================
// تشغيل السيرفر
// ======================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Hawa Co Bot running at http://localhost:${PORT}`);
});
