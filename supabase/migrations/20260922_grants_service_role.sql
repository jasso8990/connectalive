-- service_role bypassa RLS pero SÍ necesita GRANT explícito sobre el schema
-- y sus tablas. Sin esto, la Netlify Function `token.js` (que usa
-- service_role) revienta con "permission denied for schema connectalive"
-- al buscar el participante para firmar el JWT de LiveKit.

grant usage on schema connectalive to service_role;
grant all on all tables in schema connectalive to service_role;
grant all on all sequences in schema connectalive to service_role;
grant all on all functions in schema connectalive to service_role;
alter default privileges in schema connectalive
  grant all on tables to service_role;
alter default privileges in schema connectalive
  grant all on sequences to service_role;
alter default privileges in schema connectalive
  grant all on functions to service_role;
