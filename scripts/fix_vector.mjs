import pg from 'pg';
const client = new pg.Client({
  connectionString: 'postgresql://postgres.qqieiiwocxkxujdfjpxl:bm7bLsLm5gSBfFIm@aws-0-ap-south-1.pooler.supabase.com:5432/postgres',
  ssl: {
    rejectUnauthorized: false,
    servername: 'aws-0-ap-south-1.pooler.supabase.com'
  }
});
try {
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
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
