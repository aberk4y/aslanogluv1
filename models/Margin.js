const mongoose = require("mongoose");

const marginSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ["percent", "fixed"],
    default: "percent",
  },
  value: {
    type: Number,
    default: 0,
  },
});

module.exports = mongoose.model("Margin", marginSchema);