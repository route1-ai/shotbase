-- Adds failure diagnostics to the screenshots table so the dashboard Activity log can
-- answer "why did this fail?" without a live call. The backend's logScreenshot populates:
--   error_code    — stable machine code (dns_failed, connection_refused, navigation_timeout,
--                    ssl_error, render_failed, server_busy). NULL on success.
--   error_message — clean, user-facing message (NEVER the raw Playwright error). NULL on success.
--
-- Run this in Supabase (SQL editor) BEFORE deploying the backend change. Until the columns
-- exist the insert errors, but logScreenshot is fire-and-forget so responses are unaffected.
-- (Same out-of-band pattern as the earlier ai_requested / ai_succeeded columns.)

alter table screenshots add column if not exists error_code    text;
alter table screenshots add column if not exists error_message text;
