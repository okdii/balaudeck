// The AI chat for Redis / MongoDB / S3 / SFTP panes. App hosts it beside the
// pane; the pane reports its live connection through `onAiCtx`, read at call
// time through `get` so the tools always see the current bucket / directory.

import { AiChat } from "./AiChat";
import {
  makeMongoToolset,
  makeRedisToolset,
  makeS3Toolset,
  makeSftpToolset,
  mongoSystemPrompt,
  redisSystemPrompt,
  s3SystemPrompt,
  sftpSystemPrompt,
  type DocContext,
  type FileContext,
  type KvContext,
  type ObjContext,
  type StoreAiCtx,
} from "./ai/tools/stores";

export function StoreAiChat({ get, onClose }: { get: () => StoreAiCtx | null; onClose: () => void }) {
  const c = get();
  if (!c) return null;
  const now = <T,>() => get()!.ctx as T;
  switch (c.kind) {
    case "redis":
      return (
        <AiChat
          makeToolset={() => makeRedisToolset(() => now<KvContext>())}
          buildSystem={() => redisSystemPrompt(now<KvContext>())}
          placeholder={'Ask about this Redis — "what\'s using the most memory?", "show session keys", "keys without a TTL?".'}
          historyScope={`redis:${c.ctx.label}`}
          onClose={onClose}
        />
      );
    case "mongo":
      return (
        <AiChat
          makeToolset={() => makeMongoToolset(() => now<DocContext>())}
          buildSystem={() => mongoSystemPrompt(now<DocContext>())}
          placeholder={'Ask about this MongoDB — "which collections are biggest?", "orders over 500 this week", "fields in users?".'}
          historyScope={`mongo:${c.ctx.label}`}
          onClose={onClose}
        />
      );
    case "s3":
      return (
        <AiChat
          makeToolset={() => makeS3Toolset(() => now<ObjContext>())}
          buildSystem={() => s3SystemPrompt(now<ObjContext>())}
          placeholder={'Ask about this storage — "how big is logs/?", "newest backups", "read config.json".'}
          historyScope={`s3:${c.ctx.label}`}
          onClose={onClose}
        />
      );
    case "sftp":
      return (
        <AiChat
          makeToolset={() => makeSftpToolset(() => now<FileContext>())}
          buildSystem={() => sftpSystemPrompt(now<FileContext>())}
          placeholder={'Ask about these files — "what\'s taking space here?", "show the nginx config", "tidy up old logs".'}
          historyScope={`sftp:${c.ctx.label}`}
          onClose={onClose}
        />
      );
  }
}
