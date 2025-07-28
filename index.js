const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId, ServerApiVersion } = require("mongodb");
const admin = require("firebase-admin");
const dotenv = require("dotenv");
const jwt = require("jsonwebtoken");

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

// ✅ Root Endpoint
app.get("/", (req, res) => {
  res.send("PulsePoint Server is Running ✅");
});

module.exports = app;
module.exports.handler = serverless(app);
