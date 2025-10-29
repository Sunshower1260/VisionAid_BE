// index.js
const express = require("express");
const cors = require("cors");
const app = express(); // ← đây là phần bạn thiếu

app.use(cors());
app.use(express.json());

// Example route
app.get("/", (req, res) => {
  res.send("Server is running!");
});

// Your /analyze route
app.post("/analyze", async (req, res) => {
  const { image } = req.body;

  if (!image) return res.status(400).json({ error: "No image provided" });

  try {
    const response = await fetch("http://192.168.1.9:7000/upload_base64", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image }),
    });

    const result = await response.json();
    console.log("AI Result:", result);

    res.json({
      success: true,
      text: result.text_result,
      audioUrl: result.audio_url, 
    });
  } catch (err) {
    console.error("Analyze error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
