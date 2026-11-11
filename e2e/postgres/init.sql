-- Runs once on a fresh volume (docker-entrypoint-initdb.d).
CREATE DATABASE bots_e2e_legacy;   -- legacy bootstraps its own schema here
CREATE DATABASE bots_e2e_go;    -- bot-engine: schema copied from legacy by run.sh
