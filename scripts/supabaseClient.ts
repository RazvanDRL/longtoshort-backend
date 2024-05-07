import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceRole = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE!;

export const supabase = createClient(supabaseUrl, supabaseServiceRole);