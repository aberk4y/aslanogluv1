const express = require("express");
const cors = require("cors");
const axios = require("axios");
const mongoose = require("mongoose");
require("dotenv").config();
const Margin = require("./models/Margin");
const app = express();
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const Admin = require("./models/Admin");
app.use(express.json());
app.use(
  cors({
    origin: true,
    credentials: true
  })
);

const PORT = process.env.PORT || 5000;

/* ---------------- MONGODB CONNECTION ---------------- */

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB bağlandı"))
  .catch((err) => console.log("❌ MongoDB hata:", err));

  mongoose.connection.once("open", async () => {
  const existing = await Margin.findOne();
  if (!existing) {
    await Margin.create({ type: "percent", value: 1 });
    console.log("🎯 Varsayılan %1 marj oluşturuldu");
  }
});

mongoose.connection.once("open", async () => {
  const existingAdmin = await Admin.findOne();

  if (!existingAdmin) {
    const hashedPassword = await bcrypt.hash("123456", 10);

    await Admin.create({
      username: "admin",
      password: hashedPassword,
    });

    console.log("🔐 Varsayılan admin oluşturuldu (admin / 123456)");
  }
});

const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader)
    return res.status(401).json({ message: "Token yok" });

  const token = authHeader.split(" ")[1];

  try {
    jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ message: "Token geçersiz" });
  }
};

/* ---------------- RAPID API ROUTE ---------------- */

app.get("/api/prices", async (req, res) => {
  try {
    const response = await axios.get(
      "https://harem-altin-live-gold-price-data.p.rapidapi.com/harem_altin/prices/23b4c2fb31a242d1eebc0df9b9b65e5e",
      {
        headers: {
          "X-RapidAPI-Key": process.env.RAPID_API_KEY,
          "X-RapidAPI-Host":
            "harem-altin-live-gold-price-data.p.rapidapi.com",
        },
      }
    );

    const margin = await Margin.findOne();

const updatedData = response.data.data.map((item) => {
  const sellPrice = parseFloat(
    item.sell.replace(/\./g, "").replace(",", ".")
  );

  let newSell;

  if (margin.type === "percent") {
    newSell = sellPrice + (sellPrice * margin.value) / 100;
  } else {
    newSell = sellPrice + margin.value;
  }

  return {
    ...item,
    sell_with_margin: newSell.toFixed(2),
  };
});

res.json({
  success: true,
  data: updatedData,
});
  } catch (error) {
    console.error("API HATA:", error.message);
    res.status(500).json({ error: "Fiyatlar alınamadı" });
  }
});


app.post("/api/margin", authMiddleware, async (req, res) => {
  try {
    const { type, value } = req.body;

    const margin = await Margin.findOne();
    margin.type = type;
    margin.value = value;
    await margin.save();

    res.json({ success: true, message: "Marj güncellendi", margin });
  } catch (error) {
    res.status(500).json({ error: "Marj güncellenemedi" });
  }
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;

  const admin = await Admin.findOne({ username });
  if (!admin) return res.status(400).json({ message: "Kullanıcı bulunamadı" });

  const isMatch = await bcrypt.compare(password, admin.password);
  if (!isMatch) return res.status(400).json({ message: "Şifre yanlış" });

  const token = jwt.sign(
    { id: admin._id },
    process.env.JWT_SECRET,
    { expiresIn: "1d" }
  );

  res.json({ token });
});




/* ---------------- SERVER START ---------------- */

app.listen(PORT, () => {
  console.log(`🚀 Server çalışıyor: http://localhost:${PORT}`);
});