You are helping create a clean MySQL database from a messy exported schedule spreadsheet.

Use these files:
- `employees.csv`
- `employee_shifts.csv`
- `employee_availability.csv`
- `schedule_unmapped_entries.csv`
- `mysql_schema_and_inserts.sql`

Important assumptions:
- The season is 2025-08-16 to 2026-06-07.
- DD.MM dates in Aug-Dec belong to 2025; DD.MM dates in Jan-Jun belong to 2026.
- `employee_shifts.csv` contains only entries with reliable date headers.
- `schedule_unmapped_entries.csv` contains schedule-like cells that need manual date mapping before they are inserted into final shift planning.
- Preserve `raw_value`, `source_file`, `source_row`, and `source_col` in any generated model, because these are needed to audit corrections.

Suggested entities:
1. `employees`
2. `employee_shifts`
3. `employee_availability`
4. optionally `schedule_unmapped_entries` for review/admin UI

When building app logic:
- Treat `employee_availability` as constraints / exceptions.
- Treat `employee_shifts.status = WORK` as planned work.
- OFF/TRIP/SICK should not count as working coverage.
- `duration_minutes` is already calculated when a parseable time range exists.
