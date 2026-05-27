-- Alternative MySQL loader using cleaned CSV files.
-- Run after adjusting paths if files are stored elsewhere and enabling LOCAL INFILE on your client.
SET NAMES utf8mb4;
SOURCE mysql_schema_empty.sql;

LOAD DATA LOCAL INFILE 'employees.csv'
INTO TABLE employees
CHARACTER SET utf8mb4
FIELDS TERMINATED BY ',' ENCLOSED BY '"' ESCAPED BY '"'
LINES TERMINATED BY '
'
IGNORE 1 LINES
(employee_id, name, source_notes);

LOAD DATA LOCAL INFILE 'employee_shifts.csv'
INTO TABLE employee_shifts
CHARACTER SET utf8mb4
FIELDS TERMINATED BY ',' ENCLOSED BY '"' ESCAPED BY '"'
LINES TERMINATED BY '
'
IGNORE 1 LINES
(shift_id, employee_id, @employee_name, work_date, status, start_time, end_time, duration_minutes, note, raw_value, source_file, source_row, source_col);

LOAD DATA LOCAL INFILE 'employee_availability.csv'
INTO TABLE employee_availability
CHARACTER SET utf8mb4
FIELDS TERMINATED BY ',' ENCLOSED BY '"' ESCAPED BY '"'
LINES TERMINATED BY '
'
IGNORE 1 LINES
(availability_id, employee_id, @employee_name, availability_date, availability_status, note, raw_value, source_file, source_row, source_col);

LOAD DATA LOCAL INFILE 'schedule_unmapped_entries.csv'
INTO TABLE schedule_unmapped_entries
CHARACTER SET utf8mb4
FIELDS TERMINATED BY ',' ENCLOSED BY '"' ESCAPED BY '"'
LINES TERMINATED BY '
'
IGNORE 1 LINES
(unmapped_id, employee_id, @employee_name, status, start_time, end_time, duration_minutes, note, raw_value, source_file, source_row, source_col, reason);
