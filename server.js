const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const crypto = require('crypto');
const pool = require('./db');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.static(__dirname));

const io = new Server(server, {
  cors: { origin: "*" }
});

// Helper: Emergency Triage Rule Engine
function evaluateRisk(complaint = "", severity = 0) {
  const text = complaint.toLowerCase();
  const redFlagRules = [
    "chest pain", "angina", "breathing difficulty", "shortness of breath",
    "stroke", "facial droop", "paralysis", "unconscious", "profuse bleeding"
  ];
  const matched = redFlagRules.filter(term => text.includes(term));
  const isHighPain = Number(severity) > 7;
  return {
    isEmergency: matched.length > 0 || isHighPain,
    emergencyKeywords: isHighPain ? [...matched, `pain severity ${severity}/10`] .join(', ') : matched.join(', ')
  };
}

// Fetch queue with nested entities using MySQL JSON functions
async function fetchFullQueue() {
  const sql = `
    SELECT 
      c.id, c.token, c.chief_complaint AS chiefComplaint, c.severity_scale AS severityScale, 
      c.duration, c.is_emergency AS isEmergency, c.emergency_keywords AS emergencyKeywords,
      c.triage_priority AS triagePriority, c.status, c.timestamp,
      p.name, p.age, p.gender, p.telecom,
      a.agni, a.kostha,
      pr.doctor_notes AS encounterNotes, pr.medication_request AS medicationRequest,
      (
        SELECT JSON_ARRAYAGG(condition_name) 
        FROM case_comorbidities 
        WHERE case_id = c.id
      ) AS comorbidities,
      (
        SELECT JSON_ARRAYAGG(
          JSON_OBJECT(
            'name', cd.file_name, 
            'dataUrl', cd.document_url, 
            'rawOcr', cd.ocr_raw_text, 
            'summary', cd.ai_summary
          )
        ) 
        FROM case_documents cd 
        WHERE cd.case_id = c.id
      ) AS pastRecords
    FROM clinical_cases c
    JOIN patients p ON c.patient_id = p.id
    LEFT JOIN ayush_assessments a ON c.id = a.case_id
    LEFT JOIN prescriptions pr ON c.id = pr.case_id
    ORDER BY 
      c.is_emergency DESC,
      c.timestamp ASC;
  `;

  const [rows] = await pool.query(sql);

  const parseJsonArray = (value) => {
    if (Array.isArray(value)) return value;
    if (!value) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  return rows.map(row => ({
    id: row.id,
    token: row.token,
    timestamp: row.timestamp,
    status: row.status,
    triagePriority: row.triagePriority,
    encounterNotes: row.encounterNotes,
    medicationRequest: row.medicationRequest,
    patient: {
      name: row.name,
      age: row.age,
      gender: row.gender,
      telecom: row.telecom
    },
    clinicalImpression: {
      chiefComplaint: row.chiefComplaint,
      severityScale: row.severityScale,
      duration: row.duration,
      isEmergency: Boolean(row.isEmergency),
      emergencyKeywords: row.emergencyKeywords ? row.emergencyKeywords.split(', ') : []
    },
    ayushAssessment: {
      agni: row.agni || "Sama",
      kostha: row.kostha || "Madhyama"
    },
    comorbidities: parseJsonArray(row.comorbidities),
    pastRecords: parseJsonArray(row.pastRecords)
  }));
}

// 1. Submit Case (Transactional SQL Insert)
app.post('/api/cases', async (req, res) => {
  const data = req.body;
  const risk = evaluateRisk(
    data.clinicalImpression?.chiefComplaint || "",
    data.clinicalImpression?.severityScale
  );

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const patientId = crypto.randomUUID();
    const caseId = crypto.randomUUID();

    // Generate the next token from the highest existing token, not row count.
    const [[lastTokenRow]] = await conn.query(
      `SELECT token
       FROM clinical_cases
       ORDER BY CAST(SUBSTRING(token, 5) AS UNSIGNED) DESC
       LIMIT 1
       FOR UPDATE`
    );
    const lastTokenNumber = Number.parseInt(lastTokenRow?.token?.slice(4), 10) || 1040;
    const token = `OPD-${lastTokenNumber + 1}`;

    // Insert Patient
    await conn.query(
      `INSERT INTO patients (id, name, age, gender, telecom) VALUES (?, ?, ?, ?, ?)`,
      [patientId, data.patient.name, data.patient.age, data.patient.gender, data.patient.telecom]
    );

    // Insert Case
    await conn.query(
      `INSERT INTO clinical_cases 
      (id, token, patient_id, chief_complaint, severity_scale, duration, is_emergency, emergency_keywords, triage_priority, status) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting')`,
      [
        caseId,
        token,
        patientId,
        data.clinicalImpression.chiefComplaint,
        data.clinicalImpression.severityScale,
        data.clinicalImpression.duration,
        risk.isEmergency,
        risk.emergencyKeywords,
        risk.isEmergency ? 'EMERGENCY_RED' : 'ROUTINE_GREEN'
      ]
    );

    // Insert Ayush Details
    if (data.ayushAssessment) {
      await conn.query(
        `INSERT INTO ayush_assessments (case_id, agni, kostha) VALUES (?, ?, ?)`,
        [caseId, data.ayushAssessment.agni, data.ayushAssessment.kostha]
      );
    }

    // Insert Comorbidities
    if (data.comorbidities && data.comorbidities.length > 0) {
      for (const condition of data.comorbidities) {
        await conn.query(
          `INSERT INTO case_comorbidities (case_id, condition_name) VALUES (?, ?)`,
          [caseId, condition]
        );
      }
    }

    // Insert Scans / Documents
    if (data.pastRecords && data.pastRecords.length > 0) {
      for (const doc of data.pastRecords) {
        await conn.query(
          `INSERT INTO case_documents (case_id, file_name, document_url, ocr_raw_text, ai_summary) VALUES (?, ?, ?, ?, ?)`,
          [caseId, doc.name, doc.dataUrl, doc.rawOcr || '', doc.summary || '']
        );
      }
    }

    await conn.commit();

    // Broadcast updated queue
    const queue = await fetchFullQueue();
    io.emit('queue:updated', queue);

    res.status(201).json({
      id: caseId,
      token,
      status: 'waiting',
      timestamp: new Date().toISOString(),
      triagePriority: risk.isEmergency ? 'EMERGENCY_RED' : 'ROUTINE_GREEN',
      patient: data.patient,
      clinicalImpression: {
        chiefComplaint: data.clinicalImpression.chiefComplaint,
        severityScale: data.clinicalImpression.severityScale,
        duration: data.clinicalImpression.duration,
        isEmergency: risk.isEmergency,
        emergencyKeywords: risk.emergencyKeywords ? risk.emergencyKeywords.split(', ') : []
      },
      ayushAssessment: data.ayushAssessment || { agni: 'Sama', kostha: 'Madhyama' },
      comorbidities: data.comorbidities || [],
      pastRecords: data.pastRecords || []
    });
  } catch (err) {
    await conn.rollback();
    console.error('MySQL Error on case submission:', err);
    res.status(500).json({ error: 'Database transaction failed' });
  } finally {
    conn.release();
  }
});

// 2. Fetch Active Queue for Doctor
app.get('/api/queue', async (req, res) => {
  try {
    const queue = await fetchFullQueue();
    res.json(queue);
  } catch (err) {
    console.error('MySQL Error fetching queue:', err);
    res.status(500).json({ error: 'Failed to fetch queue' });
  }
});

// 3. Complete Consultation & Save Prescription
app.post('/api/cases/:id/prescribe', async (req, res) => {
  const { id } = req.params;
  const { doctorNotes, medRx } = req.body;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query(
      `INSERT INTO prescriptions (case_id, doctor_notes, medication_request) VALUES (?, ?, ?)`,
      [id, doctorNotes, medRx]
    );

    await conn.query(`UPDATE clinical_cases SET status = 'completed' WHERE id = ?`, [id]);

    await conn.commit();

    const queue = await fetchFullQueue();
    io.emit('queue:updated', queue);

    res.json({ success: true, message: 'Prescription saved in MySQL & dispatched' });
  } catch (err) {
    await conn.rollback();
    console.error('MySQL Error updating prescription:', err);
    res.status(500).json({ error: 'Prescription save failed' });
  } finally {
    conn.release();
  }
});

// 4. Fetch Patient History for ABHA Locker
app.get('/api/history', async (req, res) => {
  const { query } = req.query;
  if (!query) return res.json([]);

  try {
    const all = await fetchFullQueue();
    const clean = query.trim().toLowerCase();
    const matches = all.filter(c => 
      (c.patient.telecom && c.patient.telecom.toLowerCase().includes(clean)) ||
      (c.patient.name && c.patient.name.toLowerCase().includes(clean))
    );
    res.json(matches);
  } catch (err) {
    console.error('MySQL Error searching history:', err);
    res.status(500).json({ error: 'History lookup failed' });
  }
});

// Socket connection
io.on('connection', async (socket) => {
  console.log('Connected socket client:', socket.id);
  const queue = await fetchFullQueue();
  socket.emit('queue:updated', queue);
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`MySQL Clinical Backend running at http://localhost:${PORT}`);
});