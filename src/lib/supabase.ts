import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/**
 * Deliberately returns null until a dedicated development project is configured.
 * Never put service_role credentials in a browser application.
 */
export const supabase = url && anonKey ? createClient(url, anonKey) : null;
