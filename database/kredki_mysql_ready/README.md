# Kredki schedule - MySQL-ready cleaned data

Generated from:
- `Kredki Grafik - Лист1.csv`
- `Wolne i Wyjazdy - Лист1.csv`

## Main output files

1. `employees.csv` - normalized employee master data.
2. `employee_shifts.csv` - schedule rows with a visible/confirmed date header.
3. `employee_availability.csv` - days off / trips / availability constraints from the `Wolne i Wyjazdy` file.
4. `schedule_unmapped_entries.csv` - meaningful cells that could not be safely assigned to a date because the source column had no visible date header.
5. `mysql_schema_and_inserts.sql` - ready-to-run MySQL schema plus INSERT data.
6. `mysql_schema_empty.sql` + `mysql_load_data_local_infile.sql` - alternative flow if you prefer `LOAD DATA LOCAL INFILE`.
7. `raw_source_cells.csv` - audit trail of non-empty source cells.

## Assumptions and cleaning rules

- Dates in the source are `DD.MM` without year.
- Dates from August to December are interpreted as 2025.
- Dates from January to June are interpreted as 2026.
- This produces a continuous season from 2025-08-16 to 2026-06-07.
- Names are normalized to: Igor, Adam, Maria, Anisa, Ola, Juliana, Karolina, Gleb.
- Values like `Wolne`, `wolne`, `Wolny` are normalized to status `OFF`.
- `wyjazd` is normalized to `TRIP`.
- `😷` is normalized to `SICK`.
- `szkolenie` is normalized to `TRAINING`.
- `event` is normalized to `EVENT`.
- Time ranges are standardized to `HH:MM:SS` where possible.
- The malformed value `12:00:19:30` is corrected to `12:00-19:30`.
- Original values, source file, row, and column are preserved in every table for auditability.

## Counts

- Employees: 8
- Clean shift records: 725
- Availability records: 9
- Unmapped schedule entries for manual review: 99
- Raw non-empty source cells: 1319

## Recommended Claude instruction

Use `mysql_schema_and_inserts.sql` as the source of truth. If you prefer CSV import, create the schema from `mysql_schema_empty.sql` and then load `employees.csv`, `employee_shifts.csv`, `employee_availability.csv`, and `schedule_unmapped_entries.csv` in that order.

Do not discard `schedule_unmapped_entries.csv`: it contains real schedule-like values from columns where the exported CSV did not expose a reliable date header. Ask for the original Google Sheet or manually fill dates for those entries before promoting them into `employee_shifts`.
