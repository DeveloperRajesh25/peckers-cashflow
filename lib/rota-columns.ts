// Column sets for the Rota page's two big queries. Both pages fetch every
// store's rows (visiting staff and the "away" badge depend on it), so the
// saving has to come from the columns, not a store filter.

export const ROTA_SHIFT_COLUMNS =
  "id, employee_id, store_id, shift_date, start_time, end_time, is_day_off, scheduled_hours, shift_type, same_day_edit_reason";

/** Only what `fourWkAvg` reads — the prior weeks never reach a rota cell. */
export const ROTA_HISTORY_SHIFT_COLUMNS =
  "employee_id, shift_date, scheduled_hours, is_day_off";

export const ROTA_CLOCK_COLUMNS =
  "id, employee_id, store_id, event_date, clock_in_at, clock_out_at, worked_hours, session_count, auto_clocked_out, manual_entry, manual_entry_reason, short_deliveries_count, long_deliveries_count, extra_short_deliveries, extra_long_deliveries";
