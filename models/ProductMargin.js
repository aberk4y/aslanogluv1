const mongoose = require("mongoose");

const productMarginSchema = new mongoose.Schema({
  product: { type: String, required: true, unique: true },

  buy_type: { type: String, enum: ["tl", "percent"], default: "tl" },
  buy_value: { type: Number, default: 0 },

  sell_type: { type: String, enum: ["tl", "percent"], default: "tl" },
  sell_value: { type: Number, default: 0 },
});

module.exports = mongoose.model("ProductMargin", productMarginSchema);