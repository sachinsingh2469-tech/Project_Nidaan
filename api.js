/**
 * FHIR & ABDM Compliant Data Emulation Engine
 */
const STORAGE_KEY_QUEUE = 'sih_opd_patient_queue';
const STORAGE_KEY_DRAFT = 'sih_opd_current_draft';

function getApiBaseUrl() {
  if (typeof window === 'undefined' || window.location.protocol === 'file:') {
    return 'http://localhost:5000/api';
  }

  const host = window.location.hostname || 'localhost';
  const port = window.location.port === '5000' ? window.location.port : '5000';
  return `${window.location.protocol}//${host}:${port}/api`;
}

const API_BASE_URL = getApiBaseUrl();

export const ClinicalAPI = {
  // Get active session draft
  // In api.js -> inside the ClinicalAPI object:

  // Fetch all encounters for a specific patient identifier (ABHA ID or Mobile)
  async getPatientHistory(identifier) {
    if (!identifier) return [];
    const response = await fetch(`${API_BASE_URL}/history?query=${encodeURIComponent(identifier.trim())}`);
    if (!response.ok) throw new Error('Unable to fetch patient history.');
    return response.json();
  },
  getDraft() {
    const raw = localStorage.getItem(STORAGE_KEY_DRAFT);
    return raw ? JSON.parse(raw) : {
      resourceType: "Bundle",
      type: "collection",
      meta: { timestamp: new Date().toISOString() },
      patient: { name: "", age: "", gender: "other", telecom: "", abhaId: "" },
      clinicalImpression: {
        chiefComplaint: "",
        severityScale: 1,
        duration: "1-3 days",
        isEmergency: false,
        emergencyKeywords: []
      },
      ayushAssessment: { agni: "Sama", kostha: "Madhyama" },
      comorbidities: [],
      pastRecords: []
    };
  },

  // Save current step data to cache
  saveDraft(data) {
    const current = this.getDraft();
    const updated = { ...current, ...data };
    localStorage.setItem(STORAGE_KEY_DRAFT, JSON.stringify(updated));
  },

  // Clear cache draft on terminal screens
  clearDraft() {
    localStorage.removeItem(STORAGE_KEY_DRAFT);
  },

  // Auto-triage rule engine
  evaluateRisk(complaintText = "") {
    const text = complaintText.toLowerCase();
    const redFlagRules = [
      "chest pain", "angina", "breathing difficulty", "shortness of breath",
      "stroke", "facial droop", "paralysis", "unconscious", "profuse bleeding",
      "severe trauma", "cyanosis", "blood vomit"
    ];
    
    const matched = redFlagRules.filter(term => text.includes(term));
    return {
      isEmergency: matched.length > 0,
      emergencyKeywords: matched
    };
  },

  // Submit case to queue
  async submitCase() {
    const current = this.getDraft();
    
    const risk = this.evaluateRisk(current.clinicalImpression.chiefComplaint);
    current.clinicalImpression.isEmergency = risk.isEmergency;
    current.clinicalImpression.emergencyKeywords = risk.emergencyKeywords;

    let response;
    try {
      response = await fetch(`${API_BASE_URL}/cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(current)
      });
    } catch {
      throw new Error(`Cannot reach the OPD backend at ${API_BASE_URL}. Start the backend with "npm start" and try again.`);
    }
    if (!response.ok) throw new Error('Unable to save case to MySQL. Is the backend running?');
    const submissionPayload = await response.json();
    this.clearDraft();
    return submissionPayload;
  },

  // Get active queue
  async getQueue() {
    const response = await fetch(`${API_BASE_URL}/queue`);
    if (!response.ok) throw new Error('Unable to load the MySQL queue.');
    return response.json();
  },

  // Update consulting status
  async updateStatus(patientId, status, doctorNotes = null, rxData = null) {
    const response = await fetch(`${API_BASE_URL}/cases/${encodeURIComponent(patientId)}/prescribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doctorNotes, medRx: rxData })
    });
    if (!response.ok) throw new Error('Unable to save the prescription to MySQL.');
    return response.json();
  }
};