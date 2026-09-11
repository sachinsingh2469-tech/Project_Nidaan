CREATE DATABASE IF NOT EXISTS sih_opd_db;
USE sih_opd_db;

-- 1. Patients Master Table
CREATE TABLE IF NOT EXISTS patients (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    age INT NOT NULL,
    gender VARCHAR(20) NOT NULL,
    telecom VARCHAR(100) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_telecom (telecom)
) ENGINE=InnoDB;

-- 2. Clinical Cases / OPD Queue Table
CREATE TABLE IF NOT EXISTS clinical_cases (
    id VARCHAR(64) PRIMARY KEY,
    token VARCHAR(32) NOT NULL UNIQUE,
    patient_id VARCHAR(64) NOT NULL,
    chief_complaint TEXT NOT NULL,
    severity_scale INT DEFAULT 1,
    duration VARCHAR(50),
    is_emergency BOOLEAN DEFAULT FALSE,
    emergency_keywords TEXT,
    triage_priority VARCHAR(30) DEFAULT 'ROUTINE_GREEN',
    status VARCHAR(30) DEFAULT 'waiting',
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_status (status),
    FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 3. Ayush Examination Parameters
CREATE TABLE IF NOT EXISTS ayush_assessments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    case_id VARCHAR(64) NOT NULL UNIQUE,
    agni VARCHAR(50) NOT NULL,
    kostha VARCHAR(50) NOT NULL,
    FOREIGN KEY (case_id) REFERENCES clinical_cases(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 4. Comorbidities (1-to-many)
CREATE TABLE IF NOT EXISTS case_comorbidities (
    id INT AUTO_INCREMENT PRIMARY KEY,
    case_id VARCHAR(64) NOT NULL,
    condition_name VARCHAR(100) NOT NULL,
    FOREIGN KEY (case_id) REFERENCES clinical_cases(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 5. Scanned Documents & OCR Data
CREATE TABLE IF NOT EXISTS case_documents (
    id INT AUTO_INCREMENT PRIMARY KEY,
    case_id VARCHAR(64) NOT NULL,
    file_name VARCHAR(255),
    document_url LONGTEXT,
    ocr_raw_text LONGTEXT,
    ai_summary TEXT,
    FOREIGN KEY (case_id) REFERENCES clinical_cases(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 6. Prescriptions & Doctor Notes
CREATE TABLE IF NOT EXISTS prescriptions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    case_id VARCHAR(64) NOT NULL UNIQUE,
    doctor_notes TEXT NOT NULL,
    medication_request TEXT NOT NULL,
    dispatched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (case_id) REFERENCES clinical_cases(id) ON DELETE CASCADE
) ENGINE=InnoDB;