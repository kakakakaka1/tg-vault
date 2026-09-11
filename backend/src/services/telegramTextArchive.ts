/**
 * Telegram 文本消息归档
 *
 * 上游 tg-vault 只把「带媒体的消息」交给 handleFileUpload 入库，纯文本消息
 * （非命令）此前只会回一句提示、不落库。本模块补上这一环：把私聊给 Bot 的
 * 文本消息写成 .txt 存入当前激活的存储目标，并登记到 files 表，
 * 从而在 Web 控制台里可浏览、可预览、可下载、可删除。
 *
 * 开关：环境变量 TELEGRAM_TEXT_ARCHIVE（默认 true，设为 false/0/off 关闭）
 *      TELEGRAM_TEXT_ARCHIVE_REPLY（默认 true，是否回复归档确认）
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TelegramClient } from 'telegram';
import { NewMessageEvent } from 'telegram/events/index.js';

import { query } from '../db/index.js';
import { storageManager } from './storage.js';
import { saveAndIndexWithCompensation } from './storageWrite.js';
import { getUniqueStoredName } from '../utils/fileUtils.js';
import { buildStorageFolderWithRules, getStoragePathRules, getTelegramChatName } from '../utils/storagePath.js';
import { getFileType } from '../utils/fileMetadata.js';

const TEXT_MIME = 'text/plain';
const MAX_ARCHIVE_CHARS = 100_000;

function envFlag(name: string, defaultValue: boolean): boolean {
    const raw = (process.env[name] ?? '').trim().toLowerCase();
    if (!raw) return defaultValue;
    return !['0', 'false', 'no', 'off'].includes(raw);
}

export function isTextArchiveEnabled(): boolean {
    return envFlag('TELEGRAM_TEXT_ARCHIVE', true);
}

export function isTextArchiveReplyEnabled(): boolean {
    return envFlag('TELEGRAM_TEXT_ARCHIVE_REPLY', true);
}

function pad(n: number): string {
    return n < 10 ? `0${n}` : String(n);
}

/** 本地时间的 YYYYMMDD-HHmmss */
function stampOf(date: Date): string {
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
        + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** 把文本首行压成安全的文件名片段 */
function slugOf(text: string, limit = 60): string {
    const cleaned = text
        .split(/\r?\n/)[0]
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, ' ')
        .replace(/^[.\s]+/, '')
        .trim()
        .slice(0, limit)
        .replace(/[.\s]+$/, '');
    return cleaned || 'text';
}

export interface TextArchiveResult {
    saved: boolean;
    fileName?: string;
    folder?: string | null;
    storedPath?: string;
    error?: string;
}

/**
 * 归档一条纯文本消息。调用方需自行保证：已认证、非命令、无媒体、无待处理的交互状态。
 */
export async function archiveTextMessage(client: TelegramClient, event: NewMessageEvent): Promise<TextArchiveResult> {
    const message = event.message;
    const rawText = (message.text || '').trim();
    if (!rawText) return { saved: false };
    if (rawText.length > MAX_ARCHIVE_CHARS) return { saved: false, error: '文本过长，已跳过归档' };

    const senderId = message.senderId?.toJSNumber();
    const chatId = message.chatId;
    if (!senderId || !chatId) return { saved: false };

    const when = new Date((message.date || Math.floor(Date.now() / 1000)) * 1000);
    const chatName = await getTelegramChatName(message).catch(() => null);
    const fileName = `${stampOf(when)}_${slugOf(rawText)}.txt`;

    const body = [
        'Telegram 文本归档',
        '=================',
        `时间     : ${when.toLocaleString('sv-SE')}`,
        `会话     : ${chatName || String(chatId)}`,
        `会话 ID  : ${String(chatId)}`,
        `发送者 ID: ${senderId}`,
        `消息 ID  : ${message.id}`,
        '',
        '-------- 正文 --------',
        '',
        rawText,
        '',
    ].join('\n');

    const tempPath = path.join(os.tmpdir(), `tgvault-text-${Date.now()}-${message.id}.txt`);
    fs.writeFileSync(tempPath, body, { encoding: 'utf-8', mode: 0o600 });

    try {
        const { provider, accountId } = storageManager.getActiveTarget();
        const rules = await getStoragePathRules();
        const folder = buildStorageFolderWithRules({
            source: 'telegram',
            chatName: chatName || undefined,
            mimeType: TEXT_MIME,
            fileName,
        }, rules);
        const storedName = await getUniqueStoredName(fileName, folder, accountId);
        const size = Buffer.byteLength(body, 'utf-8');
        const type = getFileType(TEXT_MIME);

        const storedPath = await saveAndIndexWithCompensation(
            provider,
            tempPath,
            storedName,
            TEXT_MIME,
            folder,
            async (savedPath: string) => {
                await query(
                    `INSERT INTO files
                     (name, stored_name, type, mime_type, size, path, source, folder,
                      storage_account_id, derivative_status)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                    [fileName, storedName, type, TEXT_MIME, size, savedPath, 'telegram', folder, accountId, 'not_required'],
                );
            },
        );

        console.log(`🤖 文本已归档: ${fileName} -> ${storedPath}`);
        return { saved: true, fileName, folder, storedPath };
    } catch (error) {
        const message_ = error instanceof Error ? error.message : String(error);
        console.error('🤖 文本归档失败:', message_);
        return { saved: false, error: message_ };
    } finally {
        try {
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        } catch { /* 忽略清理失败 */ }
    }
}
