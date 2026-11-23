// ============================================================
// ระบบติดตามขนส่งวัสดุภายในไซต์ (หลายโครงการ) — ตรรกะฝั่ง server
//
// แทน Google Sheet "ระบบติดตามขนส่งวัสดุ" (แท็บ Log_<รหัส>, Build_<รหัส>, Projects, MasterData)
// กติกาเติมข้อมูลอัตโนมัติ เหมือนสคริปต์ onEdit ในชีต (TS_processRows_):
//   - Mat. Code → ประเภทวัสดุ / รายการวัสดุ / หน่วย  (ค้นจาก MasterData ด้วยรหัส 7 ตัวแรก)
//   - วันที่เบิก + วันที่รับ → สถานะ (วันเดียวกัน = เบิกด่วน, คนละวัน = เบิก, ยังไม่รับ = ว่าง)
//     ยกเว้นเลือกเองเป็น ย้าย / ยกเลิก
//   - สถานะ → สถานะ2 (เบิกด่วน→ส่งด่วนแล้ว, เบิก→ส่งแล้ว, ย้าย→ย้ายครบแล้ว, ยกเลิก→ยกเลิก)
//   - มีอาคาร แต่ไม่ใส่คลัง → คลังไซต์
//   - ชั้นต้องเป็นชั้นของอาคารนั้นในโครงการนั้น
//
// หน้า Dashboard (public/transport.html — ตัวเดียวกับ hub เดิม)
//   TRANSPORT_getProjects(), TRANSPORT_getReportMeta(code), TRANSPORT_getLogData(code)
// หน้ากรอก (public/transport-entry.html — ใหม่)
//   TRANSPORT_entryData(code), TRANSPORT_getMaster(), TRANSPORT_saveRows(code, rows), TRANSPORT_deleteRows(code, ids)
//   TRANSPORT_listDeleted(code), TRANSPORT_restoreRows(code, ids)   ถังขยะ: ลบแล้วกู้คืนได้ (ตาราง transport_deleted_rows)
// ตั้งค่า (admin)
//   TRANSPORT_saveProject(p), TRANSPORT_saveBuildings(code, buildings)
// ============================================================
const { sitePool } = require('../db');
const { UserError, withTx } = require('./common');

const STATUS1 = ['เบิกด่วน', 'เบิก', 'ย้าย', 'ยกเลิก'];
const STATUS2 = ['ส่งด่วนแล้ว', 'ส่งแล้ว', 'ย้ายครบแล้ว', 'ยกเลิก'];
const DEFAULT_WAREHOUSE = 'คลังไซต์';
const NOT_FOUND = 'ไม่พบข้อมูล';
const TITLE = 'ระบบติดตามการเบิก-จ่ายวัสดุประจำไซต์';
const SUBTITLE = 'SITE MATERIAL TRACKING — LIVE';
const HEADERS = ['ลำดับ', 'วันที่เบิก', 'วันที่รับวัสดุ', 'สถานะ', 'Mat. Code', 'ประเภทวัสดุ', 'รายการวัสดุ',
  'อาคาร', 'ชั้น', 'จำนวนที่เบิก/ย้าย', 'หน่วย', 'คลัง', 'สถานะ2', 'ผู้ขอเบิก/ผู้รับ', 'หมายเหตุ'];

const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 500);
// ตัวเลขชั้น/อาคารจาก Excel มาเป็น 9.0 → "9"
const cellText = v => (typeof v === 'number' && Number.isInteger(v)) ? String(v) : str(v);

function status2Of(status) {
  const s = str(status).replace(/\s+/g, '');
  if (s === '') return '';
  if (s.includes('เบิกด่วน')) return 'ส่งด่วนแล้ว';
  if (s.includes('เบิก')) return 'ส่งแล้ว';
  if (s.includes('ย้าย')) return 'ย้ายครบแล้ว';
  if (s.includes('ยกเลิก')) return 'ยกเลิก';
  return null;
}

function statusOf(current, requestDate, receiveDate) {
  const cur = str(current).replace(/\s+/g, '');
  if (cur === 'ย้าย' || cur === 'ยกเลิก') return cur;
  if (!receiveDate) return '';
  return requestDate && requestDate === receiveDate ? 'เบิกด่วน' : 'เบิก';
}

function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00Z')); }

function codeOf(code) {
  const c = str(code).toUpperCase();
  if (!/^[A-Z0-9]{2,10}$/.test(c)) throw new UserError('รหัสโครงการไม่ถูกต้อง');
  return c;
}

function isAdmin(ctx) { return !!(ctx && ctx.user && ctx.user.role === 'admin'); }
function userName(ctx) { return (ctx && ctx.user && (ctx.user.username || ctx.user.full_name)) || ''; }

async function getProject(client, code, mustBeActive) {
  const r = await client.query('SELECT code, name, logo_text, active FROM transport_projects WHERE code = $1', [code]);
  if (!r.rows.length) throw new UserError('ไม่พบโครงการ ' + code);
  if (mustBeActive && !r.rows[0].active) throw new UserError('โครงการ ' + code + ' ยังไม่เปิดใช้ในระบบขนส่งวัสดุ');
  return r.rows[0];
}

async function floorMap(client, code) {
  const r = await client.query(
    'SELECT building, floor FROM transport_floors WHERE project_code = $1 ORDER BY b_order, building, f_order', [code]);
  const map = new Map();
  r.rows.forEach(x => { if (!map.has(x.building)) map.set(x.building, []); map.get(x.building).push(x.floor); });
  return map;
}

async function masterLookup(client, codes) {
  const keys = [...new Set(codes.map(c => str(c).slice(0, 7).toUpperCase()).filter(Boolean))];
  if (!keys.length) return new Map();
  const r = await client.query(
    'SELECT UPPER(mat_code) AS k, group_name, description, unit FROM material_master WHERE UPPER(mat_code) = ANY($1)', [keys]);
  return new Map(r.rows.map(x => [x.k, x]));
}

// ============================================================
// Dashboard (เหมือน TRANSPORT_* ของ hub เดิม)
// ============================================================

async function TRANSPORT_getProjects() {
  const r = await sitePool.query(
    'SELECT code, name, logo_text AS logo FROM transport_projects WHERE active ORDER BY sort_order, code');
  return r.rows;
}

async function TRANSPORT_getReportMeta(projectCode) {
  const code = projectCode ? codeOf(projectCode) : (await TRANSPORT_getProjects())[0]?.code;
  if (!code) throw new UserError('ยังไม่มีโครงการที่เปิดใช้');
  const p = await getProject(sitePool, code, true);
  return { title: TITLE, subtitle: SUBTITLE, companyName: 'โครงการ ' + p.name, logoText: p.logo_text || p.code, projectCode: p.code };
}

async function TRANSPORT_getLogData(projectCode) {
  const code = projectCode ? codeOf(projectCode) : (await TRANSPORT_getProjects())[0]?.code;
  if (!code) throw new UserError('ยังไม่มีโครงการที่เปิดใช้');
  await getProject(sitePool, code, true);
  const r = await sitePool.query(`
    SELECT ROW_NUMBER() OVER (ORDER BY request_date NULLS LAST, id)::int AS "ลำดับ",
           TO_CHAR(request_date, 'DD/MM/YYYY') AS "วันที่เบิก",
           TO_CHAR(receive_date, 'DD/MM/YYYY') AS "วันที่รับวัสดุ",
           COALESCE(status, '') AS "สถานะ", COALESCE(mat_code, '') AS "Mat. Code",
           COALESCE(mat_type, '') AS "ประเภทวัสดุ", COALESCE(mat_item, '') AS "รายการวัสดุ",
           COALESCE(building, '') AS "อาคาร", COALESCE(floor, '') AS "ชั้น",
           quantity::float AS "จำนวนที่เบิก/ย้าย", COALESCE(unit, '') AS "หน่วย",
           COALESCE(warehouse, '') AS "คลัง", COALESCE(status2, '') AS "สถานะ2",
           COALESCE(requester_receiver, '') AS "ผู้ขอเบิก/ผู้รับ", COALESCE(note, '') AS "หมายเหตุ",
           CASE WHEN d.doc_no IS NOT NULL THEN l.doc_no END AS "_docNo"
      FROM material_transport_logs l
      LEFT JOIN transport_docs d ON d.project_code = l.project_code AND d.doc_no = l.doc_no
     WHERE l.project_code = $1
     ORDER BY request_date NULLS LAST, id`, [code]);
  r.rows.forEach(x => {
    ['วันที่เบิก', 'วันที่รับวัสดุ'].forEach(k => { if (x[k] == null) x[k] = ''; });
    if (x['จำนวนที่เบิก/ย้าย'] == null) x['จำนวนที่เบิก/ย้าย'] = '';
    // ลิงก์ใบเบิก (คอลัมน์ซ่อน ไม่อยู่ใน headers)
    x._docUrl = x._docNo ? `/api/transport-doc/${code}/${encodeURIComponent(x._docNo)}` : '';
  });
  return { headers: HEADERS, rows: r.rows, project: code, updatedAt: new Date().toISOString() };
}

// ============================================================
// หน้ากรอก
// ============================================================

async function TRANSPORT_entryData(projectCode) {
  const code = codeOf(projectCode);
  const p = await getProject(sitePool, code, true);
  const floors = await floorMap(sitePool, code);
  const r = await sitePool.query(`
    SELECT id, ROW_NUMBER() OVER (ORDER BY request_date NULLS LAST, id)::int AS no,
           TO_CHAR(request_date, 'YYYY-MM-DD') AS "requestDate", TO_CHAR(receive_date, 'YYYY-MM-DD') AS "receiveDate",
           COALESCE(status,'') AS status, COALESCE(mat_code,'') AS "matCode", COALESCE(mat_type,'') AS type,
           COALESCE(mat_item,'') AS item, COALESCE(building,'') AS building, COALESCE(floor,'') AS floor,
           quantity::float AS qty, COALESCE(unit,'') AS unit, COALESCE(warehouse,'') AS warehouse,
           COALESCE(status2,'') AS status2, COALESCE(requester_receiver,'') AS requester, COALESCE(note,'') AS note,
           COALESCE(updated_by, '') AS "updatedBy", COALESCE(l.doc_no, '') AS "docNo",
           (d.doc_no IS NOT NULL) AS "hasDoc"
      FROM material_transport_logs l
      LEFT JOIN transport_docs d ON d.project_code = l.project_code AND d.doc_no = l.doc_no
     WHERE l.project_code = $1
     ORDER BY request_date NULLS LAST, id`, [code]);
  r.rows.forEach(x => { x.requestDate = x.requestDate || ''; x.receiveDate = x.receiveDate || ''; if (x.qty == null) x.qty = ''; });
  return {
    project: { code: p.code, name: p.name },
    rows: r.rows,
    buildings: [...floors.entries()].map(([name, fl]) => ({ name, floors: fl })),
    statuses: STATUS1, statuses2: STATUS2, defaultWarehouse: DEFAULT_WAREHOUSE, notFound: NOT_FOUND,
    isAdmin: isAdmin(this)
  };
}

async function TRANSPORT_getMaster() {
  const r = await sitePool.query('SELECT mat_code, group_name, description, unit FROM material_master ORDER BY mat_code');
  return r.rows.map(x => [x.mat_code, x.group_name || '', x.description || '', x.unit || '']);
}

// ตรวจและเติมข้อมูล 1 แถว (คืน { value } หรือ { error })
function prepareRow(raw, floors, master) {
  const errs = [];
  const requestDate = str(raw.requestDate), receiveDate = str(raw.receiveDate);
  if (!requestDate) errs.push('วันที่เบิก');
  else if (!isDate(requestDate)) errs.push('วันที่เบิกไม่ถูกต้อง');
  if (receiveDate && !isDate(receiveDate)) errs.push('วันที่รับไม่ถูกต้อง');
  if (receiveDate && requestDate && receiveDate < requestDate) errs.push('วันที่รับก่อนวันที่เบิก');

  const matCode = str(raw.matCode, 30).toUpperCase();
  if (!matCode) errs.push('Mat. Code');
  const building = str(raw.building, 100);
  if (!building) errs.push('อาคาร');
  const floor = cellText(raw.floor).slice(0, 30);
  if (building && floors.size) {
    if (!floors.has(building)) errs.push('อาคาร "' + building + '" ไม่มีในโครงการนี้');
    else if (floor && !floors.get(building).includes(floor)) errs.push('ชั้น "' + floor + '" ไม่มีในอาคาร ' + building);
  }
  const qtyRaw = str(raw.qty);
  const qty = Number(qtyRaw);
  if (qtyRaw === '' || !isFinite(qty) || qty <= 0) errs.push('จำนวนต้องมากกว่า 0');

  let status = str(raw.status);
  if (status && !STATUS1.includes(status)) errs.push('สถานะไม่ถูกต้อง');
  let status2 = str(raw.status2);
  if (status2 && !STATUS2.includes(status2)) errs.push('สถานะ2 ไม่ถูกต้อง');
  const docNo = str(raw.docNo, 40).toUpperCase().replace(/\s+/g, '');
  if (docNo && !/^[A-Z0-9][A-Z0-9\-_.]{2,39}$/.test(docNo)) errs.push('เลขที่ใบเบิกใช้ได้เฉพาะ A-Z 0-9 - _ .');
  if (errs.length) return { error: errs.join(', ') };

  const m = master.get(matCode.slice(0, 7));
  status = statusOf(status, requestDate, receiveDate);
  // สถานะ2: ถ้าเลือกเองเก็บตามนั้น ถ้าไม่เลือก คำนวณจากสถานะ
  if (!status2 || raw.status2Auto) status2 = status2Of(status) || '';
  return {
    value: {
      request_date: requestDate, receive_date: receiveDate || null, status,
      mat_code: matCode, mat_type: m ? m.group_name : NOT_FOUND, mat_item: m ? m.description : NOT_FOUND, unit: m ? m.unit : '',
      building, floor, quantity: qty,
      warehouse: str(raw.warehouse, 100) || DEFAULT_WAREHOUSE,
      status2, requester_receiver: str(raw.requester, 200), note: str(raw.note, 1000),
      doc_no: docNo || null
    }
  };
}

const COLS = ['request_date', 'receive_date', 'status', 'mat_code', 'mat_type', 'mat_item', 'building', 'floor',
  'quantity', 'unit', 'warehouse', 'status2', 'requester_receiver', 'note', 'doc_no'];

async function TRANSPORT_saveRows(projectCode, rows) {
  const code = codeOf(projectCode);
  if (!Array.isArray(rows) || !rows.length) throw new UserError('ไม่มีรายการให้บันทึก');
  if (rows.length > 500) throw new UserError('บันทึกได้ครั้งละไม่เกิน 500 แถว');
  const by = userName(this);

  const saved = await withTx(async client => {
    await getProject(client, code, true);
    const floors = await floorMap(client, code);
    const master = await masterLookup(client, rows.map(r => r && r.matCode));
    const prepared = rows.map((r, i) => ({ i, id: r && r.id ? Number(r.id) : null, ...prepareRow(r || {}, floors, master) }));
    const bad = prepared.filter(p => p.error);
    if (bad.length) {
      throw new UserError('บันทึกไม่สำเร็จ ยังไม่มีแถวไหนถูกบันทึก:\n' +
        bad.slice(0, 10).map(p => `• แถว ${(rows[p.i] && rows[p.i].no) || ('ใหม่ ' + (p.i + 1))}: ${p.error}`).join('\n') +
        (bad.length > 10 ? `\n• และอีก ${bad.length - 10} แถว` : ''));
    }
    let n = 0;
    for (const p of prepared) {
      const vals = COLS.map(c => p.value[c]);
      if (p.id) {
        const u = await client.query(
          `UPDATE material_transport_logs SET ${COLS.map((c, k) => `${c} = $${k + 1}`).join(', ')},
                  updated_at = NOW(), updated_by = $${COLS.length + 1}
            WHERE id = $${COLS.length + 2} AND project_code = $${COLS.length + 3}`,
          [...vals, by, p.id, code]);
        if (!u.rowCount) throw new UserError('ไม่พบแถวที่จะแก้ไข (อาจถูกลบไปแล้ว) กรุณาโหลดใหม่');
      } else {
        await client.query(
          `INSERT INTO material_transport_logs (${COLS.join(', ')}, project_code, source, log_order, updated_at, updated_by)
           VALUES (${COLS.map((c, k) => '$' + (k + 1)).join(', ')}, $${COLS.length + 1}, 'web',
                   (SELECT COALESCE(MAX(log_order), 0) + 1 FROM material_transport_logs WHERE project_code = $${COLS.length + 1}),
                   NOW(), $${COLS.length + 2})`,
          [...vals, code, by]);
      }
      n++;
    }
    return n;
  });
  return { saved };
}

// ลบ = ย้ายทั้งแถวไปถังขยะ (transport_deleted_rows) แล้วลบจากตารางหลัก → กู้คืนได้ เก็บชื่อผู้ลบ
async function TRANSPORT_deleteRows(projectCode, ids) {
  const code = codeOf(projectCode);
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter(n => n > 0);
  if (!list.length) throw new UserError('ไม่ได้เลือกแถวที่จะลบ');
  const by = userName(this);
  const n = await withTx(async client => {
    await client.query(
      `INSERT INTO transport_deleted_rows (log_id, project_code, row, deleted_by)
       SELECT l.id, l.project_code, to_jsonb(l), $3 FROM material_transport_logs l
        WHERE l.project_code = $1 AND l.id = ANY($2)`, [code, list, by]);
    const r = await client.query('DELETE FROM material_transport_logs WHERE project_code = $1 AND id = ANY($2)', [code, list]);
    return r.rowCount;
  });
  return { deleted: n };
}

// แถวที่ลบแล้วของโครงการ (ใหม่สุดก่อน)
async function TRANSPORT_listDeleted(projectCode) {
  const code = codeOf(projectCode);
  const r = await sitePool.query(
    `SELECT id, deleted_by AS "deletedBy",
            TO_CHAR(deleted_at AT TIME ZONE 'Asia/Bangkok', 'DD/MM/YYYY HH24:MI') AS "deletedAt",
            row->>'request_date' AS "requestDate", row->>'receive_date' AS "receiveDate",
            COALESCE(row->>'mat_code', '') AS "matCode", COALESCE(row->>'mat_item', '') AS item,
            COALESCE(row->>'building', '') AS building, COALESCE(row->>'floor', '') AS floor,
            row->>'quantity' AS qty, COALESCE(row->>'unit', '') AS unit,
            COALESCE(row->>'requester_receiver', '') AS requester, COALESCE(row->>'doc_no', '') AS "docNo"
       FROM transport_deleted_rows WHERE project_code = $1
      ORDER BY deleted_at DESC, id DESC LIMIT 300`, [code]);
  return r.rows;
}

// กู้คืน: ใส่แถวกลับด้วย id เดิม แล้วเอาออกจากถังขยะ
async function TRANSPORT_restoreRows(projectCode, ids) {
  const code = codeOf(projectCode);
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter(n => n > 0);
  if (!list.length) throw new UserError('ไม่ได้เลือกแถวที่จะกู้คืน');
  const by = userName(this);
  const n = await withTx(async client => {
    const rows = (await client.query(
      'SELECT id, log_id, row FROM transport_deleted_rows WHERE project_code = $1 AND id = ANY($2) FOR UPDATE', [code, list])).rows;
    for (const d of rows) {
      const exists = (await client.query('SELECT 1 FROM material_transport_logs WHERE id = $1', [d.log_id])).rows.length;
      if (exists) throw new UserError('แถวนี้มีอยู่ในระบบแล้ว (อาจกู้คืนไปแล้ว)');
      await client.query(
        `INSERT INTO material_transport_logs SELECT * FROM jsonb_populate_record(NULL::material_transport_logs, $1::jsonb)`, [d.row]);
      await client.query('UPDATE material_transport_logs SET updated_at = NOW(), updated_by = $2 WHERE id = $1', [d.log_id, by]);
      await client.query('DELETE FROM transport_deleted_rows WHERE id = $1', [d.id]);
    }
    return rows.length;
  });
  return { restored: n };
}

// ============================================================
// ตั้งค่า (admin)
// ============================================================

function requireAdmin(ctx) {
  if (!isAdmin(ctx)) throw new UserError('ต้องใช้บัญชีผู้ดูแลระบบ (admin) ในการตั้งค่า');
}

async function TRANSPORT_listProjects() {
  requireAdmin(this);
  return (await sitePool.query(
    'SELECT code, name, logo_text AS logo, active, note FROM transport_projects ORDER BY sort_order, code')).rows;
}

async function TRANSPORT_saveProject(p) {
  requireAdmin(this);
  p = p || {};
  const code = codeOf(p.code);
  const name = str(p.name, 200);
  if (!name) throw new UserError('กรุณากรอกชื่อโครงการ');
  await sitePool.query(
    `INSERT INTO transport_projects (code, name, logo_text, active, note, sort_order)
     VALUES ($1, $2, $3, $4, $5, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM transport_projects))
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, logo_text = EXCLUDED.logo_text,
       active = EXCLUDED.active, note = EXCLUDED.note`,
    [code, name, str(p.logo, 30), p.active !== false, str(p.note, 300)]);
  return true;
}

// buildings = [{ name: 'อาคารC', floors: ['B4','B3',...] }, ...]  (แทนที่ทั้งหมดของโครงการนี้)
async function TRANSPORT_saveBuildings(projectCode, buildings) {
  requireAdmin(this);
  const code = codeOf(projectCode);
  const list = (Array.isArray(buildings) ? buildings : [])
    .map(b => ({ name: str(b && b.name, 100), floors: [...new Set((Array.isArray(b && b.floors) ? b.floors : []).map(cellText).filter(Boolean))] }))
    .filter(b => b.name);
  const names = list.map(b => b.name);
  if (new Set(names).size !== names.length) throw new UserError('ชื่ออาคารซ้ำกัน');
  await withTx(async client => {
    await getProject(client, code, false);
    await client.query('DELETE FROM transport_floors WHERE project_code = $1', [code]);
    for (let bi = 0; bi < list.length; bi++) {
      for (let fi = 0; fi < list[bi].floors.length; fi++) {
        await client.query(
          'INSERT INTO transport_floors (project_code, building, floor, b_order, f_order) VALUES ($1,$2,$3,$4,$5)',
          [code, list[bi].name, list[bi].floors[fi], bi, fi]);
      }
    }
  });
  return true;
}

module.exports = {
  STATUS1, STATUS2, cellText, statusOf, status2Of,
  functions: {
    TRANSPORT_getProjects, TRANSPORT_getReportMeta, TRANSPORT_getLogData,
    TRANSPORT_entryData, TRANSPORT_getMaster, TRANSPORT_saveRows, TRANSPORT_deleteRows,
    TRANSPORT_listDeleted, TRANSPORT_restoreRows,
    TRANSPORT_listProjects, TRANSPORT_saveProject, TRANSPORT_saveBuildings
  }
};
