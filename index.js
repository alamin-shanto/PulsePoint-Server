const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId, ServerApiVersion } = require("mongodb");
const admin = require("firebase-admin");
const dotenv = require("dotenv");
const jwt = require("jsonwebtoken");
const serverlessHttp = require("serverless-http");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ✅ Firebase Admin Initialization
try {
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
} catch (err) {
  console.error("❌ Firebase initialization error:", err);
}

// ✅ MongoDB Setup with caching
let cachedClient = null;
let cachedDb = null;
async function connectDb() {
  if (cachedClient && cachedDb) return { client: cachedClient, db: cachedDb };
  const client = new MongoClient(process.env.MONGO_URI, {
    serverApi: ServerApiVersion.v1,
  });
  await client.connect();
  const db = client.db("PulsePoint");
  cachedClient = client;
  cachedDb = db;
  return { client, db };
}

// ✅ JWT Verification Middleware
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

// ✅ Firebase ID Token Verification Middleware
async function verifyFirebaseToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer "))
    return res.status(401).send({ message: "Unauthorized" });

  const idToken = authHeader.split(" ")[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.firebaseUser = decodedToken;
    next();
  } catch (error) {
    console.error("Firebase token verification failed:", error);
    return res.status(403).send({ message: "Forbidden" });
  }
}

// ✅ Async Error Handler Wrapper
function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// 🔐 Generate JWT (after verifying Firebase ID token)
app.post(
  "/jwt",
  asyncHandler(async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer "))
      return res.status(401).send({ message: "Unauthorized" });

    const idToken = authHeader.split(" ")[1];
    try {
      const decoded = await admin.auth().verifyIdToken(idToken);
      const { db } = await connectDb();
      const usersCollection = db.collection("Users");
      const userInDb = await usersCollection.findOne({ email: decoded.email });

      const payload = {
        email: decoded.email,
        uid: decoded.uid,
        role: userInDb?.role || "donor",
      };

      const token = jwt.sign(payload, process.env.JWT_SECRET, {
        expiresIn: "7d",
      });
      res.send({ token });
    } catch (error) {
      console.error("JWT issuing failed:", error);
      res.status(403).send({ message: "Forbidden" });
    }
  })
);

// 🔐 Save/Register User
app.post(
  "/users",
  asyncHandler(async (req, res) => {
    const user = req.body;
    const { db } = await connectDb();
    const usersCollection = db.collection("Users");

    const existing = await usersCollection.findOne({ email: user.email });
    if (!existing) {
      user.role = "donor";
      user.status = "active";
      const result = await usersCollection.insertOne(user);
      res.send(result);
    } else {
      res.send({ message: "User already exists" });
    }
  })
);

// 🔐 Admin: Get All Users
app.get(
  "/users",
  verifyJWT,
  verifyFirebaseToken,
  asyncHandler(async (req, res) => {
    const { db } = await connectDb();
    const usersCollection = db.collection("Users");
    const users = await usersCollection.find().toArray();
    res.send(users);
  })
);

// 🔐 Update User Role or Status
app.patch(
  "/users/:id",
  verifyJWT,
  verifyFirebaseToken,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const update = req.body;
    const { db } = await connectDb();
    const usersCollection = db.collection("Users");

    const result = await usersCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: update }
    );
    res.send(result);
  })
);

// 🔐 Get Logged-In User Info
app.get(
  "/users/:email",
  verifyJWT,
  verifyFirebaseToken,
  asyncHandler(async (req, res) => {
    const email = req.params.email;
    const { db } = await connectDb();
    const usersCollection = db.collection("Users");

    const user = await usersCollection.findOne({ email });
    res.send(user);
  })
);

// 🔐 Create Donation Request
app.post(
  "/donation-requests",
  verifyJWT,
  verifyFirebaseToken,
  asyncHandler(async (req, res) => {
    const request = req.body;
    request.status = "pending";
    const { db } = await connectDb();
    const donationRequestsCollection = db.collection("donationRequests");

    const result = await donationRequestsCollection.insertOne(request);
    res.send(result);
  })
);

// 🔓 Public: Get Donation Requests (Optionally by Status)
app.get(
  "/donation-requests",
  asyncHandler(async (req, res) => {
    const status = req.query.status;
    const filter = status ? { status } : {};
    const { db } = await connectDb();
    const donationRequestsCollection = db.collection("donationRequests");

    const result = await donationRequestsCollection.find(filter).toArray();
    res.send(result);
  })
);

// 🔐 Donor: Get Their Requests
app.get(
  "/donation-requests/user/:email",
  verifyJWT,
  verifyFirebaseToken,
  asyncHandler(async (req, res) => {
    const email = req.params.email;
    const { db } = await connectDb();
    const donationRequestsCollection = db.collection("donationRequests");

    const result = await donationRequestsCollection
      .find({ "requester.email": email })
      .toArray();
    res.send(result);
  })
);

// 🔐 Update Donation Request
app.patch(
  "/donation-requests/:id",
  verifyJWT,
  verifyFirebaseToken,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const update = req.body;
    const { db } = await connectDb();
    const donationRequestsCollection = db.collection("donationRequests");

    const result = await donationRequestsCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: update }
    );
    res.send(result);
  })
);

// 🔐 Delete Donation Request
app.delete(
  "/donation-requests/:id",
  verifyJWT,
  verifyFirebaseToken,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { db } = await connectDb();
    const donationRequestsCollection = db.collection("donationRequests");

    const result = await donationRequestsCollection.deleteOne({
      _id: new ObjectId(id),
    });
    res.send(result);
  })
);

// 🔐 Create Funding Entry
app.post(
  "/fundings",
  verifyJWT,
  verifyFirebaseToken,
  asyncHandler(async (req, res) => {
    const fund = req.body;
    const { db } = await connectDb();
    const fundingCollection = db.collection("Fundings");

    const result = await fundingCollection.insertOne(fund);
    res.send(result);
  })
);

// 🔐 Get All Fundings
app.get(
  "/fundings",
  verifyJWT,
  verifyFirebaseToken,
  asyncHandler(async (req, res) => {
    const { db } = await connectDb();
    const fundingCollection = db.collection("Fundings");

    const result = await fundingCollection.find().toArray();
    res.send(result);
  })
);

// 🔐 Create Blog
app.post(
  "/blogs",
  verifyJWT,
  verifyFirebaseToken,
  asyncHandler(async (req, res) => {
    const blog = req.body;
    blog.status = "draft";
    const { db } = await connectDb();
    const blogsCollection = db.collection("Blogs");

    const result = await blogsCollection.insertOne(blog);
    res.send(result);
  })
);

// 🔓 Public: Get Blogs (Optionally by Status)
app.get(
  "/blogs",
  asyncHandler(async (req, res) => {
    const status = req.query.status;
    const filter = status ? { status } : {};
    const { db } = await connectDb();
    const blogsCollection = db.collection("Blogs");

    const result = await blogsCollection.find(filter).toArray();
    res.send(result);
  })
);

// 🔐 Publish/Unpublish Blog
app.patch(
  "/blogs/:id",
  verifyJWT,
  verifyFirebaseToken,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const update = req.body;
    const { db } = await connectDb();
    const blogsCollection = db.collection("Blogs");

    const result = await blogsCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: update }
    );
    res.send(result);
  })
);

// 🔐 Delete Blog
app.delete(
  "/blogs/:id",
  verifyJWT,
  verifyFirebaseToken,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { db } = await connectDb();
    const blogsCollection = db.collection("Blogs");

    const result = await blogsCollection.deleteOne({ _id: new ObjectId(id) });
    res.send(result);
  })
);

// ✅ Root
app.get("/", (req, res) => {
  res.send("PulsePoint Server is Running ✅");
});

// ✅ Error handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).send({ message: "Internal Server Error" });
});

module.exports = app;
module.exports.handler = serverlessHttp(app);
