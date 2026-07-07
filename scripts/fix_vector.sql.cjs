const { Client } = require('pg');
const client = new Client({
  host: '2406:da1c:61c:d602:b449:7c49:1e91:76c6',
  port: 5432,
  user: 'postgres',
  password: 'bm7bLsLm5gSBfFIm',
  database: 'postgres',
  ssl: { rejectUnauthorized: false }
});
(async () => {
  await client.connect();
  console.log('Connected');
  await client.query('DROP INDEX IF EXISTS notes_embedding_idx');
  console.log('Dropped old index');
  await client.query('ALTER TABLE notes ALTER COLUMN embedding TYPE vector(256)');
  console.log('Altered column to vector(256)');
  await client.query('CREATE INDEX notes_embedding_idx ON notes USING hnsw (embedding vector_cosine_ops)');
  console.log('Created new HNSW index');
  await client.end();
  console.log('Done');
})().catch(e => { console.error(e.message); process.exit(1); });
