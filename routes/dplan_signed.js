// GET /api/dplan-signed/:id — เปิดใบแผนประจำวันที่ PE/PM ลงนามแล้ว (PDF / รูป) ต้อง login ก่อน
// ลิงก์เปิดจากเบราว์เซอร์ตรงๆ จึงพาไปหน้า login แทนการตอบ JSON
const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const { JWT_SECRET } = require('../middleware/auth');
const { signedFilePath } = require('../services/daily_plan');

const TYPES = { pdf: 'application/pdf', jpg: 'image/jpeg', png: 'image/png' };

router.get('/:id', (req, res) => {
  const auth = req.headers['authorization'];
  const token = (auth && auth.split(' ')[1]) || (req.cookies && req.cookies.token);
  const toLogin = () => res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  if (!token) return toLogin();
  jwt.verify(token, JWT_SECRET, async (err) => {
    if (err) return toLogin();
    try {
      const f = await signedFilePath(req.params.id);
      if (!f) return res.status(404).type('html').send('<meta charset="utf-8"><p style="font-family:Tahoma;padding:30px">ไม่พบใบเซ็นของแผนนี้</p>');
      res.setHeader('Content-Type', TYPES[f.ext] || 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`);
      res.sendFile(f.file);
    } catch (e) {
      res.status(400).type('html').send('<meta charset="utf-8"><p style="font-family:Tahoma;padding:30px">ลิงก์ไม่ถูกต้อง</p>');
    }
  });
});

module.exports = router;
