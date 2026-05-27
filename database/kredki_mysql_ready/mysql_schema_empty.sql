-- MySQL script generated from cleaned Kredki schedule CSV files
-- Assumption: DD.MM values in Aug-Dec are 2025; Jan-Jun are 2026.
SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS=0;
DROP TABLE IF EXISTS schedule_unmapped_entries;
DROP TABLE IF EXISTS employee_availability;
DROP TABLE IF EXISTS employee_shifts;
DROP TABLE IF EXISTS employees;
SET FOREIGN_KEY_CHECKS=1;

CREATE TABLE employees (
  employee_id INT PRIMARY KEY,
  name VARCHAR(80) NOT NULL UNIQUE,
  source_notes TEXT NULL
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE TABLE employee_shifts (
  shift_id INT PRIMARY KEY,
  employee_id INT NOT NULL,
  work_date DATE NOT NULL,
  status ENUM('WORK','OFF','TRIP','SICK','TRAINING','EVENT','NOTE','UNKNOWN') NOT NULL DEFAULT 'UNKNOWN',
  start_time TIME NULL,
  end_time TIME NULL,
  duration_minutes INT NULL,
  note TEXT NULL,
  raw_value VARCHAR(255) NOT NULL,
  source_file VARCHAR(255) NOT NULL,
  source_row INT NOT NULL,
  source_col VARCHAR(8) NOT NULL,
  CONSTRAINT fk_employee_shifts_employee FOREIGN KEY (employee_id) REFERENCES employees(employee_id),
  INDEX idx_employee_shifts_date_employee (work_date, employee_id),
  INDEX idx_employee_shifts_employee_date (employee_id, work_date)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE TABLE employee_availability (
  availability_id INT PRIMARY KEY,
  employee_id INT NOT NULL,
  availability_date DATE NOT NULL,
  availability_status ENUM('OFF','TRIP','SICK','NOTE','UNKNOWN') NOT NULL DEFAULT 'UNKNOWN',
  note TEXT NULL,
  raw_value VARCHAR(255) NOT NULL,
  source_file VARCHAR(255) NOT NULL,
  source_row INT NOT NULL,
  source_col VARCHAR(8) NOT NULL,
  CONSTRAINT fk_employee_availability_employee FOREIGN KEY (employee_id) REFERENCES employees(employee_id),
  INDEX idx_employee_availability_date_employee (availability_date, employee_id),
  INDEX idx_employee_availability_employee_date (employee_id, availability_date)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE TABLE schedule_unmapped_entries (
  unmapped_id INT PRIMARY KEY,
  employee_id INT NULL,
  status ENUM('WORK','OFF','TRIP','SICK','TRAINING','EVENT','NOTE','UNKNOWN') NOT NULL DEFAULT 'UNKNOWN',
  start_time TIME NULL,
  end_time TIME NULL,
  duration_minutes INT NULL,
  note TEXT NULL,
  raw_value VARCHAR(255) NOT NULL,
  source_file VARCHAR(255) NOT NULL,
  source_row INT NOT NULL,
  source_col VARCHAR(8) NOT NULL,
  reason VARCHAR(255) NOT NULL,
  CONSTRAINT fk_unmapped_employee FOREIGN KEY (employee_id) REFERENCES employees(employee_id)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

