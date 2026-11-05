// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { stopScreencast } from '../e2e/helpers/stop-screencast.ts';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const turn = () => new Promise(resolve => setImmediate(resolve));

test('screencast cleanup stops, removes the exact listener, then drains every accepted ACK before detach', async () => {
  const emitter = new EventEmitter(), stop = deferred(), acks = new Map(), received = [], errors = [], events = [];
  const acknowledgements = [];
  let detached = false, pendingAtDetach = null;
  const onFrame = id => {
    received.push(id);
    const ack = deferred(); acks.set(id, ack);
    acknowledgements.push(ack.promise.then(() => { events.push(`ack:${id}`); acks.delete(id); }));
  };
  emitter.on('frame', onFrame);
  emitter.emit('frame', 1);
  const completion = stopScreencast({
    stop: () => { events.push('stop'); return stop.promise; },
    removeFrameListener: () => { events.push('off'); emitter.off('frame', onFrame); },
    acknowledgements,
    detach: async () => { events.push('detach'); pendingAtDetach = [...acks.keys()]; detached = true; },
    recordError: (stage, error) => errors.push({ stage, error }),
  });
  // Native frames delivered while stop is pending are still valid and need an ACK.
  emitter.emit('frame', 2);
  stop.resolve(); await turn();
  const listenersWhileDraining = emitter.listenerCount('frame');
  const detachedBeforeAck = detached;
  // An event already queued at the transport may arrive while ACKs are draining.
  emitter.emit('frame', 3);
  acks.get(1).resolve(); acks.get(2).resolve();
  await completion;
  // Resolve a wrongly admitted late ACK too, so the RED run leaves no hanging work.
  acks.get(3)?.resolve(); await turn();
  assert.equal(listenersWhileDraining, 0, 'listener must be removed before the ACK snapshot');
  assert.equal(detachedBeforeAck, false);
  assert.deepEqual(received, [1, 2], 'queued frames after listener removal cannot start a late ACK');
  assert.deepEqual(pendingAtDetach, [], 'detach cannot reject an outstanding accepted ACK');
  assert.deepEqual(events, ['stop', 'off', 'ack:1', 'ack:2', 'detach']);
  assert.deepEqual(errors, []);
});

test('screencast cleanup records stop, ACK and detach errors and still releases the listener', async () => {
  const ack = deferred(), errors = [], events = [];
  const stopError = new Error('stop failed'), ackError = new Error('ACK failed'), detachError = new Error('detach failed');
  const completion = stopScreencast({
    stop: async () => { events.push('stop'); throw stopError; },
    removeFrameListener: () => { events.push('off'); },
    acknowledgements: [ack.promise],
    detach: async () => { events.push('detach'); throw detachError; },
    recordError: (stage, error) => errors.push({ stage, error }),
  });
  await turn(); ack.reject(ackError); await completion;
  assert.deepEqual(events, ['stop', 'off', 'detach']);
  assert.deepEqual(errors, [
    { stage: 'stop', error: stopError },
    { stage: 'acknowledgement', error: ackError },
    { stage: 'detach', error: detachError },
  ]);
});

test('screencast setup failure can clean up a session whose stream never started', async () => {
  const events = [], errors = [];
  await stopScreencast({
    removeFrameListener: () => events.push('off'), acknowledgements: [],
    detach: async () => { events.push('detach'); },
    recordError: (stage, error) => errors.push({ stage, error }),
  });
  assert.deepEqual(events, ['off', 'detach']); assert.deepEqual(errors, []);
});
