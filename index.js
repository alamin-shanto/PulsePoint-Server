const express = require("express");
const cors = require("cors");
const path = require("path");
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
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

app.options("*", cors());
app.use(express.json());

// Logger middleware
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

// JWT Middleware
function verifyJWT(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    console.error("❌ JWT verify error:", error.message);
    return res.status(403).json({ message: "Forbidden", error: error.message });
  }
}

function verifyRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ message: "Forbidden: Insufficient role" });
    }
    next();
  };
}

// Serve React App (make sure your React build files are in /build folder)
app.use(express.static(path.join(__dirname, "build")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "build", "index.html"));
});

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
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

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

// Admin: Update User Role/Status by ID
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

// Update user status by ID
app.patch(
  "/users/:id/status",
  verifyJWT,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    const { db } = await connectDb();
    const result = await db
      .collection("Users")
      .updateOne({ _id: new ObjectId(id) }, { $set: { status } });
    res.send(result);
  })
);

// Update user role by ID
app.patch(
  "/users/:id/role",
  verifyJWT,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { role } = req.body;
    const { db } = await connectDb();
    const result = await db
      .collection("Users")
      .updateOne({ _id: new ObjectId(id) }, { $set: { role } });
    res.send(result);
  })
);

// Donor: Create Donation Request
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

// Public: Get Donation Requests (optionally filtered by status)
app.get(
  "/donation-requests",
  asyncHandler(async (req, res) => {
    const status = req.query.status;
    const filter = status ? { status } : {};
    const { db } = await connectDb();
    const requests = await db
      .collection("donationRequests")
      .find(filter)
      .toArray();
    res.send(requests);
  })
);

// Donor: Get Own Donation Requests
app.get(
  "/donation-requests/user/:email",
  verifyJWT,
  asyncHandler(async (req, res) => {
    const { email } = req.params;
    const { db } = await connectDb();
    const requests = await db
      .collection("donationRequests")
      .find({ requesterEmail: email })
      .toArray();
    res.send(requests);
  })
);

// Public: Get Single Donation Request by ID
app.get(
  "/donation-requests/:id",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { db } = await connectDb();

    try {
      const request = await db
        .collection("donationRequests")
        .findOne({ _id: new ObjectId(id) });

      if (!request) {
        return res.status(404).json({ message: "Donation request not found" });
      }

      res.send(request);
    } catch (err) {
      console.error("Error fetching request by ID:", err);
      res.status(500).json({ message: "Internal server error" });
    }
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

// Search Donors by Blood Group, Division, District
app.get(
  "/donors/search",
  asyncHandler(async (req, res) => {
    const { bloodGroup, division, district } = req.query;
    const { db } = await connectDb();
    const donorsCollection = db.collection("Users");

    const filter = {};
    if (bloodGroup) filter.bloodGroup = bloodGroup;
    if (division) filter.division = division;
    if (district) filter.district = district;

    const donors = await donorsCollection.find(filter).toArray();
    res.send(donors);
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

// Public: Get Blogs (optionally filtered by status)
app.get(
  "/blogs",
  asyncHandler(async (req, res) => {
    const status = req.query.status;
    const filter = status ? { status } : {};
    const { db } = await connectDb();
    const blogs = await db.collection("Blogs").find(filter).toArray();
    res.send(blogs);
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

// Create Funding
app.post(
  "/fundings",
  verifyJWT,
  asyncHandler(async (req, res) => {
    const fund = req.body;
    const { role, uid, email } = req.user;

    if (!fund.amount || fund.amount < 1) {
      return res.status(400).json({ message: "Invalid amount" });
    }

    const { db } = await connectDb();

    // Fetch user by uid or email
    const user = await db.collection("Users").findOne({
      $or: [{ uid }, { email }],
    });

    fund.userId = uid;
    fund.email = email;
    fund.userName = user?.name || "Anonymous";
    if (!fund.date) fund.date = new Date().toISOString();

    const result = await db.collection("Fundings").insertOne(fund);
    res.status(201).send(result);
  })
);

// Admin: Get All Fundings with Pagination
app.get(
  "/fundings",
  verifyJWT,
  asyncHandler(async (req, res) => {
    const { db } = await connectDb();

    const { role, email, uid } = req.user;

    let filter = {};

    if (role !== "admin") {
      filter = {
        $or: [{ userId: uid }, { email }],
      };
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const fundingsCursor = db
      .collection("Fundings")
      .find(filter)
      .sort({ date: -1 })
      .skip(skip)
      .limit(limit);

    const fundings = await fundingsCursor.toArray();
    const totalCount = await db.collection("Fundings").countDocuments(filter);
    const totalPages = Math.ceil(totalCount / limit);

    res.json({
      fundings,
      totalCount,
      totalPages,
      currentPage: page,
    });
  })
);

// Stripe Payment Intent
app.post(
  "/create-payment-intent",
  verifyJWT,
  asyncHandler(async (req, res) => {
    const { amount } = req.body;

    if (!amount || amount < 1) {
      return res.status(400).json({ message: "Invalid amount" });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // convert dollars to cents, rounded
      currency: "usd",
      payment_method_types: ["card"],
    });

    res.json({ clientSecret: paymentIntent.client_secret });
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
    .json({ message: "Internal Server Error", error: err.message });
});

module.exports = app;
module.exports.handler = serverlessHttp(app);
