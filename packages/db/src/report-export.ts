// Explicit columns: additions to auth/storage schemas can never silently leak into exports.
export const portabilityTables = [
  {
    name: 'finance.settings',
    keys: ['id'],
    columns: 'id,version,initialized,unit_percent,opened_at',
  },
  { name: 'finance.catalog', keys: ['id'], columns: 'id,kind,name,active,created_at' },
  {
    name: 'finance.catalog_alias',
    keys: ['kind', 'alias'],
    columns: 'kind,alias,label,catalog_id',
  },
  { name: 'finance.account', keys: ['id'], columns: 'id,kind,name,bookmaker_id' },
  {
    name: 'finance.journal',
    keys: ['id'],
    columns: 'id,kind,effective_at,created_at,actor,reason,reversal_of',
  },
  {
    name: 'finance.posting',
    keys: ['journal_id', 'account_id'],
    columns: 'journal_id,account_id,amount',
  },
  {
    name: 'finance.monthly_unit',
    keys: ['month'],
    columns: 'month,amount,base,percent,source,created_at',
  },
  {
    name: 'finance.freebet',
    keys: ['id'],
    columns: 'id,bookmaker_id,amount,expires_on::text,stake_returned,used_by,note,created_at',
  },
  {
    name: 'finance.bet',
    keys: ['id'],
    columns:
      'id,bookmaker_id,tipster_id,stake,odds,placed_at,created_at,freebet_id,promotional_stake_returned,reference,state,remaining,unit_month,unit_amount,stake_journal_id',
  },
  {
    name: 'finance.selection',
    keys: ['id'],
    columns:
      'id,bet_id,position,event,sport,market,selection,odds,event_date::text,event_at,date_status,date_source,date_evidence,schedule_status',
  },
  {
    name: 'finance.settlement',
    keys: ['id'],
    columns:
      'id,bet_id,outcome,closed_principal,real_principal_closed,return_amount,settled_at,created_at,journal_id,reason',
  },
  {
    name: 'finance.settlement_reversal',
    keys: ['settlement_id'],
    columns: 'settlement_id,journal_id',
  },
  {
    name: 'finance.audit',
    keys: ['id'],
    columns: 'id,type,actor,entity_id,before,after,created_at',
  },
  { name: 'finance.command_receipt', keys: ['key'], columns: 'key,actor,hash,result,created_at' },
  {
    name: 'integration.inbox',
    keys: ['id'],
    columns:
      'id,source_key,attachment_id,imported_bet_id,sha256,caption,metadata,state,attempts,version,extraction,error_code,created_at,updated_at',
  },
  {
    name: 'integration.attachment',
    keys: ['id'],
    columns: 'id,sha256,mime,size,width,height,state,created_at,updated_at',
  },
  { name: 'integration.extraction_request', keys: ['id'], columns: 'id,inbox_id,created_at' },
  { name: 'integration.cursor', keys: ['name'], columns: 'name,next_offset' },
  { name: 'integration.ai_usage_day', keys: ['day'], columns: 'day,requests' },
  {
    name: 'integration.event_search',
    keys: ['id'],
    columns:
      'id,actor,selection_id,provider,query,event_fingerprint,date_hint,state,candidates,error_code,cached_from,created_at,started_at,completed_at',
  },
];
