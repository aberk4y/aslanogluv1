const express = require("express");
const cors = require("cors");
const axios = require("axios");
const mongoose = require("mongoose");
require("dotenv").config();

const Margin = require("./models/Margin");
const ProductMargin = require("./models/ProductMargin");
const Admin = require("./models/Admin");

const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

const app = express();

app.use(express.json());

app.use(
  cors({
    origin: true,
    credentials: true,
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
    console.log("🎯 Varsayılan %1 global marj oluşturuldu");
  }

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

/* ---------------- AUTH ---------------- */

const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader)
    return res.status(401).json({ message: "Token yok" });

  const token = authHeader.split(" ")[1];

  try {
    jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ message: "Token geçersiz" });
  }
};

/* ---------------- HELPER ---------------- */

function parsePrice(value) {
  if (!value) return 0;

  return parseFloat(
    value.toString().replace(/\./g, "").replace(",", ".")
  );
}

/* ---------------- PRICES API ---------------- */

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

    const globalMargin = await Margin.findOne();
    const productMargins = await ProductMargin.find();

    const updatedData = response.data.data.map((item) => {
      const buyPrice = parsePrice(item.buy);
      const sellPrice = parsePrice(item.sell);

      const productMargin = productMargins.find(
        (m) => m.product === item.key
      );

      let finalBuy = buyPrice;
      let finalSell = sellPrice;

      /* -------- ÜRÜNE ÖZEL MARJ -------- */
      if (productMargin) {

        // BUY
        if (productMargin.buy_type === "percent") {
          finalBuy =
            buyPrice + (buyPrice * productMargin.buy_value) / 100;
        } else {
          finalBuy = buyPrice + productMargin.buy_value;
        }

        // SELL
        if (productMargin.sell_type === "percent") {
          finalSell =
            sellPrice + (sellPrice * productMargin.sell_value) / 100;
        } else {
          finalSell = sellPrice + productMargin.sell_value;
        }

      }

      /* -------- GLOBAL FALLBACK (SELL ONLY) -------- */
      else if (globalMargin) {

        if (globalMargin.type === "percent") {
          finalSell =
            sellPrice + (sellPrice * globalMargin.value) / 100;
        } else {
          finalSell = sellPrice + globalMargin.value;
        }
      }

      return {
        ...item,
        buy_with_margin: finalBuy.toFixed(2),
        sell_with_margin: finalSell.toFixed(2),
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

/* ---------------- GLOBAL MARGIN ---------------- */

app.post("/api/margin", authMiddleware, async (req, res) => {
  try {
    const { type, value } = req.body;

    if (value === undefined)
      return res.status(400).json({ error: "Value gerekli" });

    const margin = await Margin.findOne();

    margin.type = type;
    margin.value = Number(value);

    await margin.save();

    res.json({
      success: true,
      message: "Global marj güncellendi",
      margin,
    });
  } catch {
    res.status(500).json({ error: "Marj güncellenemedi" });
  }
});

/* ---------------- PRODUCT MARGIN ---------------- */

app.post("/api/product-margin", authMiddleware, async (req, res) => {
  try {
    const {
      product,
      buy_type,
      buy_value,
      sell_type,
      sell_value,
    } = req.body;

    if (!product)
      return res.status(400).json({ error: "Ürün adı gerekli" });

    let existing = await ProductMargin.findOne({ product });

    if (existing) {
      existing.buy_type = buy_type;
      existing.buy_value = Number(buy_value || 0);
      existing.sell_type = sell_type;
      existing.sell_value = Number(sell_value || 0);
      await existing.save();
    } else {
      await ProductMargin.create({
        product,
        buy_type,
        buy_value: Number(buy_value || 0),
        sell_type,
        sell_value: Number(sell_value || 0),
      });
    }

    res.json({
      success: true,
      message: "Ürün marjı güncellendi",
    });

  } catch {
    res.status(500).json({ error: "Ürün marjı güncellenemedi" });
  }
});


app.get("/api/product-margin", authMiddleware, async (req, res) => {
  try {
    const margins = await ProductMargin.find();
    res.json(margins);
  } catch (error) {
    res.status(500).json({ error: "Ürün marjları alınamadı" });
  }
});

/* ---------------- LOGIN ---------------- */

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;

  const admin = await Admin.findOne({ username });
  if (!admin)
    return res.status(400).json({ message: "Kullanıcı bulunamadı" });

  const isMatch = await bcrypt.compare(password, admin.password);
  if (!isMatch)
    return res.status(400).json({ message: "Şifre yanlış" });

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