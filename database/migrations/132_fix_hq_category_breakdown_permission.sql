-- Grant execute permissions for HQ category breakdown functions
-- These functions are called by PostgREST API endpoints

GRANT EXECUTE ON FUNCTION upsert_hq_category_breakdown(BIGINT, JSONB, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION get_hq_category_breakdown(BIGINT) TO anon, authenticated;