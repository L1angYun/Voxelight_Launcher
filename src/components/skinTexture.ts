export type SkinModel = 'auto' | 'classic' | 'slim';

/** Decode before touching the viewer: a superseded request must never replace a newer skin. */
export function loadSkinImage(url: string, signal: AbortSignal, kind: 'skin' | 'cape' = 'skin'): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    let timeout: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timeout);
      image.onload = null;
      image.onerror = null;
      signal.removeEventListener('abort', abort);
    };
    const fail = (error: Error) => { cleanup(); reject(error); };
    const abort = () => {
      fail(new DOMException('皮肤加载已取消', 'AbortError'));
      image.src = '';
    };
    if (signal.aborted) { abort(); return; }
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      const { naturalWidth: width, naturalHeight: height } = image;
      const validSkin = width >= 64 && width <= 4096 && width % 64 === 0 && (height === width || height * 2 === width);
      const validCape = width > 0 && width <= 4096 && height > 0 && height <= 4096 &&
        ((width === height * 2 && width % 64 === 0) || (width * 17 === height * 22 && width % 22 === 0) || (width * 23 === height * 46 && width % 46 === 0));
      if (kind === 'skin' ? !validSkin : !validCape) {
        fail(new Error(kind === 'skin' ? `皮肤尺寸 ${width} × ${height} 无效，请选择 64 × 64、64 × 32 或其整数倍的 PNG。` : `披风尺寸 ${width} × ${height} 无效。`));
        return;
      }
      cleanup();
      resolve(image);
    };
    image.onerror = () => fail(new Error(`无法读取${kind === 'cape' ? '披风' : '皮肤'}，请检查 PNG 文件、网址和跨域访问权限。`));
    signal.addEventListener('abort', abort, { once: true });
    timeout = setTimeout(() => { fail(new Error('皮肤加载超时，请检查网络后重试。')); image.src = ''; }, 15_000);
    image.src = url;
  });
}

interface SkinTarget {
  readonly disposed: boolean;
  loadSkin(image: HTMLImageElement, options: { model: 'default' | 'slim' | 'auto-detect' }): void;
}

export class SkinTextureLoader {
  private generation = 0;
  private request: AbortController | null = null;
  private disposed = false;

  constructor(
    private readonly target: SkinTarget,
    private readonly decode = loadSkinImage,
  ) {}

  async load(source: string, model: SkinModel): Promise<boolean> {
    this.request?.abort();
    if (this.disposed || this.target.disposed) return false;
    const generation = ++this.generation;
    const request = new AbortController();
    this.request = request;
    try {
      const image = await this.decode(source, request.signal);
      if (this.disposed || this.target.disposed || request.signal.aborted || generation !== this.generation) return false;
      this.target.loadSkin(image, { model: model === 'classic' ? 'default' : model === 'slim' ? 'slim' : 'auto-detect' });
      return true;
    } catch (error) {
      if (this.disposed || request.signal.aborted || generation !== this.generation) return false;
      throw error;
    }
  }

  dispose(): void {
    this.disposed = true;
    ++this.generation;
    this.request?.abort();
    this.request = null;
  }
}

interface CapeTarget {
  readonly disposed: boolean;
  loadCape(image: HTMLImageElement, options: { backEquipment: 'cape' | 'elytra' }): void;
  loadCape(empty: null): void;
}

export class CapeTextureLoader {
  private generation = 0;
  private request: AbortController | null = null;
  private disposed = false;
  constructor(private readonly target: CapeTarget,
    private readonly decode = (url: string, signal: AbortSignal) => loadSkinImage(url, signal, 'cape')) {}

  async load(source: string | null, backEquipment: 'cape' | 'elytra'): Promise<boolean> {
    this.request?.abort();
    const generation = ++this.generation;
    if (this.disposed || this.target.disposed) return false;
    if (!source) { this.target.loadCape(null); return true; }
    const request = new AbortController(); this.request = request;
    try {
      const image = await this.decode(source, request.signal);
      if (this.disposed || this.target.disposed || request.signal.aborted || generation !== this.generation) return false;
      this.target.loadCape(image, { backEquipment });
      return true;
    } catch (error) {
      if (this.disposed || request.signal.aborted || generation !== this.generation) return false;
      throw error;
    }
  }

  dispose(): void { this.disposed = true; ++this.generation; this.request?.abort(); this.request = null; }
}
