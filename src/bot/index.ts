import TelegramBot from "node-telegram-bot-api";
import Groq from "groq-sdk";
import { logger } from "../lib/logger";
import { initDb, loadNotes, addNote, deleteNote, type ContentBlock } from "./notes";

async function buildMatchingPrompt(): Promise<string> {
  const notes = await loadNotes();
  if (notes.length === 0) {
    return `У тебя нет заметок. На любой вопрос отвечай только: NOTE:0`;
  }
  const list = notes.map((n, i) => `${i + 1}. ${n.title}`).join("\n");
  return `Ты — поисковик по базе инструкций. Твоя единственная задача: найти номер подходящей инструкции для вопроса пользователя.

Список инструкций:
${list}

Правила:
- Ответь ТОЛЬКО одним словом в формате NOTE:N, где N — номер инструкции (например NOTE:2).
- Если ни одна инструкция не подходит — ответь NOTE:0.
- Никакого другого текста, объяснений, пунктов — только NOTE:N.`;
}

interface Draft {
  title: string;
  blocks: ContentBlock[];
}

const drafts = new Map<number, Draft>();

const ADMIN_IDS = (process.env["ADMIN_IDS"] ?? "")
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => !isNaN(n) && n > 0);

function isAdmin(userId?: number): boolean {
  if (!userId) return false;
  if (ADMIN_IDS.length === 0) return true;
  return ADMIN_IDS.includes(userId);
}

async function sendNoteBlocks(bot: TelegramBot, chatId: number, noteIndex: number): Promise<boolean> {
  const notes = await loadNotes();
  const note = notes[noteIndex];
  if (!note) return false;

  for (const block of note.blocks) {
    if (block.type === "text") {
      try {
        await bot.sendMessage(chatId, block.content, { parse_mode: "Markdown" });
      } catch {
        await bot.sendMessage(chatId, block.content);
      }
    } else if (block.type === "image") {
      try {
        await bot.sendPhoto(chatId, block.content);
      } catch (err) {
        logger.error({ err }, "Failed to send photo block");
      }
    }
  }
  return true;
}

function attachHandlers(bot: TelegramBot, groq: Groq): void {
  bot.onText(/\/start/, async (msg) => {
    await bot.sendMessage(msg.chat.id, "Привет! Я AI-ассистент по ботам для буксов.");
  });

  bot.onText(/\/help/, async (msg) => {
    const adminPart = isAdmin(msg.from?.id)
      ? "\n\n📝 Управление заметками:\n/addnote [название] — начать заметку\n/done — сохранить\n/cancel — отменить\n/notes — список\n/delnote [номер] — удалить\n/backup — скачать все заметки\n/restore — восстановить (отправь файл с подписью /restore)"
      : "";
    await bot.sendMessage(msg.chat.id, `/start — новый диалог\n/help — справка${adminPart}`);
  });

  bot.onText(/\/addnote(.*)/, async (msg, match) => {
    if (!isAdmin(msg.from?.id)) return;
    const chatId = msg.chat.id;
    const title = match?.[1]?.trim() || "";
    drafts.set(chatId, { title, blocks: [] });
    await bot.sendMessage(
      chatId,
      `📝 Режим создания заметки${title ? ` "${title}"` : ""}.\n\nОтправляй текст и скрины в нужном порядке.\n/done — сохранить, /cancel — отменить.`
    );
  });

  bot.onText(/\/done/, async (msg) => {
    if (!isAdmin(msg.from?.id)) return;
    const chatId = msg.chat.id;
    const draft = drafts.get(chatId);
    if (!draft) {
      await bot.sendMessage(chatId, "Нет активной заметки. Начни с /addnote");
      return;
    }
    if (draft.blocks.length === 0) {
      await bot.sendMessage(chatId, "Заметка пустая. Добавь текст или скрин.");
      return;
    }
    if (!draft.title) {
      const firstText = draft.blocks.find((b) => b.type === "text");
      draft.title = firstText ? firstText.content.slice(0, 60) : "Заметка";
    }
    drafts.delete(chatId);
    await addNote(draft.title, draft.blocks);
    const notes = await loadNotes();
    const imgs = draft.blocks.filter((b) => b.type === "image").length;
    const txts = draft.blocks.filter((b) => b.type === "text").length;
    await bot.sendMessage(
      chatId,
      `✅ Заметка #${notes.length} сохранена (${txts} текст, ${imgs} скрин).`
    );
  });

  bot.onText(/\/cancel/, async (msg) => {
    if (!isAdmin(msg.from?.id)) return;
    const chatId = msg.chat.id;
    drafts.delete(chatId);
    await bot.sendMessage(chatId, "❌ Заметка отменена.");
  });

  bot.onText(/\/notes/, async (msg) => {
    if (!isAdmin(msg.from?.id)) return;
    const chatId = msg.chat.id;
    const notes = await loadNotes();
    if (notes.length === 0) {
      await bot.sendMessage(chatId, "Заметок нет. Добавь через /addnote");
      return;
    }
    const list = notes.map((n, i) => {
      const imgs = n.blocks.filter((b) => b.type === "image").length;
      return `${i + 1}. ${n.title}${imgs > 0 ? ` 📷×${imgs}` : ""}`;
    }).join("\n\n");
    await bot.sendMessage(chatId, `Заметки:\n\n${list}\n\nУдалить: /delnote [номер]`);
  });

  bot.onText(/\/backup/, async (msg) => {
    if (!isAdmin(msg.from?.id)) return;
    const chatId = msg.chat.id;
    const notes = await loadNotes();
    if (notes.length === 0) {
      await bot.sendMessage(chatId, "Заметок нет — нечего сохранять.");
      return;
    }
    const json = JSON.stringify(notes, null, 2);
    await bot.sendDocument(chatId, Buffer.from(json, "utf8"), {}, {
      filename: "backup_notes.json",
      contentType: "application/json",
    });
    await bot.sendMessage(chatId, `✅ Бэкап готов — ${notes.length} заметок. Сохрани этот файл!\n\nДля восстановления на новом аккаунте отправь файл боту командой /restore`);
  });

  bot.on("document", async (msg) => {
    if (!isAdmin(msg.from?.id)) return;
    const chatId = msg.chat.id;
    const caption = msg.caption?.trim() ?? "";
    if (caption !== "/restore") return;

    try {
      const fileId = msg.document!.file_id;
      const fileLink = await bot.getFileLink(fileId);
      const response = await fetch(fileLink);
      const text = await response.text();
      const imported = JSON.parse(text) as Array<{ title: string; blocks: ContentBlock[] }>;

      let count = 0;
      for (const note of imported) {
        if (note.title && Array.isArray(note.blocks)) {
          await addNote(note.title, note.blocks);
          count++;
        }
      }
      await bot.sendMessage(chatId, `✅ Восстановлено ${count} заметок из бэкапа!`);
    } catch (err) {
      logger.error({ err }, "Restore failed");
      await bot.sendMessage(chatId, "❌ Ошибка при восстановлении. Убедись что файл правильный.");
    }
  });

  bot.onText(/\/delnote (\d+)/, async (msg, match) => {
    if (!isAdmin(msg.from?.id)) return;
    const chatId = msg.chat.id;
    const num = parseInt(match?.[1] ?? "0", 10);
    const notes = await loadNotes();
    if (num < 1 || num > notes.length) {
      await bot.sendMessage(chatId, "Неверный номер. Используй /notes чтобы увидеть список.");
      return;
    }
    await deleteNote(notes[num - 1]!.id);
    await bot.sendMessage(chatId, `🗑 Заметка #${num} удалена.`);
  });

  bot.on("photo", async (msg) => {
    if (!isAdmin(msg.from?.id)) return;
    const chatId = msg.chat.id;
    const draft = drafts.get(chatId);
    if (!draft) return;

    const best = msg.photo![msg.photo!.length - 1]!;
    if (msg.caption?.trim()) {
      draft.blocks.push({ type: "text", content: msg.caption.trim() });
    }
    draft.blocks.push({ type: "image", content: best.file_id });
    await bot.sendMessage(chatId, `📷 Скрин добавлен (блок ${draft.blocks.length}). Продолжай или /done.`);
  });

  bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    if (!text || text.startsWith("/")) return;
    if (msg.photo) return;

    if (isAdmin(msg.from?.id) && drafts.has(chatId)) {
      const draft = drafts.get(chatId)!;
      draft.blocks.push({ type: "text", content: text.trim() });
      await bot.sendMessage(chatId, `✏️ Текст добавлен (блок ${draft.blocks.length}). Продолжай или /done.`);
      return;
    }

    try {
      await bot.sendChatAction(chatId, "typing");

      const prompt = await buildMatchingPrompt();
      const response = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: text },
        ],
        max_tokens: 10,
        temperature: 0,
      });

      const raw = response.choices[0]?.message?.content?.trim() ?? "NOTE:0";
      const noteMatch = raw.match(/NOTE:(\d+)/i);
      const noteNum = noteMatch ? parseInt(noteMatch[1]!, 10) : 0;

      if (noteNum === 0 || !(await sendNoteBlocks(bot, chatId, noteNum - 1))) {
        await bot.sendMessage(
          chatId,
          "К сожалению, я не знаю ответа на этот вопрос. Обратитесь в поддержку канала."
        );
      }
    } catch (err) {
      logger.error({ err }, "Error processing message");
      await bot.sendMessage(chatId, "⚠️ Произошла ошибка. Попробуй ещё раз.");
    }
  });
}

let botInstance: TelegramBot | null = null;

export function getBotInstance(): TelegramBot | null {
  return botInstance;
}

export async function startBot(): Promise<void> {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  const groqKey = process.env["GROQ_API_KEY"];

  if (!token) { logger.error("TELEGRAM_BOT_TOKEN is not set"); return; }
  if (!groqKey) { logger.error("GROQ_API_KEY is not set"); return; }

  await initDb();

  const groq = new Groq({ apiKey: groqKey });

  const rawDomains = process.env["REPLIT_DOMAINS"];
  const domain = rawDomains?.split(",")[0]?.trim();

  logger.info({ domain: domain ?? "(not set)", rawDomains: rawDomains ?? "(not set)" }, "Bot startup: detected domain");

  if (domain) {
    const bot = new TelegramBot(token, { polling: false });
    attachHandlers(bot, groq);
    botInstance = bot;

    const webhookUrl = `https://${domain}/api/bot-webhook`;
    logger.info({ webhookUrl }, "Registering webhook...");
    try {
      await bot.setWebHook(webhookUrl);
      logger.info({ webhookUrl }, "Telegram webhook registered OK");
    } catch (err) {
      logger.error({ err, webhookUrl }, "setWebHook FAILED — falling back to polling");
      await bot.closeWebHook().catch(() => {});
      const pollingBot = new TelegramBot(token, { polling: true });
      attachHandlers(pollingBot, groq);
      botInstance = pollingBot;
      logger.info("Telegram bot started (polling fallback after webhook failure)");
    }
  } else {
    logger.warn("REPLIT_DOMAINS not set, falling back to polling");
    const bot = new TelegramBot(token, { polling: true });
    attachHandlers(bot, groq);
    botInstance = bot;

    bot.on("polling_error", (err) => {
      const e = err as { code?: string; response?: { statusCode?: number } };
      if (e.code === "ETELEGRAM" && e.response?.statusCode === 409) {
        logger.warn("409 Conflict: another bot instance running. Stopping polling.");
        bot.stopPolling().catch(() => {});
        return;
      }
      logger.error({ err }, "Telegram polling error");
    });

    logger.info("Telegram bot started (polling)");
  }
}
