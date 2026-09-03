const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const port = 3300 + Math.floor(Math.random() * 1000);
const dbPath = path.join(os.tmpdir(), `kept-sync-smoke-${process.pid}.sqlite`);
const base = `http://127.0.0.1:${port}/api`;

async function request(pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${pathname} failed: ${response.status} ${await response.text()}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function waitForServer(child) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early with ${child.exitCode}`);
    try {
      await request('/setup/status');
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  }
  throw new Error('Server did not start in time.');
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

async function main() {
  const child = childProcess.spawn('node', ['server/server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), SQLITE_PATH: dbPath },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', chunk => process.stdout.write(chunk));
  child.stderr.on('data', chunk => process.stderr.write(chunk));

  try {
    await waitForServer(child);
    await request('/setup/admin', {
      method: 'POST',
      body: JSON.stringify({ username: 'sync-test', displayName: 'Sync Test', password: 'test-password-123' })
    });
    const login = await request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'sync-test', password: 'test-password-123' })
    });
    const token = login.token;
    const headers = authHeaders(token);
    await request('/users', {
      method: 'POST',
      headers,
      body: JSON.stringify({ username: 'sync-collab', displayName: 'Sync Collaborator', password: 'test-password-456' })
    });
    const collabLogin = await request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'sync-collab', password: 'test-password-456' })
    });
    const collabToken = collabLogin.token;
    const collabHeaders = authHeaders(collabToken);
    const now = Date.now();

    const noteAndReminder = await request('/sync/mutations', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        mutations: [
          {
            type: 'reminder.upsert',
            syncId: 'reminder-smoke',
            payload: {
              syncId: 'reminder-smoke',
              noteId: -now,
              noteSyncId: 'note-smoke',
              locationName: 'Home',
              latitude: 43.2,
              longitude: -79.8,
              radiusMeters: 100,
              locationTrigger: 'arrive',
              timezone: 'America/Toronto',
              status: 'pending'
            },
            lww: { physicalMs: now, logical: 1, deviceId: 'smoke-device', operationId: 'reminder-op' }
          },
          {
            type: 'note.upsert',
            syncId: 'note-smoke',
            payload: {
              syncId: 'note-smoke',
              id: -now,
              noteTitle: 'Offline note',
              noteBody: 'Created offline',
              pinned: false,
              bgColor: '',
              bgImage: '',
              checkBoxes: [],
              images: [],
              isCbox: false,
              labels: [],
              archived: false,
              trashed: false
            },
            lww: { physicalMs: now, logical: 0, deviceId: 'smoke-device', operationId: 'note-op' }
          }
        ]
      })
    });
    assert(noteAndReminder.results.every(result => result.ok), JSON.stringify(noteAndReminder.results));
    const note = noteAndReminder.snapshot.notes.find(item => item.syncId === 'note-smoke');
    const reminder = noteAndReminder.snapshot.reminders.find(item => item.syncId === 'reminder-smoke');
    assert(note?.id > 0, 'offline note should receive a server id');
    assert.strictEqual(reminder?.noteId, note.id, 'reminder should resolve noteSyncId to server note id');
    assert.strictEqual(reminder?.locationTrigger, 'arrive');

    const secondNoteResult = await request('/sync/mutations', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        mutations: [{
          type: 'note.upsert',
          syncId: 'note-second',
          payload: {
            syncId: 'note-second',
            noteTitle: 'Second note',
            noteBody: '',
            pinned: false,
            bgColor: '',
            bgImage: '',
            checkBoxes: [],
            images: [],
            isCbox: false,
            labels: [],
            archived: false,
            trashed: false
          },
          lww: { physicalMs: now + 2, logical: 0, deviceId: 'smoke-device', operationId: 'note-second-op' }
        }]
      })
    });
    assert(secondNoteResult.results[0].ok);
    const cursorBeforeReorder = secondNoteResult.snapshot.cursor;
    const reordered = await request('/sync/mutations', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        mutations: [{
          type: 'note.reorder',
          syncId: 'order-smoke',
          payload: { syncIds: ['note-smoke', 'note-second'] },
          lww: { physicalMs: now + 3, logical: 0, deviceId: 'smoke-device', operationId: 'order-op' }
        }]
      })
    });
    assert(reordered.results[0].ok, JSON.stringify(reordered.results[0]));
    assert.deepStrictEqual(
      reordered.snapshot.notes.filter(item => ['note-smoke', 'note-second'].includes(item.syncId)).map(item => item.syncId),
      ['note-smoke', 'note-second'],
      'offline reorder should persist through the per-user position table'
    );
    const reorderChanges = await request(`/sync/changes?cursor=${cursorBeforeReorder}`, { headers });
    const reorderedPayloads = reorderChanges.changes
      .filter(change => change.operation === 'upsert' && ['note-smoke', 'note-second'].includes(change.resourceSyncId))
      .map(change => change.payload);
    const firstPayload = reorderedPayloads.find(item => item.syncId === 'note-smoke');
    const secondPayload = reorderedPayloads.find(item => item.syncId === 'note-second');
    assert(
      firstPayload.sortOrder > secondPayload.sortOrder,
      'incremental sync payloads should retain the user-specific reordered positions'
    );

    const newer = now + 5000;
    const older = now + 1000;
    await request('/sync/mutations', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        mutations: [{
          type: 'note.upsert',
          syncId: 'lww-note',
          payload: {
            syncId: 'lww-note',
            noteTitle: 'newer',
            noteBody: 'winner',
            pinned: false,
            bgColor: '',
            bgImage: '',
            checkBoxes: [],
            images: [],
            isCbox: false,
            labels: [],
            archived: false,
            trashed: false
          },
          lww: { physicalMs: newer, logical: 0, deviceId: 'b', operationId: 'newer' }
        }]
      })
    });
    const olderResult = await request('/sync/mutations', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        mutations: [{
          type: 'note.upsert',
          syncId: 'lww-note',
          payload: {
            syncId: 'lww-note',
            noteTitle: 'older',
            noteBody: 'loser',
            pinned: false,
            bgColor: '',
            bgImage: '',
            checkBoxes: [],
            images: [],
            isCbox: false,
            labels: [],
            archived: false,
            trashed: false
          },
          lww: { physicalMs: older, logical: 0, deviceId: 'a', operationId: 'older' }
        }]
      })
    });
    assert.strictEqual(olderResult.results[0].skipped, true, 'older LWW write should be skipped');
    assert.strictEqual(olderResult.snapshot.notes.find(item => item.syncId === 'lww-note').noteTitle, 'newer');

    const sharedNote = await request('/notes', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        syncId: 'shared-pin-note',
        noteTitle: 'Shared pin note',
        noteBody: '',
        pinned: true,
        bgColor: '',
        bgImage: '',
        checkBoxes: [],
        images: [],
        isCbox: false,
        labels: [],
        archived: false,
        trashed: false
      })
    });
    await request(`/notes/${sharedNote.id}/collaborators`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ userIds: [collabLogin.user.id] })
    });
    await request(`/notes/${sharedNote.id}`, {
      method: 'PATCH',
      headers: collabHeaders,
      body: JSON.stringify({ pinned: true })
    });
    await request(`/notes/${sharedNote.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ pinned: false })
    });
    const collaboratorView = await request(`/notes/${sharedNote.id}`, { headers: collabHeaders });
    const ownerView = await request(`/notes/${sharedNote.id}`, { headers });
    assert.strictEqual(ownerView.pinned, false, 'owner unpin should update only the owner pin state');
    assert.strictEqual(collaboratorView.pinned, true, 'collaborator pin should survive owner unpin');

    const ownerUnpinnedSharedNote = await request('/notes', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        syncId: 'shared-pin-note-owner-unpinned',
        noteTitle: 'Owner unpinned shared pin note',
        noteBody: '',
        pinned: false,
        bgColor: '',
        bgImage: '',
        checkBoxes: [],
        images: [],
        isCbox: false,
        labels: [],
        archived: false,
        trashed: false
      })
    });
    await request(`/notes/${ownerUnpinnedSharedNote.id}/collaborators`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ userIds: [collabLogin.user.id] })
    });
    await request(`/notes/${ownerUnpinnedSharedNote.id}`, {
      method: 'PATCH',
      headers: collabHeaders,
      body: JSON.stringify({ pinned: true })
    });
    const collaboratorPinnedView = await request(`/notes/${ownerUnpinnedSharedNote.id}`, { headers: collabHeaders });
    const ownerUnpinnedView = await request(`/notes/${ownerUnpinnedSharedNote.id}`, { headers });
    assert.strictEqual(ownerUnpinnedView.pinned, false, 'collaborator pin should not pin the note for the owner');
    assert.strictEqual(collaboratorPinnedView.pinned, true, 'collaborator should be able to pin an owner-unpinned shared note');

    const deleted = await request('/sync/mutations', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        mutations: [{
          type: 'note.delete',
          syncId: 'lww-note',
          payload: { syncId: 'lww-note' },
          lww: { physicalMs: newer + 1000, logical: 0, deviceId: 'b', operationId: 'delete' }
        }]
      })
    });
    assert(!deleted.snapshot.notes.some(item => item.syncId === 'lww-note'), 'deleted note should be absent from snapshot');
    const changes = await request(`/sync/changes?cursor=${Math.max(0, deleted.snapshot.cursor - 1)}`, { headers });
    assert(changes.changes.some(change => change.resourceSyncId === 'lww-note' && change.operation === 'delete'), 'change stream should include delete tombstone');

    console.log('Sync smoke tests passed.');
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
