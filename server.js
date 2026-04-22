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

const PORT = process.env.PORT || 5000;
const PRICE_CACHE_TTL_MS = Number(process.env.PRICE_CACHE_TTL_MS || 60 * 1000);
const CURRENCY_CACHE_TTL_MS = Number(
  process.env.CURRENCY_CACHE_TTL_MS || 8 * 60 * 60 * 1000
);

const GOLD_API_URL =
  "https://harem-altin-live-gold-price-data.p.rapidapi.com/harem_altin/prices/23b4c2fb31a242d1eebc0df9b9b65e5e";

const allowedProducts = [
  "Has Altın",
  "GRAM ALTIN",
  "ESKİ ÇEYREK",
  "ESKİ TAM",
  "ESKİ YARIM",
  "ESKİ ATA",
  "ESKİ ATA5",
  "ESKİ GREMSE",
  "14 AYAR",
  "22 AYAR",
  "YENİ ÇEYREK",
  "YENİ YARIM",
  "YENİ TAM",
  "YENİ ATA",
  "YENİ ATA5",
  "YENİ GREMSE",
];

let priceCache = null;
let rawPriceCache = null;
let lastPriceUpdate = null;

let currencyCache = null;
let lastCurrencyUpdate = null;

app.use(express.json());
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB baglandi"))
  .catch((err) => console.log("MongoDB hata:", err));

mongoose.connection.once("open", async () => {
  const existingMargin = await Margin.findOne();
  if (!existingMargin) {
    await Margin.create({ type: "percent", value: 1 });
    console.log("Varsayilan global marj olusturuldu");
  }

  const existingAdmin = await Admin.findOne();
  if (!existingAdmin) {
    const hashedPassword = await bcrypt.hash("123456", 10);
    await Admin.create({
      username: "admin",
      password: hashedPassword,
    });
    console.log("Varsayilan admin olusturuldu");
  }
});

const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ message: "Token yok" });
  }

  const token = authHeader.split(" ")[1];

  try {
    jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ message: "Token gecersiz" });
  }
};

function parsePrice(value) {
  if (!value) {
    return 0;
  }

  return parseFloat(value.toString().replace(/\./g, "").replace(",", "."));
}

function isCacheFresh(lastUpdate, ttlMs) {
  if (!lastUpdate) {
    return false;
  }

  return Date.now() - new Date(lastUpdate).getTime() < ttlMs;
}

function getRapidApiHeaders() {
  return {
    "X-RapidAPI-Key": process.env.RAPID_API_KEY,
    "X-RapidAPI-Host":
      "harem-altin-live-gold-price-data.p.rapidapi.com",
  };
}

function getErrorDetails(error) {
  return error.response?.data || error.message;
}

async function fetchGoldPricesFromProvider() {
  const response = await axios.get(GOLD_API_URL, {
    headers: getRapidApiHeaders(),
  });

  return response.data.data || [];
}

async function buildGoldPricePayload(apiProducts) {
  const globalMargin = await Margin.findOne();
  const productMargins = await ProductMargin.find();

  const filteredProducts = apiProducts.filter((item) =>
  allowedProducts.includes(item.key)
);

  return filteredProducts.map((item) => {
    const buyPrice = parsePrice(item.buy);
    const sellPrice = parsePrice(item.sell);

    const productMargin = productMargins.find(
      (margin) => margin.product === item.key
    );

    let finalBuy = buyPrice;
    let finalSell = sellPrice;

    if (productMargin) {
      if (productMargin.buy_type === "percent") {
        finalBuy = buyPrice + (buyPrice * productMargin.buy_value) / 100;
      } else {
        finalBuy = buyPrice + productMargin.buy_value;
      }

      if (productMargin.sell_type === "percent") {
        finalSell = sellPrice + (sellPrice * productMargin.sell_value) / 100;
      } else {
        finalSell = sellPrice + productMargin.sell_value;
      }
    } else if (globalMargin) {
      if (globalMargin.type === "percent") {
        finalSell = sellPrice + (sellPrice * globalMargin.value) / 100;
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
}

async function refreshGoldPriceCache() {
  const apiProducts = await fetchGoldPricesFromProvider();
  const payload = await buildGoldPricePayload(apiProducts);

  rawPriceCache = apiProducts;
  priceCache = payload;
  lastPriceUpdate = new Date();

  return payload;
}

async function updateCurrencyRates() {
  try {
    const response = await axios.get("https://api.exchangerate.host/live", {
      params: {
        access_key: process.env.EXCHANGE_API_KEY,
        source: "TRY",
        currencies: "USD,EUR,GBP",
      },
    });

    const quotes = response.data.quotes;

    const usd = 1 / quotes.TRYUSD;
    const eur = 1 / quotes.TRYEUR;
    const gbp = 1 / quotes.TRYGBP;

    currencyCache = [
      {
        code: "USD",
        buy: (usd - 0.02).toFixed(4),
        sell: (usd + 0.02).toFixed(4),
      },
      {
        code: "EUR",
        buy: (eur - 0.02).toFixed(4),
        sell: (eur + 0.02).toFixed(4),
      },
      {
        code: "GBP",
        buy: (gbp - 0.02).toFixed(4),
        sell: (gbp + 0.02).toFixed(4),
      },
    ];

    lastCurrencyUpdate = new Date();
    console.log("Currency cache updated");

    return currencyCache;
  } catch (error) {
    console.log("Currency API ERROR:", getErrorDetails(error));
    return null;
  }
}

app.get("/api/prices", async (req, res) => {
  if (priceCache && isCacheFresh(lastPriceUpdate, PRICE_CACHE_TTL_MS)) {
    return res.json({
      success: true,
      stale: false,
      source: "cache",
      last_update: lastPriceUpdate,
      data: priceCache,
    });
  }

  try {
    const payload = await refreshGoldPriceCache();

    return res.json({
      success: true,
      stale: false,
      source: "provider",
      last_update: lastPriceUpdate,
      data: payload,
    });
  } catch (error) {
    console.error("PRICE API ERROR:", getErrorDetails(error));

    if (priceCache) {
      return res.json({
        success: true,
        stale: true,
        source: "stale_cache",
        last_update: lastPriceUpdate,
        message: "Canli fiyat alinamadi, son cache donuldu.",
        data: priceCache,
      });
    }

    return res.status(500).json({
      success: false,
      error: "Fiyatlar alinamadi",
      data: [],
    });
  }
});

app.post("/api/margin", authMiddleware, async (req, res) => {
  try {
    const { type, value } = req.body;

    if (value === undefined) {
      return res.status(400).json({ error: "Value gerekli" });
    }

    const margin = await Margin.findOne();
    margin.type = type;
    margin.value = Number(value);

    await margin.save();

    priceCache = null;

    res.json({
      success: true,
      message: "Global marj guncellendi",
      margin,
    });
  } catch {
    res.status(500).json({ error: "Marj guncellenemedi" });
  }
});

app.post("/api/product-margin", authMiddleware, async (req, res) => {
  try {
    const {
      product,
      buy_type,
      buy_value,
      sell_type,
      sell_value,
    } = req.body;

    if (!product) {
      return res.status(400).json({ error: "Urun adi gerekli" });
    }

    const existing = await ProductMargin.findOne({ product });

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

    priceCache = null;

    res.json({
      success: true,
      message: "Urun marji guncellendi",
    });
  } catch {
    res.status(500).json({ error: "Urun marji guncellenemedi" });
  }
});

app.get("/api/product-margin", authMiddleware, async (req, res) => {
  try {
    let apiProducts = rawPriceCache;

    if (!apiProducts) {
      apiProducts = await fetchGoldPricesFromProvider();
      rawPriceCache = apiProducts;
    }

    const dbMargins = await ProductMargin.find();

    const merged = apiProducts.map((item) => {
      const existing = dbMargins.find((margin) => margin.product === item.key);

      return {
        product: item.key,
        buy_type: existing?.buy_type || "tl",
        buy_value: existing?.buy_value || 0,
        sell_type: existing?.sell_type || "tl",
        sell_value: existing?.sell_value || 0,
      };
    });

    res.json(merged);
  } catch (error) {
    console.error("GET PRODUCT MARGIN ERROR:", getErrorDetails(error));
    res.status(500).json({ error: "Urunler alinamadi" });
  }
});

app.get("/api/currency", async (req, res) => {
  if (!currencyCache || !isCacheFresh(lastCurrencyUpdate, CURRENCY_CACHE_TTL_MS)) {
    await updateCurrencyRates();
  }

  if (!currencyCache) {
    return res.status(500).json({
      success: false,
      error: "Doviz verileri alinamadi",
      data: [],
    });
  }

  res.json({
    success: true,
    stale: !isCacheFresh(lastCurrencyUpdate, CURRENCY_CACHE_TTL_MS),
    last_update: lastCurrencyUpdate,
    data: currencyCache,
  });
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;

  const admin = await Admin.findOne({ username });

  if (!admin) {
    return res.status(400).json({ message: "Kullanici bulunamadi" });
  }

  const isMatch = await bcrypt.compare(password, admin.password);

  if (!isMatch) {
    return res.status(400).json({ message: "Sifre yanlis" });
  }

  const token = jwt.sign(
    { id: admin._id },
    process.env.JWT_SECRET,
    { expiresIn: "1d" }
  );

  res.json({ token });
});

app.listen(PORT, () => {
  console.log(`Server calisiyor: http://localhost:${PORT}`);

  updateCurrencyRates();

  setInterval(updateCurrencyRates, CURRENCY_CACHE_TTL_MS);
});
