# Image Send/Receive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow the WhatsApp agent to send images (e.g. screenshots) back to the user, and receive images from the user with visual understanding.

**Architecture:** The group folder (`/workspace/group`) is already mounted read-write in containers and accessible on the host. For outbound images, the agent saves a file there and writes an IPC message with an `image` field; the host reads the file, sends it via Baileys, then deletes it. For inbound images, the host downloads via Baileys, saves to the group folder, and delivers the filename in the message content so the agent can read it directly.

**Tech Stack:** TypeScript, Baileys (`@whiskeysockets/baileys`), Vitest, Node.js `fs`

---

## File Map

| File | Change |
|------|--------|
| `src/types.ts` | Add `sendImage?()` to `Channel` interface; add `image?`/`caption?` fields to a new `IpcMessage` type |
| `src/channels/whatsapp.ts` | Implement `sendImage()` using Baileys; download inbound images; emit filename in message content |
| `src/ipc.ts` | Handle `image` field in IPC message dispatch; call `sendImage` via new `IpcDeps.sendImage` callback |
| `src/index.ts` | Wire `sendImage` into `IpcDeps`; clean up incoming image files after agent session ends |
| `src/channels/whatsapp.test.ts` | Tests for `sendImage()` and inbound image handling |

---

## Task 1: Extend types — `Channel.sendImage` and `IpcMessage`

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add `sendImage` to Channel interface and export IpcMessage type**

In `src/types.ts`, add after the `setTyping?` line inside the `Channel` interface:

```typescript
  // Optional: send an image. Buffer is the raw image bytes.
  sendImage?(jid: string, buffer: Buffer, caption?: string): Promise<void>;
```

Also add a new exported type at the bottom of the file:

```typescript
export interface IpcMessage {
  type: 'message';
  chatJid: string;
  text?: string;
  image?: string;   // filename relative to the group folder (e.g. "screenshot.png")
  caption?: string; // optional caption to accompany the image
}
```

- [ ] **Step 2: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): add sendImage to Channel interface and IpcMessage type"
```

---

## Task 2: Implement `sendImage` in WhatsApp channel

**Files:**
- Modify: `src/channels/whatsapp.ts`

- [ ] **Step 1: Write failing test for `sendImage`**

In `src/channels/whatsapp.test.ts`, add this test after the existing `sendMessage` tests:

```typescript
describe('sendImage', () => {
  it('sends image buffer via Baileys', async () => {
    const channel = new WhatsAppChannel(createTestOpts());
    await channel.connect();
    triggerConnection('open');

    const buffer = Buffer.from('fake-png-bytes');
    await channel.sendImage('84933391494@s.whatsapp.net', buffer, 'Hello');

    expect(fakeSocket.sendMessage).toHaveBeenCalledWith(
      '84933391494@s.whatsapp.net',
      { image: buffer, caption: 'Andy: Hello' },
    );
  });

  it('sends image without caption when none provided', async () => {
    const channel = new WhatsAppChannel(createTestOpts());
    await channel.connect();
    triggerConnection('open');

    const buffer = Buffer.from('fake-png-bytes');
    await channel.sendImage('84933391494@s.whatsapp.net', buffer);

    expect(fakeSocket.sendMessage).toHaveBeenCalledWith(
      '84933391494@s.whatsapp.net',
      { image: buffer },
    );
  });

  it('queues image when disconnected', async () => {
    const channel = new WhatsAppChannel(createTestOpts());
    await channel.connect();
    triggerConnection('open');
    triggerDisconnect(408);

    const buffer = Buffer.from('fake-png-bytes');
    await channel.sendImage('84933391494@s.whatsapp.net', buffer, 'queued');

    expect(fakeSocket.sendMessage).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ image: expect.anything() }),
    );
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd /home/phuc/Documents/code/nanoclaw
npx vitest run src/channels/whatsapp.test.ts 2>&1 | tail -20
```

Expected: FAIL — `channel.sendImage is not a function`

- [ ] **Step 3: Add `outgoingImageQueue` field and `sendImage` method to `WhatsAppChannel`**

Add a private field alongside `outgoingQueue` in the class body (around line 64):

```typescript
private outgoingImageQueue: Array<{ jid: string; buffer: Buffer; caption?: string }> = [];
```

Add `sendImage` method after `sendMessage` (around line 387):

```typescript
async sendImage(jid: string, buffer: Buffer, caption?: string): Promise<void> {
  const prefixedCaption = caption
    ? (ASSISTANT_HAS_OWN_NUMBER ? caption : `${ASSISTANT_NAME}: ${caption}`)
    : undefined;

  if (!this.connected) {
    this.outgoingImageQueue.push({ jid, buffer, caption: prefixedCaption });
    logger.info(
      { jid, queueSize: this.outgoingImageQueue.length },
      'WA disconnected, image queued',
    );
    return;
  }
  try {
    const msg = prefixedCaption
      ? { image: buffer, caption: prefixedCaption }
      : { image: buffer };
    await this.sock.sendMessage(jid, msg);
    logger.info({ jid, bytes: buffer.length }, 'Image sent');
  } catch (err) {
    this.outgoingImageQueue.push({ jid, buffer, caption: prefixedCaption });
    logger.warn({ jid, err }, 'Failed to send image, queued');
  }
}
```

Also add image queue flushing inside the existing `flushOutgoingQueue` method (find where `this.outgoingQueue` items are sent and add after it):

```typescript
// Flush queued images
const imagesToFlush = [...this.outgoingImageQueue];
this.outgoingImageQueue = [];
for (const item of imagesToFlush) {
  await this.sendImage(item.jid, item.buffer, item.caption);
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx vitest run src/channels/whatsapp.test.ts 2>&1 | tail -10
```

Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
git add src/channels/whatsapp.ts src/channels/whatsapp.test.ts
git commit -m "feat(whatsapp): implement sendImage with queue support"
```

---

## Task 3: Receive inbound images in WhatsApp channel

**Files:**
- Modify: `src/channels/whatsapp.ts`
- Modify: `src/channels/whatsapp.test.ts`

- [ ] **Step 1: Add `downloadMediaMessage` to Baileys mock in test file**

In `src/channels/whatsapp.test.ts`, update the Baileys mock to add `downloadMediaMessage`:

```typescript
vi.mock('@whiskeysockets/baileys', () => {
  return {
    // ... existing mock entries ...
    downloadMediaMessage: vi.fn().mockResolvedValue(Buffer.from('fake-image')),
  };
});
```

Also update the import at the top of the test file to import `downloadMediaMessage`:

```typescript
import { WhatsAppChannel, WhatsAppChannelOpts } from './whatsapp.js';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
```

- [ ] **Step 2: Write failing test for inbound image**

Add in `src/channels/whatsapp.test.ts` inside the `messages.upsert` describe block:

```typescript
it('delivers inbound imageMessage as [Image: filename] content', async () => {
  const onMessage = vi.fn();
  const channel = new WhatsAppChannel(createTestOpts({ onMessage }));
  await channel.connect();
  triggerConnection('open');

  // Simulate an incoming image message
  fakeSocket._ev.emit('messages.upsert', {
    messages: [
      {
        key: { remoteJid: 'registered@g.us', fromMe: false },
        messageTimestamp: 1000,
        pushName: 'Alice',
        message: {
          imageMessage: {
            caption: 'check this out',
            mimetype: 'image/jpeg',
          },
        },
      },
    ],
  });

  await new Promise((r) => setTimeout(r, 50));

  expect(onMessage).toHaveBeenCalledWith(
    'registered@g.us',
    expect.objectContaining({
      content: expect.stringMatching(/^\[Image: incoming-.*\.jpg\] check this out$/),
    }),
  );
});
```

- [ ] **Step 3: Run test to confirm it fails**

```bash
npx vitest run src/channels/whatsapp.test.ts 2>&1 | tail -20
```

Expected: FAIL — image message content is empty string (current code skips images with no text)

- [ ] **Step 4: Add `downloadMediaMessage` import and inbound image handling**

At the top of `src/channels/whatsapp.ts`, add to the Baileys import:

```typescript
import {
  makeWASocket,
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  useMultiFileAuthState,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';
```

In the `messages.upsert` handler, find this block (around line 288):

```typescript
let content =
  normalized.conversation ||
  normalized.extendedTextMessage?.text ||
  normalized.imageMessage?.caption ||
  normalized.videoMessage?.caption ||
  '';
```

Replace it with:

```typescript
let content =
  normalized.conversation ||
  normalized.extendedTextMessage?.text ||
  '';

// Handle inbound image: download and save to group folder
if (normalized.imageMessage) {
  try {
    const buffer = await downloadMediaMessage(
      msg,
      'buffer',
      {},
    ) as Buffer;
    const groupDir = resolveGroupFolderPath(groups[chatJid].folder);
    const filename = `incoming-${Date.now()}.jpg`;
    const filePath = path.join(groupDir, filename);
    fs.writeFileSync(filePath, buffer);
    const caption = normalized.imageMessage.caption || '';
    content = caption
      ? `[Image: ${filename}] ${caption}`
      : `[Image: ${filename}]`;
    logger.info({ chatJid, filename }, 'Inbound image saved');
  } catch (err) {
    logger.error({ err, chatJid }, 'Failed to download inbound image');
    content = normalized.imageMessage.caption || '[Image: download failed]';
  }
}
```

Also add the missing import at the top of the file (after the Baileys imports):

```typescript
import { resolveGroupFolderPath } from '../group-folder.js';
```

- [ ] **Step 5: Run tests**

```bash
npx vitest run src/channels/whatsapp.test.ts 2>&1 | tail -10
```

Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
git add src/channels/whatsapp.ts src/channels/whatsapp.test.ts
git commit -m "feat(whatsapp): download and save inbound images to group folder"
```

---

## Task 4: IPC — dispatch outbound images from agent

**Files:**
- Modify: `src/ipc.ts`

- [ ] **Step 1: Write failing test for image IPC dispatch**

In `src/ipc.ts` test file — there is no dedicated `ipc.test.ts`, so check if one exists:

```bash
ls /home/phuc/Documents/code/nanoclaw/src/ipc*.test.ts 2>/dev/null || echo "no test file"
```

If no test file exists, create `src/ipc-image.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';

vi.mock('../config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-ipc-test',
  IPC_POLL_INTERVAL: 100,
  TIMEZONE: 'UTC',
}));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../db.js', () => ({
  createTask: vi.fn(),
  deleteTask: vi.fn(),
  getTaskById: vi.fn(),
  updateTask: vi.fn(),
}));
vi.mock('../group-folder.js', () => ({
  isValidGroupFolder: vi.fn(() => true),
  resolveGroupFolderPath: vi.fn((folder: string) => `/tmp/groups/${folder}`),
}));

import { processIpcMessage } from '../ipc.js';

describe('processIpcMessage image dispatch', () => {
  const mockSendImage = vi.fn().mockResolvedValue(undefined);
  const mockSendMessage = vi.fn().mockResolvedValue(undefined);

  const deps = {
    sendMessage: mockSendMessage,
    sendImage: mockSendImage,
    registeredGroups: () => ({
      '123@s.whatsapp.net': {
        name: 'Self Chat',
        folder: 'whatsapp_main',
        trigger: '@Andy',
        added_at: '',
        isMain: true,
      },
    }),
    registerGroup: vi.fn(),
    syncGroups: vi.fn(),
    getAvailableGroups: vi.fn(() => []),
    writeGroupsSnapshot: vi.fn(),
    onTasksChanged: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Create fake image file
    fs.mkdirSync('/tmp/groups/whatsapp_main', { recursive: true });
    fs.writeFileSync('/tmp/groups/whatsapp_main/screenshot.png', 'fake');
  });

  it('reads image file from group folder and calls sendImage', async () => {
    await processIpcMessage(
      { type: 'message', chatJid: '123@s.whatsapp.net', image: 'screenshot.png', caption: 'here it is' },
      'whatsapp_main',
      true,
      deps,
    );

    expect(mockSendImage).toHaveBeenCalledWith(
      '123@s.whatsapp.net',
      expect.any(Buffer),
      'here it is',
    );
  });

  it('falls back to sendMessage if image file missing', async () => {
    await processIpcMessage(
      { type: 'message', chatJid: '123@s.whatsapp.net', image: 'missing.png' },
      'whatsapp_main',
      true,
      deps,
    );

    expect(mockSendImage).not.toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledWith(
      '123@s.whatsapp.net',
      '[Image not found: missing.png]',
    );
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
npx vitest run src/ipc-image.test.ts 2>&1 | tail -20
```

Expected: FAIL — `processIpcMessage` not exported / no `sendImage` in deps

- [ ] **Step 3: Update `IpcDeps` and add `processIpcMessage` export in `src/ipc.ts`**

In `src/ipc.ts`, update the `IpcDeps` interface to add `sendImage`:

```typescript
export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendImage: (jid: string, buffer: Buffer, caption?: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  onTasksChanged: () => void;
}
```

Add the import for `resolveGroupFolderPath` at the top of `src/ipc.ts`:

```typescript
import { resolveGroupFolderPath } from './group-folder.js';
```

Extract the inline message processing logic into an exported function `processIpcMessage`. Find the existing block inside `processIpcFiles` that handles `data.type === 'message'` (around line 77):

```typescript
if (data.type === 'message' && data.chatJid && data.text) {
  // Authorization check...
  await deps.sendMessage(data.chatJid, data.text);
}
```

Replace it with a call to the new function:

```typescript
if (data.type === 'message') {
  await processIpcMessage(data, sourceGroup, isMain, deps);
}
```

Add the exported function (place it before `processTaskIpc`):

```typescript
export async function processIpcMessage(
  data: {
    type: string;
    chatJid?: string;
    text?: string;
    image?: string;
    caption?: string;
  },
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<void> {
  if (!data.chatJid) return;
  const registeredGroups = deps.registeredGroups();
  const targetGroup = registeredGroups[data.chatJid];

  // Authorization: non-main groups can only send to their own chat
  if (!isMain && (!targetGroup || targetGroup.folder !== sourceGroup)) {
    logger.warn({ chatJid: data.chatJid, sourceGroup }, 'Unauthorized IPC message attempt blocked');
    return;
  }

  if (data.image) {
    const groupDir = resolveGroupFolderPath(sourceGroup);
    const imagePath = path.join(groupDir, data.image);
    if (!fs.existsSync(imagePath)) {
      logger.warn({ imagePath }, 'IPC image file not found');
      await deps.sendMessage(data.chatJid, `[Image not found: ${data.image}]`);
      return;
    }
    const buffer = fs.readFileSync(imagePath);
    await deps.sendImage(data.chatJid, buffer, data.caption);
    fs.unlinkSync(imagePath);
    logger.info({ chatJid: data.chatJid, image: data.image }, 'IPC image sent');
    return;
  }

  if (data.text) {
    await deps.sendMessage(data.chatJid, data.text);
    logger.info({ chatJid: data.chatJid, sourceGroup }, 'IPC message sent');
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/ipc-image.test.ts 2>&1 | tail -10
```

Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
git add src/ipc.ts src/ipc-image.test.ts
git commit -m "feat(ipc): handle image field in IPC messages, dispatch via sendImage"
```

---

## Task 5: Wire `sendImage` into `index.ts` and clean up incoming files

**Files:**
- Modify: `src/index.ts`
- Modify: `src/router.ts`

- [ ] **Step 1: Add `routeOutboundImage` to `router.ts`**

In `src/router.ts`, add after `routeOutbound`:

```typescript
export function routeOutboundImage(
  channels: Channel[],
  jid: string,
  buffer: Buffer,
  caption?: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  if (!channel.sendImage) throw new Error(`Channel does not support images: ${channel.name}`);
  return channel.sendImage(jid, buffer, caption);
}
```

- [ ] **Step 2: Wire `sendImage` into `IpcDeps` in `src/index.ts`**

Find where `startIpcWatcher` is called in `src/index.ts` and add `sendImage` to the deps object:

```typescript
startIpcWatcher({
  sendMessage: (jid, text) => routeOutbound(channels, jid, text),
  sendImage: (jid, buffer, caption) => routeOutboundImage(channels, jid, buffer, caption),
  // ... rest of existing deps
});
```

Also add the import for `routeOutboundImage` in the import from `./router.js`:

```typescript
import { findChannel, formatMessages, formatOutbound, routeOutboundImage } from './router.js';
```

- [ ] **Step 3: Clean up incoming image files after agent session ends**

In `src/index.ts`, find the `processGroup` function and the section after `runAgent` returns (around line 310). Add a cleanup step after the agent call:

```typescript
const output = await runAgent(group, prompt, chatJid, async (result) => {
  // ... existing streaming callback ...
});

// Clean up any incoming image files written to the group folder during this session
const groupDir = resolveGroupFolderPath(group.folder);
try {
  const files = fs.readdirSync(groupDir).filter((f) => f.startsWith('incoming-'));
  for (const f of files) {
    fs.unlinkSync(path.join(groupDir, f));
  }
} catch {
  // Non-fatal — best effort cleanup
}
```

- [ ] **Step 4: Build to verify no TypeScript errors**

```bash
npm run build 2>&1
```

Expected: clean build, no errors

- [ ] **Step 5: Commit**

```bash
git add src/router.ts src/index.ts
git commit -m "feat(index): wire sendImage into IPC deps and clean up incoming images after session"
```

---

## Task 6: Update container skills — document image capability for the agent

**Files:**
- Modify: `container/skills/agent-browser/SKILL.md`

- [ ] **Step 1: Add image sending instructions to agent-browser skill**

In `container/skills/agent-browser/SKILL.md`, find the screenshot section and add a note after it about how to send screenshots back:

```bash
grep -n "screenshot" container/skills/agent-browser/SKILL.md | head -10
```

After the screenshot command documentation, add:

```markdown
### Sending a screenshot via WhatsApp

After taking a screenshot, write an IPC message to send it:

```bash
# 1. Take the screenshot (saves to /workspace/group/ by default with --output)
agent-browser screenshot --output /workspace/group/screenshot.png

# 2. Send via IPC — NANOCLAW_CHAT_JID is already injected into the container
node -e "
const fs = require('fs');
const msg = { type: 'message', chatJid: process.env.NANOCLAW_CHAT_JID, image: 'screenshot.png', caption: 'Here is the screenshot' };
fs.mkdirSync('/workspace/ipc/messages', { recursive: true });
fs.writeFileSync('/workspace/ipc/messages/img-' + Date.now() + '.json', JSON.stringify(msg));
"
```

The host will read the file, send it to WhatsApp, and delete it automatically.
```

- [ ] **Step 2: Check agent-browser screenshot output path**

```bash
grep -n "output\|screenshot\|save\|png" container/skills/agent-browser/SKILL.md | head -20
```

Confirm the `--output` flag syntax matches what's in the skill docs. If different, adjust the IPC example above to use the correct flag.

- [ ] **Step 3: Commit**

```bash
git add container/skills/agent-browser/SKILL.md
git commit -m "docs(container): document how agent sends screenshots via IPC image field"
```

---

## Task 7: End-to-end test

- [ ] **Step 1: Run full test suite**

```bash
npx vitest run 2>&1 | tail -20
```

Expected: all tests pass

- [ ] **Step 2: Build and restart service**

```bash
npm run build && systemctl --user restart nanoclaw && echo "Done"
```

- [ ] **Step 3: Test outbound image (send a screenshot)**

Send to WhatsApp self-chat: `take a screenshot of https://example.com and send it to me`

Expected: Andy takes a screenshot and the image appears in WhatsApp within ~30 seconds.

- [ ] **Step 4: Test inbound image (send an image to Andy)**

Send any image to the WhatsApp self-chat with caption: `what's in this image?`

Expected: Andy responds describing what's in the image.

- [ ] **Step 5: Push to GitHub**

```bash
git push origin main
```

---

## Notes

- `NANOCLAW_CHAT_JID` is already injected into every container as an env var — agents can use it directly in IPC messages.
- Image cleanup (incoming files) is best-effort. Files older than 1 hour could also be cleaned on startup as a future improvement.
