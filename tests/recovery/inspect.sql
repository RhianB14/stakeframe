SELECT json_build_object(
  'databaseOwner', (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()),
  'schemaOwner', (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'recovery_probe'),
  'objects', (SELECT json_agg(row_to_json(o) ORDER BY o.name) FROM (
    SELECT c.relname AS name, c.relkind AS kind, pg_get_userbyid(c.relowner) AS owner, c.relacl::text AS acl
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('auth', 'recovery_probe')
  ) o),
  'defaultPrivileges', (SELECT json_agg(row_to_json(p) ORDER BY p.owner, p.kind) FROM (
    SELECT pg_get_userbyid(defaclrole) AS owner, defaclobjtype AS kind, defaclacl::text AS acl FROM pg_default_acl
  ) p),
  'entriesHash', (SELECT md5(string_agg(row_to_json(e)::text, '|' ORDER BY e.id)) FROM recovery_probe.entries e),
  'referenceCount', (SELECT count(*) FROM recovery_probe.references),
  'authUserHash', (SELECT md5(string_agg(row_to_json(u)::text, '|' ORDER BY u.id)) FROM auth."user" u),
  'authAccountHash', (SELECT md5(string_agg(row_to_json(a)::text, '|' ORDER BY a.id)) FROM auth.account a),
  'authSessionHash', (SELECT md5(string_agg(row_to_json(s)::text, '|' ORDER BY s.id)) FROM auth.session s),
  'authVerificationHash', (SELECT md5(string_agg(row_to_json(v)::text, '|' ORDER BY v.id)) FROM auth.verification v),
  'sequenceValue', (SELECT last_value FROM recovery_probe.entries_id_seq),
  'sequenceCalled', (SELECT is_called FROM recovery_probe.entries_id_seq),
  'constraints', (SELECT json_agg(row_to_json(c) ORDER BY c.name) FROM (
    SELECT conname AS name, pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE connamespace IN ('auth'::regnamespace, 'recovery_probe'::regnamespace)
  ) c),
  'readerSelect', has_table_privilege('stk_fixture_reader', 'recovery_probe.entries', 'SELECT'),
  'readerInsert', has_table_privilege('stk_fixture_reader', 'recovery_probe.entries', 'INSERT'),
  'memberSelect', has_table_privilege('stk_fixture_member', 'recovery_probe.entries', 'SELECT'),
  'membership', pg_has_role('stk_fixture_member', 'stk_fixture_reader', 'MEMBER'),
  'roleGrants', (SELECT json_agg(row_to_json(g) ORDER BY g.role, g.member) FROM (
    SELECT pg_get_userbyid(roleid) AS role, pg_get_userbyid(member) AS member,
      pg_get_userbyid(grantor) AS grantor, admin_option, inherit_option, set_option
    FROM pg_auth_members WHERE pg_get_userbyid(roleid) LIKE 'stk_fixture_%'
  ) g)
);
