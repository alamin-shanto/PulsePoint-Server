const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId, ServerApiVersion } = require("mongodb");
const admin = require("firebase-admin");
const dotenv = require("dotenv");
const jwt = require("jsonwebtoken");
const serverlessHttp = require("serverless-http");
const Stripe = require("stripe");

dotenv.config();

const stripe = Stripe(process.env.STRIPE_SECRET);
const app = express();

app.use(
  cors({
    origin: ["http://localhost:5173", "https://pulsepoint-seven.netlify.app"],
    credentials: true,
  })
);
app.use(express.json());

app.use((req, res, next) => {
  console.log(
    `${req.method} ${req.url} - Auth: ${req.headers.authorization || "none"}`
  );
  next();
});

// Firebase Admin Setup
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(
        Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString("utf8")
      )
    ),
  });
  console.log("✅ Firebase Admin initialized.");
}

// MongoDB Setup
let cachedClient = null;
let cachedDb = null;

async function connectDb() {
  if (cachedDb) return { db: cachedDb };

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("❌ MONGODB_URI not set");

  const client = new MongoClient(uri, { serverApi: ServerApiVersion.v1 });
  await client.connect();

  const db = client.db("PulsePoint");
  cachedClient = client;
  cachedDb = db;

  console.log("✅ MongoDB connected");
  return { db };
}

connectDb();

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function verifyJWT(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).send({ message: "Unauthorized" });

  const token = authHeader.split(" ")[1];
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).send({ message: "Forbidden" });
    req.decoded = decoded;
    next();
  });
}

function verifyRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.decoded.role)) {
      return res.status(403).send({ message: "Forbidden: Insufficient role" });
    }
    next();
  };
}

// JWT Generation
app.post(
  "/jwt",
  asyncHandler(async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer "))
      return res.status(401).send({ message: "Unauthorized" });

    const idToken = authHeader.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);

    const { db } = await connectDb();
    const user = await db.collection("Users").findOne({ email: decoded.email });

    const payload = {
      email: decoded.email,
      uid: decoded.uid,
      name: user?.name || "",
      role: user?.role || "donor",
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    res.send({ token });
  })
);

// Register User
app.post(
  "/users",
  asyncHandler(async (req, res) => {
    const user = req.body;
    if (!user?.email)
      return res.status(400).json({ message: "Email is required" });

    const { db } = await connectDb();
    const usersCollection = db.collection("Users");

    const existing = await usersCollection.findOne({ email: user.email });
    if (existing)
      return res.status(409).json({ message: "User already exists" });

    user.role = "donor";
    user.status = "active";

    const result = await usersCollection.insertOne(user);
    res.status(201).send(result);
  })
);

// Get Current User Info
app.get(
  "/users/:email",
  verifyJWT,
  asyncHandler(async (req, res) => {
    const { email } = req.params;
    const { db } = await connectDb();
    const user = await db.collection("Users").findOne({ email });
    res.send(user);
  })
);

// Admin: Get All Users
app.get(
  "/users",
  verifyJWT,
  verifyRole("admin"),
  asyncHandler(async (req, res) => {
    const { db } = await connectDb();
    const users = await db.collection("Users").find().toArray();
    res.send(users);
  })
);

// Admin: Update User Role/Status
app.patch(
  "/users/:id",
  verifyJWT,
  verifyRole("admin"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const update = req.body;
    const { db } = await connectDb();
    const result = await db
      .collection("Users")
      .updateOne({ _id: new ObjectId(id) }, { $set: update });
    res.send(result);
  })
);

// Update user by email
app.patch(
  "/users/email/:email",
  verifyJWT,
  asyncHandler(async (req, res) => {
    const { email } = req.params;
    const update = req.body;
    const { db } = await connectDb();

    const result = await db
      .collection("Users")
      .updateOne({ email }, { $set: update });

    res.send(result);
  })
);

app.patch("/users/:id/status", verifyJWT, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const result = await usersCollection.updateOne(
    { _id: new ObjectId(id) },
    { $set: { status } }
  );
  res.send(result);
});

app.patch("/users/:id/role", verifyJWT, async (req, res) => {
  const { id } = req.params;
  const { role } = req.body;
  const result = await usersCollection.updateOne(
    { _id: new ObjectId(id) },
    { $set: { role } }
  );
  res.send(result);
});

// Donor: Create Request
app.post(
  "/donation-requests",
  verifyJWT,
  verifyRole("donor"),
  asyncHandler(async (req, res) => {
    const request = req.body;
    request.status = "pending";
    const { db } = await connectDb();
    const result = await db.collection("donationRequests").insertOne(request);
    res.status(201).send(result);
  })
);

// Public: Get Requests
app.get(
  "/donation-requests",
  asyncHandler(async (req, res) => {
    const status = req.query.status;
    const filter = status ? { status } : {};
    const { db } = await connectDb();
    const result = await db
      .collection("donationRequests")
      .find(filter)
      .toArray();
    res.send(result);
  })
);

// Donor: Get Own Requests
app.get(
  "/donation-requests/user/:email",
  verifyJWT,
  asyncHandler(async (req, res) => {
    const { email } = req.params;
    const { db } = await connectDb();
    const result = await db
      .collection("donationRequests")
      .find({ "requester.email": email })
      .toArray();
    res.send(result);
  })
);

// Update Donation Request
app.patch(
  "/donation-requests/:id",
  verifyJWT,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const update = req.body;
    const { db } = await connectDb();
    const result = await db
      .collection("donationRequests")
      .updateOne({ _id: new ObjectId(id) }, { $set: update });
    res.send(result);
  })
);

// Delete Donation Request
app.delete(
  "/donation-requests/:id",
  verifyJWT,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { db } = await connectDb();
    const result = await db
      .collection("donationRequests")
      .deleteOne({ _id: new ObjectId(id) });
    res.send(result);
  })
);

// Admin: Add Blog
app.post(
  "/blogs",
  verifyJWT,
  verifyRole("admin"),
  asyncHandler(async (req, res) => {
    const blog = req.body;
    blog.status = "draft";
    const { db } = await connectDb();
    const result = await db.collection("Blogs").insertOne(blog);
    res.status(201).send(result);
  })
);

// Public: Get Blogs
app.get(
  "/blogs",
  asyncHandler(async (req, res) => {
    const status = req.query.status;
    const filter = status ? { status } : {};
    const { db } = await connectDb();
    const result = await db.collection("Blogs").find(filter).toArray();
    res.send(result);
  })
);

// Update Blog
app.patch(
  "/blogs/:id",
  verifyJWT,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const update = req.body;
    const { db } = await connectDb();
    const result = await db
      .collection("Blogs")
      .updateOne({ _id: new ObjectId(id) }, { $set: update });
    res.send(result);
  })
);

// Delete Blog
app.delete(
  "/blogs/:id",
  verifyJWT,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { db } = await connectDb();
    const result = await db
      .collection("Blogs")
      .deleteOne({ _id: new ObjectId(id) });
    res.send(result);
  })
);

// Admin: Create Funding
app.post(
  "/fundings",
  verifyJWT,
  verifyRole("admin"),
  asyncHandler(async (req, res) => {
    const fund = req.body;
    const { db } = await connectDb();
    const result = await db.collection("Fundings").insertOne(fund);
    res.status(201).send(result);
  })
);

// Admin: Get All Fundings
app.get(
  "/fundings",
  verifyJWT,
  verifyRole("admin"),
  asyncHandler(async (req, res) => {
    const { db } = await connectDb();
    const result = await db.collection("Fundings").find().toArray();
    res.send(result);
  })
);

// 🆕 Stripe Payment Intent
app.post(
  "/create-payment-intent",
  verifyJWT,
  asyncHandler(async (req, res) => {
    const { amount } = req.body;

    if (!amount || amount < 1) {
      return res.status(400).send({ message: "Invalid amount" });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount * 100, // in cents
      currency: "usd",
      payment_method_types: ["card"],
    });

    res.send({ clientSecret: paymentIntent.client_secret });
  })
);

// Root Check
app.get("/", (req, res) => {
  res.send("PulsePoint Server is Running ✅");
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error("❌ Unhandled Error:", err);
  res
    .status(500)
    .send({ message: "Internal Server Error", error: err.message });
});

module.exports = app;
module.exports.handler = serverlessHttp(app);
