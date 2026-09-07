import assert from 'node:assert/strict';

const userSchema = "n.nspname not like 'pg_%' and n.nspname<>'information_schema'";

// Canonical effective ACLs compare across clusters whose internal OIDs differ.
// This application's migrations do not grant additional privileges. Changes to
// this baseline require a reviewed permission change, not automatic adoption.
export async function permissions(client) {
  const database = (
    await client.query(`select pg_get_userbyid(datdba) as owner,
    coalesce(datacl,acldefault('d',datdba))::text[] as acl,
    array(select item::text from unnest(acldefault('d',datdba)) item where item::text not like '=%') as baseline
    from pg_database where datname=current_database()`)
  ).rows;
  const schemas = (
    await client.query(`select n.nspname as name,pg_get_userbyid(n.nspowner) as owner,
    coalesce(n.nspacl,acldefault('n',n.nspowner))::text[] as acl,
    acldefault('n',n.nspowner)::text[] as baseline from pg_namespace n where ${userSchema} order by 1`)
  ).rows;
  const relations = (
    await client.query(`select quote_ident(n.nspname)||'.'||quote_ident(c.relname) as name,
    c.relkind as kind,pg_get_userbyid(c.relowner) as owner,
    coalesce(c.relacl,acldefault(case when c.relkind='S' then 's'::"char" else 'r'::"char" end,c.relowner))::text[] as acl,
    acldefault(case when c.relkind='S' then 's'::"char" else 'r'::"char" end,c.relowner)::text[] as baseline
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where ${userSchema} order by 1`)
  ).rows;
  const columns = (
    await client.query(`select quote_ident(n.nspname)||'.'||quote_ident(c.relname)||'.'||quote_ident(a.attname) as name,
    pg_get_userbyid(c.relowner) as owner,coalesce(a.attacl,acldefault('c',c.relowner))::text[] as acl,
    acldefault('c',c.relowner)::text[] as baseline
    from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
    where ${userSchema} and a.attnum>0 and not a.attisdropped order by 1`)
  ).rows;
  const routines = (
    await client.query(`select quote_ident(n.nspname)||'.'||quote_ident(p.proname)||'('||pg_get_function_identity_arguments(p.oid)||')' as name,
    p.prokind as kind,pg_get_userbyid(p.proowner) as owner,
    coalesce(p.proacl,acldefault('f',p.proowner))::text[] as acl,acldefault('f',p.proowner)::text[] as baseline
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where ${userSchema} order by 1`)
  ).rows;
  const types = (
    await client.query(`select quote_ident(n.nspname)||'.'||quote_ident(t.typname) as name,
    pg_get_userbyid(t.typowner) as owner,coalesce(t.typacl,acldefault('T',t.typowner))::text[] as acl,
    acldefault('T',t.typowner)::text[] as baseline
    from pg_type t join pg_namespace n on n.oid=t.typnamespace where ${userSchema} order by 1`)
  ).rows;
  const defaults = (
    await client.query(`select pg_get_userbyid(d.defaclrole) as owner,
    coalesce(n.nspname,'*') as schema,d.defaclobjtype as kind,d.defaclacl::text[] as acl
    from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace order by 1,2,3`)
  ).rows;
  const extensions = (
    await client.query(`select e.extname as name,e.extversion as version,
    pg_get_userbyid(e.extowner) as owner,n.nspname as schema
    from pg_extension e join pg_namespace n on n.oid=e.extnamespace order by 1`)
  ).rows;
  const largeObjects = (
    await client.query('select count(*)::text as count from pg_largeobject_metadata')
  ).rows[0].count;
  assert.deepEqual(defaults, [], 'OPS_DEFAULT_PERMISSIONS_CHANGED');
  assert.deepEqual(
    extensions,
    [{ name: 'plpgsql', version: '1.0', owner: 'postgres', schema: 'pg_catalog' }],
    'OPS_EXTENSIONS_CHANGED',
  );
  assert.equal(largeObjects, '0', 'OPS_LARGE_OBJECTS_UNEXPECTED');
  for (const [group, rows] of Object.entries({
    database,
    schemas,
    relations,
    columns,
    routines,
    types,
  })) {
    for (const row of rows) {
      const isPublic = group === 'schemas' && row.name === 'public';
      assert.equal(
        row.owner,
        isPublic ? 'pg_database_owner' : 'stakeframe_app',
        'OPS_OBJECT_OWNER_CHANGED',
      );
      const baseline = isPublic
        ? ['=U/pg_database_owner', 'pg_database_owner=UC/pg_database_owner']
        : row.baseline;
      row.acl.sort();
      assert.deepEqual(row.acl, [...baseline].sort(), 'OPS_OBJECT_PERMISSIONS_CHANGED');
      delete row.baseline;
    }
  }
  return {
    version: 1,
    database,
    schemas,
    relations,
    columns,
    routines,
    types,
    defaults,
    extensions,
    largeObjects,
  };
}
