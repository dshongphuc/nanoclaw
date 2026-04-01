import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';

vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-ipc-test',
  IPC_POLL_INTERVAL: 100,
  TIMEZONE: 'UTC',
}));
vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./db.js', () => ({
  createTask: vi.fn(),
  deleteTask: vi.fn(),
  getTaskById: vi.fn(),
  updateTask: vi.fn(),
}));
vi.mock('./group-folder.js', () => ({
  isValidGroupFolder: vi.fn(() => true),
  resolveGroupFolderPath: vi.fn((folder: string) => `/tmp/groups/${folder}`),
}));

import { processIpcMessage } from './ipc.js';
import { resolveGroupFolderPath } from './group-folder.js';

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
    fs.mkdirSync('/tmp/groups/whatsapp_main', { recursive: true });
    fs.writeFileSync('/tmp/groups/whatsapp_main/screenshot.png', 'fake-image-bytes');
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
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('deletes the image file after sending', async () => {
    await processIpcMessage(
      { type: 'message', chatJid: '123@s.whatsapp.net', image: 'screenshot.png' },
      'whatsapp_main',
      true,
      deps,
    );

    expect(fs.existsSync('/tmp/groups/whatsapp_main/screenshot.png')).toBe(false);
  });

  it('falls back to sendMessage if image file is missing', async () => {
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

  it('sends text message when no image field', async () => {
    await processIpcMessage(
      { type: 'message', chatJid: '123@s.whatsapp.net', text: 'hello' },
      'whatsapp_main',
      true,
      deps,
    );

    expect(mockSendMessage).toHaveBeenCalledWith('123@s.whatsapp.net', 'hello');
    expect(mockSendImage).not.toHaveBeenCalled();
  });

  it('blocks unauthorized message from non-main group', async () => {
    await processIpcMessage(
      { type: 'message', chatJid: '123@s.whatsapp.net', text: 'sneaky' },
      'other_group',
      false,
      deps,
    );

    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockSendImage).not.toHaveBeenCalled();
  });
});
