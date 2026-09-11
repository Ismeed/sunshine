/* ==========================================================================
   supabase-config.js - hand-edit this once per shop.

   Sunshine Gadgets POS works completely offline with this file left blank.
   Cloud sync is an optional enhancement layer, never a requirement.

   To turn sync on:
     1. Create a free project at https://supabase.com
     2. Run supabase/schema.sql against it (SQL Editor -> paste -> Run)
     3. Project Settings -> API -> copy the "Project URL" and the
        "anon public" key (NOT the service_role key - that one must never
        appear in client-side code) into the two fields below.
     4. Reload the app on every device that should sync. That's it - no
        rebuild, no deploy step.

   Leaving both fields as "" keeps the app in pure offline mode: the sync
   pill will read "Offline only" and nothing else changes.
   ========================================================================== */

window.SUPABASE_CONFIG = {
  url: "",
  anonKey: ""
};
