import { describe, expect, it, vi } from 'vitest';
import { CapeTextureLoader, SkinTextureLoader } from './skinTexture';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function target() { return { disposed: false, loadSkin: vi.fn() }; }
const image = (id: string) => ({ id }) as HTMLImageElement;

describe('SkinTextureLoader lifecycle', () => {
  it('keeps the newest skin when an older image finishes last', async () => {
    const first = deferred<HTMLImageElement>();
    const second = deferred<HTMLImageElement>();
    const viewer = target();
    const decode = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const loader = new SkinTextureLoader(viewer, decode);
    const oldLoad = loader.load('old.png', 'classic');
    const latestLoad = loader.load('new.png', 'slim');
    const latest = image('new');
    second.resolve(latest);
    expect(await latestLoad).toBe(true);
    first.resolve(image('old'));
    expect(await oldLoad).toBe(false);
    expect(viewer.loadSkin).toHaveBeenCalledExactlyOnceWith(latest, { model: 'slim' });
    expect(decode.mock.calls[0][1].aborted).toBe(true);
  });

  it('does not touch WebGL after unmount, even when decoding ignores cancellation', async () => {
    const pending = deferred<HTMLImageElement>();
    const viewer = target();
    const loader = new SkinTextureLoader(viewer, () => pending.promise);
    const result = loader.load('skin.png', 'auto');
    loader.dispose();
    pending.resolve(image('late'));
    expect(await result).toBe(false);
    expect(viewer.loadSkin).not.toHaveBeenCalled();
    expect(await loader.load('after-unmount.png', 'auto')).toBe(false);
  });

  it('checks the viewer disposal state again after asynchronous decoding', async () => {
    const pending = deferred<HTMLImageElement>();
    const viewer = target();
    const loader = new SkinTextureLoader(viewer, () => pending.promise);
    const result = loader.load('skin.png', 'classic');
    viewer.disposed = true;
    pending.resolve(image('late'));
    expect(await result).toBe(false);
    expect(viewer.loadSkin).not.toHaveBeenCalled();
  });

  it('reports a current decode failure and preserves the previously loaded skin', async () => {
    const viewer = target();
    const loader = new SkinTextureLoader(viewer, () => Promise.reject(new Error('bad PNG')));
    await expect(loader.load('broken.png', 'auto')).rejects.toThrow('bad PNG');
    expect(viewer.loadSkin).not.toHaveBeenCalled();
  });

  it('suppresses errors from superseded requests', async () => {
    const first = deferred<HTMLImageElement>();
    const viewer = target();
    const decode = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(image('new'));
    const loader = new SkinTextureLoader(viewer, decode);
    const oldLoad = loader.load('old.png', 'auto');
    expect(await loader.load('new.png', 'classic')).toBe(true);
    first.reject(new Error('stale network failure'));
    expect(await oldLoad).toBe(false);
    expect(viewer.loadSkin).toHaveBeenCalledTimes(1);
  });

  it.each([['classic', 'default'], ['slim', 'slim'], ['auto', 'auto-detect']] as const)(
    'maps the %s model to the skinview3d %s model', async (model, expected) => {
      const viewer = target();
      const decoded = image(model);
      const loader = new SkinTextureLoader(viewer, () => Promise.resolve(decoded));
      expect(await loader.load('skin.png', model)).toBe(true);
      expect(viewer.loadSkin).toHaveBeenCalledExactlyOnceWith(decoded, { model: expected });
    },
  );
});

describe('CapeTextureLoader lifecycle', () => {
  it('keeps the latest cape and equipment when earlier downloads finish late', async () => {
    const first = deferred<HTMLImageElement>(); const second = deferred<HTMLImageElement>();
    const viewer = { disposed: false, loadCape: vi.fn() };
    const loader = new CapeTextureLoader(viewer, vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise));
    const old = loader.load('old-cape.png', 'cape'); const latest = loader.load('new-cape.png', 'elytra');
    const cape = image('new-cape'); second.resolve(cape); expect(await latest).toBe(true);
    first.resolve(image('old-cape')); expect(await old).toBe(false);
    expect(viewer.loadCape).toHaveBeenCalledExactlyOnceWith(cape, { backEquipment: 'elytra' });
  });

  it('hides a cape immediately and rejects an outstanding download after clearing', async () => {
    const pending = deferred<HTMLImageElement>(); const viewer = { disposed: false, loadCape: vi.fn() };
    const loader = new CapeTextureLoader(viewer, () => pending.promise);
    const old = loader.load('cape.png', 'cape'); expect(await loader.load(null, 'cape')).toBe(true);
    pending.resolve(image('late')); expect(await old).toBe(false);
    expect(viewer.loadCape).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('does not create cape textures after viewer cleanup', async () => {
    const pending = deferred<HTMLImageElement>(); const viewer = { disposed: false, loadCape: vi.fn() };
    const loader = new CapeTextureLoader(viewer, () => pending.promise);
    const loading = loader.load('cape.png', 'cape'); loader.dispose(); pending.resolve(image('late'));
    expect(await loading).toBe(false); expect(viewer.loadCape).not.toHaveBeenCalled();
  });
});
