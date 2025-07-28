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

// Firebase Admin Setup
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FB_SERVICE_KEY)),
  });
}

// MongoDB Setup
const uri = process.env.MONGO_URI;
const client = new MongoClient(uri, {
  serverApi: ServerApiVersion.v1,
});
let usersCollection;
let donationRequestsCollection;
let fundingCollection;
let blogsCollection;

async function connectDb() {
  try {
    await client.connect();
    const db = client.db("PulsePoint");
    usersCollection = db.collection("Users");
    donationRequestsCollection = db.collection("donationRequests");
    fundingCollection = db.collection("Fundings");
    blogsCollection = db.collection("Blogs");
    console.log("MongoDB connected.");
  } catch (err) {
    console.error("DB Connection Error:", err);
  }
}
connectDb();

// ✅ Save/Register User
app.post("/users", async (req, res) => {
  const user = req.body;
  const existing = await usersCollection.findOne({ email: user.email });
  if (!existing) {
    user.role = "donor";
    user.status = "active";
    const result = await usersCollection.insertOne(user);
    res.send(result);
  } else {
    res.send({ message: "User already exists" });
  }
});

// ✅ Root Endpoint
app.get("/", (req, res) => {
  res.send("PulsePoint Server is Running ✅");
});

module.exports = app;
module.exports.handler = serverless(app);
