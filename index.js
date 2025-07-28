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

// ✅ Get All Users (Admin)
app.get("/users", verifyJWT, async (req, res) => {
  const users = await usersCollection.find().toArray();
  res.send(users);
});

// ✅ Update User Role or Status
app.patch("/users/:id", verifyJWT, async (req, res) => {
  const { id } = req.params;
  const update = req.body; // e.g. { role: 'admin' } or { status: 'blocked' }
  const result = await usersCollection.updateOne(
    { _id: new ObjectId(id) },
    { $set: update }
  );
  res.send(result);
});

// ✅ Get Logged-In User Info
app.get("/users/:email", verifyJWT, async (req, res) => {
  const email = req.params.email;
  const user = await usersCollection.findOne({ email });
  res.send(user);
});

// ✅ Create Donation Request
app.post("/donation-requests", verifyJWT, async (req, res) => {
  const request = req.body;
  request.status = "pending";
  const result = await donationRequestsCollection.insertOne(request);
  res.send(result);
});

// ✅ Get All Donation Requests (Admin/Volunteer)
app.get("/donation-requests", async (req, res) => {
  const status = req.query.status;
  const filter = status ? { status } : {};
  const result = await donationRequestsCollection.find(filter).toArray();
  res.send(result);
});

// ✅ Get My Donation Requests (Donor)
app.get("/donation-requests/user/:email", verifyJWT, async (req, res) => {
  const result = await donationRequestsCollection
    .find({ "requester.email": req.params.email })
    .toArray();
  res.send(result);
});

// ✅ Update Donation Request
app.patch("/donation-requests/:id", verifyJWT, async (req, res) => {
  const { id } = req.params;
  const update = req.body;
  const result = await donationRequestsCollection.updateOne(
    { _id: new ObjectId(id) },
    { $set: update }
  );
  res.send(result);
});

// ✅ Delete Donation Request
app.delete("/donation-requests/:id", verifyJWT, async (req, res) => {
  const result = await donationRequestsCollection.deleteOne({
    _id: new ObjectId(req.params.id),
  });
  res.send(result);
});

// ✅ Root Endpoint
app.get("/", (req, res) => {
  res.send("PulsePoint Server is Running ✅");
});

module.exports = app;
module.exports.handler = serverless(app);
