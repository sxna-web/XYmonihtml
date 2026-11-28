-- StarJump V2.5 Batch 77 — READ-ONLY D1 schema inventory
-- Run manually against the intended STAGING/PRODUCTION D1 database.
-- Schema metadata only: no business rows, card codes/tokens, DDL or DML.
-- An empty result does not prove an absent candidate table is safe to create.
SELECT type, name, tbl_name, sql
FROM sqlite_master
WHERE type IN ('table','index','trigger','view')
  AND (name IN ('app_cards','app_groups','admin_vip_activations','admin_user_scopes','admin_audit_events','app_card_group_mappings','app_card_group_admin_requests')
    OR tbl_name IN ('app_cards','app_groups','admin_vip_activations','admin_user_scopes','admin_audit_events','app_card_group_mappings','app_card_group_admin_requests'))
ORDER BY type, tbl_name, name;
PRAGMA table_info('app_cards');
PRAGMA table_info('app_groups');
PRAGMA table_info('admin_vip_activations');
PRAGMA table_info('admin_user_scopes');
PRAGMA table_info('admin_audit_events');
PRAGMA table_info('app_card_group_mappings');
PRAGMA table_info('app_card_group_admin_requests');
PRAGMA index_list('app_cards');
PRAGMA index_list('app_groups');
PRAGMA index_list('admin_vip_activations');
PRAGMA index_list('admin_user_scopes');
PRAGMA index_list('admin_audit_events');
PRAGMA index_list('app_card_group_mappings');
PRAGMA index_list('app_card_group_admin_requests');
PRAGMA foreign_key_list('app_cards');
PRAGMA foreign_key_list('app_groups');
PRAGMA foreign_key_list('admin_vip_activations');
PRAGMA foreign_key_list('admin_user_scopes');
PRAGMA foreign_key_list('admin_audit_events');
PRAGMA foreign_key_list('app_card_group_mappings');
PRAGMA foreign_key_list('app_card_group_admin_requests');
-- For every exact index name returned above, separately run:
-- PRAGMA index_info('<exact-index-name>');
-- PRAGMA index_xinfo('<exact-index-name>');
-- Keep environment identity and output hashes in a secure change log; never paste secrets.
