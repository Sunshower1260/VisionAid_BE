require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');   
const FormData = require('form-data'); 

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const pool = new Pool({
  user: process.env.PGUSER || 'postgres',
  host: process.env.PGHOST || 'localhost',
  database: process.env.PGDATABASE || 'VisionAid',
  password: process.env.PGPASSWORD || 'your_password',
  port: process.env.PGPORT ? parseInt(process.env.PGPORT) : 5432,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});
console.log("🗄️ Connected to DB:", process.env.PGDATABASE);

const JWT_SECRET = process.env.JWT_SECRET || 'secretkey';

// API register
app.post("/register", async (req, res) => {
  const { email, password, phoneNumber } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, error: "Email và mật khẩu là bắt buộc" });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (email, password_hash, phone_number) 
       VALUES ($1, $2, $3) 
       RETURNING id, email, phone_number`,
      [email, hashedPassword, phoneNumber || null] 
    );

    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error(err);
    if (err.code === "23505") { 
      return res.status(400).json({ success: false, error: "Email đã tồn tại" });
    }
    res.status(500).json({ success: false, error: "Lỗi server" });
  }
});

// Login user
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
    if (result.rows.length === 0) return res.status(400).json({ error: 'User not found' });

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(400).json({ error: 'Invalid password' });

    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ success: true, token, user: { id: user.id, email: user.email, role: user.role } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Vision Analysis using gemini 2.5-flash
app.post("/analyze", async (req, res) => {
  const { image } = req.body; // base64 từ app

  if (!image) {
    return res.status(400).json({ success: false, error: "Thiếu ảnh base64" });
  }

  try {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ success: false, error: "Thiếu GEMINI_API_KEY trong .env" });
    }

    // Tạo request gửi đến Gemini
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

    const body = {
      contents: [
        {
          parts: [
            {
              inline_data: {
                mime_type: "image/jpeg",
                data: image, 
              },
            },
            {
              text: `
Bạn là trợ lý hỗ trợ người khiếm thị.
Hãy phân loại ảnh thành một trong hai loại:
- [Tài liệu]: Nếu ảnh là giấy tờ, văn bản → đọc toàn bộ nội dung.
- [Ngữ cảnh]: Nếu ảnh là cảnh vật, vật thể → mô tả ngắn gọn, tự nhiên.
Trả kết quả theo format:
Thể loại: [Tài liệu hoặc Ngữ cảnh]
Nội dung: <nội dung mô tả hoặc OCR>.
              `,
            },
          ],
        },
      ],
    };

    const response = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await response.json();

    if (!data.candidates || !data.candidates[0]?.content?.parts?.[0]?.text) {
      console.error("Gemini returned:", data);
      return res.status(500).json({ success: false, error: "Gemini không trả kết quả hợp lệ" });
    }

    const text_result = data.candidates[0].content.parts[0].text;

    res.json({
      success: true,
      text: text_result,
    });
  } catch (err) {
    console.error("Analyze error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});


//  Cập nhật vị trí hiện tại của người dùng 
app.post('/api/volunteer/update-location', async (req, res) => {
  const { userId, latitude, longitude } = req.body;

  if (!userId || !latitude || !longitude) {
    return res.status(400).json({ success: false, error: "Thiếu thông tin userId hoặc vị trí." });
  }

  try {
    await pool.query(`
      UPDATE users
      SET latitude = $1, longitude = $2
      WHERE id = $3
    `, [latitude, longitude, userId]);

    res.json({ success: true, message: "Cập nhật vị trí thành công" });
  } catch (err) {
    console.error("Error updating location:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});


//  Hàm tính khoảng cách Haversine
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371; // 
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}


// Người dùng gửi yêu cầu hỗ trợ
app.post('/api/volunteer/request', async (req, res) => {
  const { userId, latitude, longitude } = req.body;

  if (!userId || !latitude || !longitude) {
    return res.status(400).json({ success: false, error: "Thiếu thông tin userId hoặc vị trí." });
  }

  try {
    // Lưu request chung, không gán volunteer cụ thể
    const insert = await pool.query(
      `INSERT INTO volunteer_requests (user_id, latitude, longitude, status)
       VALUES ($1, $2, $3, 'pending')
       RETURNING *`,
      [userId, latitude, longitude]
    );

    res.json({
      success: true,
      message: "Đã gửi yêu cầu hỗ trợ.",
      request: insert.rows[0]
    });

  } catch (err) {
    console.error("Volunteer request error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Lấy danh sách yêu cầu hỗ trợ đang chờ (cho tất cả volunteers)
app.get('/api/volunteer/requests', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT vr.*, u.email AS requester_email, u.phone_number
      FROM volunteer_requests vr
      JOIN users u ON u.id = vr.user_id
      WHERE vr.status = 'pending'
    `);

    res.json({ success: true, requests: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

//  Volunteer accept yêu cầu
app.post('/api/volunteer/accept', async (req, res) => {
  const { requestId, volunteerId } = req.body;
  if (!volunteerId) return res.status(400).json({ success: false, error: "Thiếu volunteerId." });

  try {
    // Cập nhật status và gán volunteer
    await pool.query(`
      UPDATE volunteer_requests
      SET status = 'accepted', volunteer_id = $2
      WHERE id = $1
    `, [requestId, volunteerId]);

    // Lấy phone number của người mù
    const { rows } = await pool.query(`
      SELECT u.phone_number
      FROM volunteer_requests vr
      JOIN users u ON u.id = vr.user_id
      WHERE vr.id = $1
    `, [requestId]);

    const phoneNumber = rows[0]?.phone_number || null;

    res.json({ success: true, message: "Đã nhận hỗ trợ người dùng.", phoneNumber });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Người dùng gửi vị trí hiện tại cho người thân
app.post('/api/family/send-location', async (req, res) => {
  const { userId, latitude, longitude } = req.body;

  if (!userId || !latitude || !longitude) {
    return res.status(400).json({ success: false, error: "Thiếu thông tin userId hoặc vị trí." });
  }

  try {
    await pool.query(
      `INSERT INTO family_locations (user_id, latitude, longitude)
       VALUES ($1, $2, $3)`,
      [userId, latitude, longitude]
    );
    res.json({ success: true, message: "Đã gửi vị trí thành công cho người thân." });
  } catch (err) {
    console.error("Error saving family location:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// Lấy vị trí gần nhất của người dùng
app.get('/api/family/last-location/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const { rows } = await pool.query(`
      SELECT latitude, longitude, timestamp
      FROM family_locations
      WHERE user_id = $1
      ORDER BY timestamp DESC
      LIMIT 1
    `, [userId]);

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Chưa có dữ liệu vị trí nào." });
    }

    res.json({ success: true, location: rows[0] });
  } catch (err) {
    console.error("Error fetching location:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Đăng ký làm tình nguyện viên
app.post('/api/membership/volunteer', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ success: false, message: "Thiếu email" });

  try {
    const { rows } = await pool.query(`SELECT id, role FROM users WHERE email = $1`, [email]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: "Người dùng không tồn tại" });

    const user = rows[0];
    if (user.role === "member" || user.role === "vip") {
      return res.json({ success: false, message: "Bạn đã là tình nguyện viên" });
    }

    await pool.query(`UPDATE users SET role='member' WHERE id=$1`, [user.id]);
    res.json({ success: true, message: "Bạn đã trở thành tình nguyện viên!" });
  } catch (err) {
    console.error("Volunteer registration error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Đăng ký làm người thân
app.post('/api/membership/family', async (req, res) => {
  const { familyEmail, blindEmail, blindPassword } = req.body;

  if (!familyEmail || !blindEmail || !blindPassword)
    return res.status(400).json({ success: false, message: "Thiếu thông tin" });

  try {
    // Lấy family user
    const { rows: familyRows } = await pool.query(`SELECT id FROM users WHERE email=$1`, [familyEmail]);
    if (familyRows.length === 0) return res.status(404).json({ success: false, message: "Người dùng không tồn tại" });
    const familyId = familyRows[0].id;

    // Lấy user mù
    const { rows: blindRows } = await pool.query(`SELECT id, password_hash FROM users WHERE email=$1`, [blindEmail]);
    if (blindRows.length === 0) return res.status(404).json({ success: false, message: "Người mù không tồn tại" });
    const blindUser = blindRows[0];

    const valid = await bcrypt.compare(blindPassword, blindUser.password_hash);
    if (!valid) return res.status(400).json({ success: false, message: "Sai mật khẩu người mù" });

    // Kiểm tra đã là người thân chưa
    const { rows: exists } = await pool.query(
      `SELECT * FROM family WHERE user_id=$1 AND relative_id=$2`,
      [familyId, blindUser.id]
    );
    if (exists.length > 0) return res.json({ success: false, message: "Bạn đã là người thân của người mù này" });

    await pool.query(
      `INSERT INTO family (user_id, relative_id, relation) VALUES ($1, $2, 'người thân')`,
      [familyId, blindUser.id]
    );

    res.json({ success: true, message: "Bạn đã trở thành người thân của người mù này!" });

  } catch (err) {
    console.error("Family registration error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

//  Thêm người nhà
app.post('/api/family/add', async (req, res) => {
  const { userId, email, password, relation } = req.body;
  if (!userId || !email || !password || !relation) 
    return res.status(400).json({ success: false, error: "Thiếu thông tin." });

  try {
    let result = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
    let relativeId;
    if (result.rows.length === 0) {
      const hashedPassword = await bcrypt.hash(password, 10);
      const insertUser = await pool.query(
        'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
        [email, hashedPassword, 'user']
      );
      relativeId = insertUser.rows[0].id;
    } else {
      relativeId = result.rows[0].id;
    }

    await pool.query(
      'INSERT INTO family (user_id, relative_id, relation) VALUES ($1, $2, $3)',
      [userId, relativeId, relation]
    );

    res.json({ success: true, message: "Đã thêm người nhà.", relativeId });
  } catch (err) {
    console.error("Add family error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/family/list/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const { rows } = await pool.query(`
      SELECT f.id, u.email, f.relation
      FROM family f
      JOIN users u ON u.id = f.relative_id
      WHERE f.user_id = $1
    `, [userId]);

    res.json({ success: true, family: rows });
  } catch (err) {
    console.error("Fetch family list error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});


//  Cập nhật role của user
app.post('/api/users/update-role', async (req, res) => {
  const { userId, role } = req.body;
  if (!userId || !role) return res.status(400).json({ success: false, error: "Thiếu thông tin." });

  try {
    await pool.query(
      'UPDATE users SET role=$1 WHERE id=$2',
      [role, userId]
    );
    res.json({ success: true, message: `Role cập nhật thành công: ${role}` });
  } catch (err) {
    console.error("Update role error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Lấy tất cả vị trí của các người mù mà userId là người nhà
app.get('/api/family/locations/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    // Lấy danh sách relativeId
    const { rows: relatives } = await pool.query(
      `SELECT relative_id FROM family WHERE user_id = $1`,
      [userId]
    );

    if (relatives.length === 0) {
      return res.json({ success: true, locations: [] });
    }

    const relativeIds = relatives.map(r => r.relative_id);

    // Lấy vị trí mới nhất của các relative
    const { rows: locations } = await pool.query(
      `SELECT u.id, u.email, fl.latitude, fl.longitude, fl.timestamp
       FROM family_locations fl
       JOIN users u ON u.id = fl.user_id
       WHERE fl.user_id = ANY($1::int[])
       ORDER BY fl.timestamp DESC`,
      [relativeIds]
    );

    res.json({ success: true, locations });
  } catch (err) {
    console.error("Fetch family locations error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
