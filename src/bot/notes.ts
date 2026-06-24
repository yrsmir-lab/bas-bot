import { Pool } from "pg";
import { logger } from "../lib/logger";
const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
export interface ContentBlock {
  type: "text" | "image";
  content: string;
}
export interface Note {
  id: number;
  title: string;
  blocks: ContentBlock[];
  createdAt: string;
}
export async function initDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_notes (
      id BIGINT PRIMARY KEY,
      title TEXT NOT NULL,
      blocks JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  logger.info("bot_notes table ready");
}
export async function loadNotes(): Promise<Note[]> {
  const res = await pool.query(
    "SELECT id, title, blocks, created_at FROM bot_notes ORDER BY created_at ASC"
  );
  return res.rows.map((r) => ({
    id: Number(r.id),
    title: r.title as string,
    blocks: r.blocks as ContentBlock[],
    createdAt: r.created_at as string,
  }));
}
export async function addNote(title: string, blocks: ContentBlock[]): Promise<Note> {
  const id = Date.now();
  await pool.query(
    "INSERT INTO bot_notes (id, title, blocks) VALUES ($1, $2, $3)",
    [id, title, JSON.stringify(blocks)]
  );
  return { id, title, blocks, createdAt: new Date().toISOString() };
}
export async function deleteNote(id: number): Promise<boolean> {
  const res = await pool.query("DELETE FROM bot_notes WHERE id = $1", [id]);
  return (res.rowCount ?? 0) > 0;
}
export async function updateNote(id: number, title: string, blocks: ContentBlock[]): Promise<boolean> {
  const res = await pool.query(
    "UPDATE bot_notes SET title = $2, blocks = $3 WHERE id = $1",
    [id, title, JSON.stringify(blocks)]
  );
  return (res.rowCount ?? 0) > 0;
}
