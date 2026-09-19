# Supabase Auth email templates (branded)

Paste each file into Supabase → Authentication → Email Templates (see `runbooks/email-provisioning.md` for subjects, SMTP and DNS). Every link uses the token-hash form through `/auth/confirm`, so it works in any browser. Placeholders (`{{ .Email }}`, `{{ .TokenHash }}`, `{{ .RedirectTo }}`, `{{ .NewEmail }}`) are Supabase's own.
